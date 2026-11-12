import { buildCandidate, decidePublication } from "./core.js";

const STATE_KEY = "published-state-v1";
const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function parseRenameRules(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getSourceUrl(env) {
  if (!env.SOURCE_URL) throw new Error("SOURCE_URL is not configured");
  const url = new URL(env.SOURCE_URL);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("SOURCE_URL must use HTTP or HTTPS");
  if (url.protocol === "http:" && env.ALLOW_HTTP_SOURCE !== "true") {
    throw new Error("HTTP source is disabled; set ALLOW_HTTP_SOURCE=true only when explicitly required");
  }
  return url.toString();
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Source response is too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Source response is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchSource(env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.SOURCE_TIMEOUT_MS ?? 15000));
  try {
    const response = await fetch(getSourceUrl(env), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/plain, text/yaml, application/json;q=0.9, */*;q=0.1" }
    });
    return await readResponseWithLimit(response, Number(env.MAX_SOURCE_BYTES ?? DEFAULT_MAX_SOURCE_BYTES));
  } finally {
    clearTimeout(timeout);
  }
}

async function loadState(env) {
  if (!env.SUBSCRIPTION_STATE?.get) return null;
  const raw = await env.SUBSCRIPTION_STATE.get(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveState(env, state) {
  if (!env.SUBSCRIPTION_STATE?.put) throw new Error("SUBSCRIPTION_STATE KV binding is not configured");
  await env.SUBSCRIPTION_STATE.put(STATE_KEY, JSON.stringify(state));
}

async function writeAudit(env, result, now) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return;
  try {
    await env.SUBSCRIPTION_AUDIT
      .prepare("INSERT INTO refresh_audit (created_at, action, reason, valid_count, content_hash) VALUES (?, ?, ?, ?, ?)")
      .bind(
        now.toISOString(),
        result.action ?? "unknown",
        result.reason ?? "unknown",
        Number(result.validCount ?? 0),
        result.contentHash ?? null
      )
      .run();
  } catch {
    // Audit storage is best-effort. It must never replace a valid published state.
    console.log(JSON.stringify({ event: "audit-write-failed" }));
  }
}

export async function refresh(env, now = new Date()) {
  const finish = async (result) => {
    await writeAudit(env, result, now);
    return result;
  };
  if (!env.SOURCE_URL) return finish({ action: "keep", reason: "source-not-configured" });
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return finish({ action: "keep", reason: "state-store-not-configured" });
  }
  const previous = await loadState(env);
  let rawText;
  try {
    rawText = await fetchSource(env);
  } catch (error) {
    return finish({ action: "keep", reason: "source-error", error: error instanceof Error ? error.message : "unknown" });
  }

  let candidate;
  try {
    candidate = await buildCandidate(rawText, {
      renameRules: parseRenameRules(env.RENAME_RULES_JSON),
      minValidNodes: env.MIN_VALID_NODES ?? 1
    });
  } catch (error) {
    return finish({ action: "keep", reason: "parse-error", error: error instanceof Error ? error.message : "unknown" });
  }

  const decision = decidePublication(candidate, previous);
  if (decision.action === "keep") return finish(decision);
  await saveState(env, {
    version: 1,
    contentHash: decision.contentHash,
    validCount: decision.validCount,
    updatedAt: now.toISOString(),
    output: decision.output
  });
  return finish(decision);
}

async function servePublished(env) {
  const state = await loadState(env);
  if (!state?.output) return new Response("No valid subscription has been published yet", { status: 503 });
  return new Response(state.output, {
    status: 200,
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ ok: true, configured: Boolean(env.SOURCE_URL && env.SUBSCRIPTION_STATE) });
    }
    if (request.method === "GET" && env.PUBLIC_PATH_TOKEN && url.pathname === `/sub/${env.PUBLIC_PATH_TOKEN}`) {
      return servePublished(env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    const result = await refresh(env);
    console.log(JSON.stringify({
      event: "subscription-refresh",
      action: result.action,
      reason: result.reason,
      validCount: result.validCount ?? 0
    }));
  }
};

