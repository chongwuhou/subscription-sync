import { buildCandidate, buildPreview, decidePublication } from "./core.js";
import {
  parseSubscriptionProfiles,
  parseSubscriptionProfilesJson,
  stateKey,
  validateSubscriptionProfiles
} from "./config.js";
import { detectTarget, renderSubscription, supportedTargets } from "./formats.js";

const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const ADMIN_CONFIG_KEY = "subscription-config-v1";
const ADMIN_SETTINGS_KEY = "subscription-settings-v1";
const LAST_REFRESH_KEY = "subscription-refresh-meta-v1";
const DEFAULT_REFRESH_INTERVAL_MINUTES = 30;

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Subscription Sync 管理</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 980px; margin: 2rem auto; padding: 0 1rem; }
    fieldset { margin: 1rem 0; border: 1px solid #8885; border-radius: 8px; }
    label { display: block; margin: .65rem 0; font-weight: 600; }
    input, textarea { display: block; box-sizing: border-box; width: 100%; margin-top: .3rem; padding: .55rem; font: inherit; }
    textarea { min-height: 5rem; font-family: ui-monospace, monospace; }
    button { margin: .35rem .5rem .35rem 0; padding: .55rem .8rem; font: inherit; cursor: pointer; }
    #status { min-height: 1.5rem; white-space: pre-wrap; }
    .muted { opacity: .75; }
    .notice { padding: .7rem .9rem; border-radius: 6px; background: #16803c18; border: 1px solid #16803c55; }
    .rules-help { margin: .4rem 0 1rem; padding: .6rem .8rem; border: 1px solid #8885; border-radius: 6px; }
    .rules-help summary { cursor: pointer; font-weight: 600; }
    .rules-help pre { overflow-x: auto; white-space: pre-wrap; font-size: .9rem; }
    .rules-help code { font-family: ui-monospace, monospace; }
    .preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; margin: .8rem 0; }
    .preview-pane { border: 1px solid #8885; border-radius: 6px; padding: .6rem; min-width: 0; }
    .preview-pane h3 { margin: 0 0 .4rem; font-size: 1rem; }
    .preview-pane ul { margin: 0; padding-left: 1.2rem; max-height: 16rem; overflow: auto; }
    @media (max-width: 720px) { .preview-grid { grid-template-columns: 1fr; } }
    .actions-bottom { position: sticky; bottom: 0; margin: 1rem 0 3rem; padding: .7rem; background: Canvas; border: 1px solid #8885; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Subscription Sync 管理</h1>
  <p class="muted">管理源头订阅地址、节点改名规则、最低有效节点数和客户端输出格式。配置只保存到受保护的 Cloudflare KV，不保存在浏览器。</p>
  <p><button id="login">输入管理员令牌</button> <button id="reload" disabled>重新读取</button> <button id="save" disabled>保存订阅配置</button> <button id="refresh" disabled>立即刷新</button> <button id="add" disabled>新增订阅</button></p>
  <label>自动刷新间隔（分钟，5-1440，按 5 分钟粒度）<input id="interval" type="number" min="5" max="1440" step="5" value="30" disabled></label>
  <p class="notice">保存后，订阅地址、改名规则和刷新间隔会写入 Cloudflare KV；以后重新打开或点击“重新读取”仍会保留。只有管理员令牌可以读取源地址。</p>
  <div id="status"></div>
  <div id="profiles"></div>
  <div class="actions-bottom"><button id="save-bottom" disabled>保存订阅配置</button><span class="muted"> 保存后会保留在 Cloudflare KV</span></div>
  <script>
    const state = { token: "", profiles: [], refreshIntervalMinutes: 30 };
    const status = document.getElementById("status");
    const root = document.getElementById("profiles");
    const interval = document.getElementById("interval");
    const buttons = ["reload", "save", "save-bottom", "refresh", "add"].map((id) => document.getElementById(id));
    const setStatus = (text) => { status.textContent = text || ""; };
    const setEnabled = (enabled) => buttons.forEach((button) => { button.disabled = !enabled; });
    async function api(path, options) {
      const headers = Object.assign({}, options && options.headers, { Authorization: "Bearer " + state.token });
      const response = await fetch(path, Object.assign({}, options, { headers }));
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!response.ok) throw new Error(data && data.error ? data.error : "请求失败 " + response.status);
      return data;
    }
    function addField(parent, key, label, value, type, placeholder) {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
      if (type && type !== "textarea") input.type = type;
      input.dataset.field = key;
      input.value = value == null ? "" : String(value);
      if (placeholder) input.placeholder = placeholder;
      wrapper.appendChild(input);
      parent.appendChild(wrapper);
      return input;
    }
    function publicLinkFor(token) {
      return token ? location.origin + "/sub/" + encodeURIComponent(token) : "";
    }
    function publicTokenFromLink(value, index) {
      const text = value.trim();
      if (!text) return "";
      if (/^[A-Za-z0-9_-]{1,128}$/.test(text)) return text;
      let parsed;
      try { parsed = new URL(text, location.origin); } catch { throw new Error("订阅 " + (index + 1) + " 的输出地址不是合法 URL"); }
      if (parsed.origin !== location.origin || parsed.search || parsed.hash || !parsed.pathname.startsWith("/sub/")) {
        throw new Error("订阅 " + (index + 1) + " 的输出地址只能修改 /sub/ 后面的路径，域名不能改");
      }
      const token = decodeURIComponent(parsed.pathname.slice("/sub/".length));
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error("订阅 " + (index + 1) + " 的输出地址路径只能使用字母、数字、下划线和短横线");
      return token;
    }
    function renderPreviewPane(parent, title, nodes) {
      const pane = document.createElement("section");
      pane.className = "preview-pane";
      const heading = document.createElement("h3");
      heading.textContent = title + "（" + nodes.length + " 个节点）";
      pane.appendChild(heading);
      const list = document.createElement("ul");
      nodes.forEach((node) => {
        const item = document.createElement("li");
        item.textContent = node.name + " · " + node.type + " · " + node.server + ":" + node.port;
        list.appendChild(item);
      });
      pane.appendChild(list);
      parent.appendChild(pane);
    }
    function render() {
      root.replaceChildren();
      if (state.profiles.length === 0) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "当前没有保存的订阅。请先点击“新增订阅”，填写 ID、名称和完整源头订阅地址，再点击“保存订阅配置”。";
        root.appendChild(empty);
        return;
      }
      state.profiles.forEach((profile, index) => {
        const card = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = "订阅 " + (index + 1);
        card.appendChild(legend);
        addField(card, "id", "ID", profile.id, "text", "例如：main 或 backup");
        addField(card, "name", "名称", profile.name, "text", "例如：主订阅");
        addField(card, "sourceUrl", "完整源头订阅地址（把 ?token=... 一起粘贴，仅管理员可见）", profile.sourceUrl, "url", "https://供应商.example/subscribe?token=...");
        const publicLinkInput = addField(card, "publicLink", "修改后的通用订阅地址（可修改 /sub/ 后面的路径）", publicLinkFor(profile.publicToken), "url", location.origin + "/sub/保存后自动生成");
        const copyLink = document.createElement("button");
        copyLink.type = "button";
        copyLink.textContent = "复制地址";
        copyLink.onclick = async () => {
          const text = publicLinkInput.value.trim();
          if (!text) { setStatus("请先保存订阅，系统会生成通用订阅地址"); return; }
          try {
            await navigator.clipboard.writeText(text);
            setStatus("已复制通用订阅地址");
          } catch {
            publicLinkInput.focus();
            publicLinkInput.select();
            setStatus("浏览器禁止自动复制，请按 Ctrl+C 复制已选中的地址");
          }
        };
        card.appendChild(copyLink);
        addField(card, "minValidNodes", "最低有效节点数", profile.minValidNodes || 1, "number");
        addField(card, "defaultTarget", "无法识别客户端时的格式（clash/base64/sing-box/links）", profile.defaultTarget || "clash", "text", "clash");
        addField(card, "renameRules", "改名规则 JSON", JSON.stringify(profile.renameRules || [], null, 2), "textarea", '[{"pattern":"\\\\s*\\\\|\\\\s*","replacement":"-"}]');
        const help = document.createElement("details");
        help.className = "rules-help";
        const helpText = [
          "1. 把 US | New York 变成 US-New York",
          '[{"pattern":"\\\\s*\\\\|\\\\s*","replacement":"-"}]',
          "",
          "2. 把地区名称统一改名",
          '[{"pattern":"香港","replacement":"HK"},{"pattern":"新加坡","replacement":"SG"}]',
          "",
          "3. 删除名称开头的机场标签",
          '[{"pattern":"^\\\\s*机场[-_ ]*","replacement":""}]'
        ].join("\\n");
        help.innerHTML = '<summary>改名/替换规则案例（复制到上面的 JSON 框）</summary>' +
          '<p class="muted">pattern 是 JavaScript 正则表达式；replacement 是替换后的文字；多个规则会按顺序执行。</p>' +
          '<pre><code>' + helpText + '</code></pre>';
        card.appendChild(help);
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.textContent = "预览原版 / 规则修改后";
        const previewGrid = document.createElement("div");
        previewGrid.className = "preview-grid";
        previewButton.onclick = async () => {
          previewButton.disabled = true;
          previewGrid.replaceChildren();
          try {
            const data = await api("/api/admin/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: profile.id }) });
            renderPreviewPane(previewGrid, "原版", data.original || []);
            renderPreviewPane(previewGrid, "规则修改后", data.modified || []);
            setStatus("已加载原版与规则修改后的节点预览；预览不显示 UUID、密码等凭据");
          } catch (error) { setStatus(error.message); }
          finally { previewButton.disabled = false; }
        };
        card.appendChild(previewButton);
        card.appendChild(previewGrid);
        const saveOne = document.createElement("button");
        saveOne.type = "button";
        saveOne.textContent = "保存本订阅";
        saveOne.onclick = () => saveAll(index + 1);
        card.appendChild(saveOne);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "删除此订阅";
        remove.onclick = () => { state.profiles.splice(index, 1); render(); };
        card.appendChild(remove);
        root.appendChild(card);
      });
    }
    function collect() {
      return Array.from(root.querySelectorAll("fieldset")).map((card, index) => {
        const value = (key) => card.querySelector("[data-field='" + key + "']").value;
        const id = value("id").trim();
        const name = value("name").trim();
        const sourceUrl = value("sourceUrl").trim();
        const publicToken = publicTokenFromLink(value("publicLink"), index);
        if (!id || !name || !sourceUrl) {
          throw new Error("订阅 " + (index + 1) + " 还没有填写完整：ID、名称和完整源头订阅地址都必填");
        }
        if (!/^https?:\\/\\//i.test(sourceUrl)) {
          throw new Error("订阅 " + (index + 1) + " 的源头订阅地址必须以 https:// 或 http:// 开头");
        }
        let renameRules;
        try { renameRules = JSON.parse(value("renameRules")); } catch { throw new Error("改名规则必须是合法 JSON"); }
        if (!Array.isArray(renameRules)) throw new Error("订阅 " + (index + 1) + " 的改名规则必须是数组，例如 []");
        return {
          id,
          name,
          sourceUrl,
          publicToken,
          minValidNodes: Number(value("minValidNodes")),
          defaultTarget: value("defaultTarget").trim(),
          renameRules
        };
      });
    }
    async function load() {
      try {
        const data = await api("/api/admin/subscriptions");
        state.profiles = data.subscriptions || [];
        state.refreshIntervalMinutes = data.refreshIntervalMinutes || 30;
        interval.value = state.refreshIntervalMinutes;
        interval.disabled = false;
        setEnabled(true);
        render();
        setStatus("已读取 " + state.profiles.length + " 个订阅（" + (data.managed ? "Cloudflare KV 已保存配置" : "当前没有 KV 保存项，使用环境变量回退") + "）");
      } catch (error) { setStatus(error.message); }
    }
    document.getElementById("login").onclick = async () => {
      const value = prompt("请输入 ADMIN_TOKEN（不会保存到浏览器）");
      if (!value) return;
      state.token = value;
      await load();
    };
    document.getElementById("reload").onclick = load;
    document.getElementById("add").onclick = () => {
      state.profiles.push({ id: "", name: "", sourceUrl: "", publicToken: "", minValidNodes: 1, defaultTarget: "clash", renameRules: [] });
      render();
    };
    async function saveAll(focusIndex = null) {
      try {
        const subscriptions = collect();
        if (subscriptions.length === 0) throw new Error("当前没有订阅配置，请先点击“新增订阅”并填写完整后再保存");
        await api("/api/admin/subscriptions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptions }) });
        await api("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshIntervalMinutes: Number(interval.value) }) });
        const scope = focusIndex ? "第 " + focusIndex + " 个订阅" : subscriptions.length + " 个订阅";
        await load();
        setStatus("已保存" + scope + "及刷新间隔到 Cloudflare KV。刷新页面后仍会保留；下一次 Cron 刷新或点击“立即刷新”后生效。");
      } catch (error) { setStatus(error.message); }
    }
    document.getElementById("save").onclick = () => saveAll();
    document.getElementById("save-bottom").onclick = () => saveAll();
    document.getElementById("refresh").onclick = async () => {
      try { const data = await api("/api/admin/refresh", { method: "POST" }); setStatus(JSON.stringify(data.results, null, 2)); }
      catch (error) { setStatus(error.message); }
    };
  </script>
</body>
</html>`;

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

function getSourceUrl(env, profile) {
  const url = new URL(profile.sourceUrl);
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

async function fetchSource(env, profile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.SOURCE_TIMEOUT_MS ?? 15000));
  try {
    const response = await fetch(getSourceUrl(env, profile), {
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

async function loadState(env, profileId) {
  if (!env.SUBSCRIPTION_STATE?.get) return null;
  const raw = await env.SUBSCRIPTION_STATE.get(stateKey(profileId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadProfiles(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_CONFIG_KEY);
    if (stored !== null) return parseSubscriptionProfilesJson(stored);
  }
  return parseSubscriptionProfiles(env);
}

function normalizeRefreshInterval(value, fallback = DEFAULT_REFRESH_INTERVAL_MINUTES) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 5 || number > 1440 || number % 5 !== 0) return fallback;
  return number;
}

function createPublicToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "");
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function loadSettings(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_SETTINGS_KEY);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored);
        return { refreshIntervalMinutes: normalizeRefreshInterval(parsed.refreshIntervalMinutes) };
      } catch {
        // Fall through to the private environment variable if the setting is corrupt.
      }
    }
  }
  return { refreshIntervalMinutes: normalizeRefreshInterval(env.REFRESH_INTERVAL_MINUTES) };
}

async function scheduledRefreshDue(env, now) {
  const settings = await loadSettings(env);
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) return { due: true, settings };
  const raw = await env.SUBSCRIPTION_STATE.get(LAST_REFRESH_KEY);
  if (raw) {
    try {
      const previous = JSON.parse(raw);
      const lastRun = Date.parse(previous.lastRunAt);
      if (Number.isFinite(lastRun) && now.getTime() - lastRun < settings.refreshIntervalMinutes * 60 * 1000) {
        return { due: false, settings };
      }
    } catch {
      // A malformed marker is treated as due and replaced below.
    }
  }
  await env.SUBSCRIPTION_STATE.put(LAST_REFRESH_KEY, JSON.stringify({ lastRunAt: now.toISOString() }));
  return { due: true, settings };
}

async function storedProfiles(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_CONFIG_KEY);
    if (stored !== null) return { managed: true, profiles: parseSubscriptionProfilesJson(stored) };
  }
  return { managed: false, profiles: parseSubscriptionProfiles(env) };
}

function isAdminAuthorized(request, env) {
  const token = String(env.ADMIN_TOKEN ?? "").trim();
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

async function readJsonBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 256 * 1024) throw new Error("Request body is too large");
  return JSON.parse(text);
}

function previewNode(node) {
  return {
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    network: node.network,
    tls: Boolean(node.tls)
  };
}

function summarizeRefreshResult(result) {
  const { nodes: _nodes, output: _output, ...summary } = result;
  return summary;
}

async function handleAdminApi(request, env, url) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: env.ADMIN_TOKEN ? "unauthorized" : "admin-disabled" }, env.ADMIN_TOKEN ? 401 : 503);
  }
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return json({ error: "state-store-not-configured" }, 503);
  }
  if (url.pathname === "/api/admin/subscriptions" && request.method === "GET") {
    const current = await storedProfiles(env);
    const settings = await loadSettings(env);
    return json({ managed: current.managed, subscriptions: current.profiles, refreshIntervalMinutes: settings.refreshIntervalMinutes });
  }
  if (url.pathname === "/api/admin/subscriptions" && request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const rawSubscriptions = body?.subscriptions ?? body;
      if (!Array.isArray(rawSubscriptions)) return json({ error: "subscriptions must be an array" }, 400);
      const current = await storedProfiles(env);
      const existingTokens = new Map(current.profiles.map((profile) => [profile.id, profile.publicToken]));
      const prepared = rawSubscriptions.map((item) => {
        const profile = item && typeof item === "object" ? item : {};
        const id = String(profile.id ?? "").trim();
        return {
          ...profile,
          publicToken: String(profile.publicToken ?? existingTokens.get(id) ?? "").trim() || createPublicToken()
        };
      });
      const checked = validateSubscriptionProfiles(prepared);
      if (checked.error) return json({ error: checked.error }, 400);
      await env.SUBSCRIPTION_STATE.put(ADMIN_CONFIG_KEY, JSON.stringify(checked.profiles));
      return json({ ok: true, count: checked.profiles.length });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid-json" }, 400);
    }
  }
  if (url.pathname === "/api/admin/settings" && request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const value = Number(body?.refreshIntervalMinutes);
      if (!Number.isInteger(value) || value < 5 || value > 1440 || value % 5 !== 0) {
        return json({ error: "refreshIntervalMinutes must be an integer from 5 to 1440 in 5-minute increments" }, 400);
      }
      await env.SUBSCRIPTION_STATE.put(ADMIN_SETTINGS_KEY, JSON.stringify({ refreshIntervalMinutes: value }));
      return json({ ok: true, refreshIntervalMinutes: value });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid-json" }, 400);
    }
  }
  if (url.pathname === "/api/admin/preview" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const id = String(body?.id ?? "").trim();
      const profile = (await loadProfiles(env)).find((item) => item.id === id);
      if (!profile) return json({ error: "subscription-not-found" }, 404);
      const rawText = await fetchSource(env, profile);
      const preview = buildPreview(rawText, { renameRules: profile.renameRules });
      return json({
        subscriptionId: profile.id,
        original: preview.original.map(previewNode),
        modified: preview.modified.map(previewNode)
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "preview-failed" }, 400);
    }
  }
  if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
    return json({ results: (await refreshAll(env)).map(summarizeRefreshResult) });
  }
  if (url.pathname === "/api/admin/subscriptions/reset" && request.method === "POST") {
    if (!env.SUBSCRIPTION_STATE.delete) return json({ error: "state-store-does-not-support-delete" }, 503);
    await env.SUBSCRIPTION_STATE.delete(ADMIN_CONFIG_KEY);
    return json({ ok: true, managed: false });
  }
  return json({ error: "not-found" }, 404);
}

async function saveState(env, profileId, state) {
  if (!env.SUBSCRIPTION_STATE?.put) throw new Error("SUBSCRIPTION_STATE KV binding is not configured");
  await env.SUBSCRIPTION_STATE.put(stateKey(profileId), JSON.stringify(state));
}

async function writeAudit(env, profileId, result, now) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return;
  try {
    await env.SUBSCRIPTION_AUDIT
      .prepare("INSERT INTO refresh_audit (subscription_id, created_at, action, reason, valid_count, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        profileId,
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

async function refreshProfile(env, profile, now) {
  const finish = async (result) => {
    await writeAudit(env, profile.id, result, now);
    return result;
  };
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return finish({ action: "keep", reason: "state-store-not-configured" });
  }
  const previous = await loadState(env, profile.id);
  let rawText;
  try {
    rawText = await fetchSource(env, profile);
  } catch (error) {
    return finish({ action: "keep", reason: "source-error", error: error instanceof Error ? error.message : "unknown" });
  }

  let candidate;
  try {
    candidate = await buildCandidate(rawText, {
      renameRules: profile.renameRules,
      minValidNodes: profile.minValidNodes
    });
  } catch (error) {
    return finish({ action: "keep", reason: "parse-error", error: error instanceof Error ? error.message : "unknown" });
  }

  const decision = decidePublication(candidate, previous);
  if (decision.action === "keep") return finish(decision);
  await saveState(env, profile.id, {
    version: 1,
    subscriptionId: profile.id,
    contentHash: decision.contentHash,
    validCount: decision.validCount,
    updatedAt: now.toISOString(),
    nodes: decision.nodes,
    output: decision.output
  });
  return finish(decision);
}

export async function refreshAll(env, now = new Date()) {
  const profiles = await loadProfiles(env);
  if (profiles.length === 0) return [{ action: "keep", reason: "no-subscriptions-configured" }];
  const results = [];
  // Process sequentially to avoid a burst against upstream subscription providers.
  for (const profile of profiles) {
    results.push({
      subscriptionId: profile.id,
      ...(await refreshProfile(env, profile, now))
    });
  }
  return results;
}

export async function refresh(env, now = new Date()) {
  return (await refreshAll(env, now))[0];
}

async function servePublished(env, profile, request) {
  const state = await loadState(env, profile.id);
  if (!state?.output) return new Response("No valid subscription has been published yet", { status: 503 });
  const target = detectTarget(request, profile.defaultTarget);
  if (!target || !supportedTargets.includes(target)) {
    return json({ error: "unsupported-target", supportedTargets }, 406);
  }

  let rendered;
  try {
    // Older KV records contain only Clash YAML. Keep that format available
    // while requiring one successful refresh before serving other targets.
    rendered = state.nodes?.length
      ? renderSubscription(state.nodes, target)
      : target === "clash"
        ? { body: state.output, contentType: "text/yaml; charset=utf-8" }
        : null;
  } catch {
    rendered = null;
  }
  if (!rendered) return new Response("This target is unavailable until the next valid refresh", { status: 503 });
  return new Response(rendered.body, {
    status: 200,
    headers: {
      "content-type": rendered.contentType,
      "cache-control": "no-store",
      "vary": "User-Agent, Accept",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
      });
    }
    if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env, url);
    const profiles = await loadProfiles(env);
    if (url.pathname === "/healthz") {
      return json({ ok: true, configured: profiles.length > 0, profiles: profiles.length });
    }
    if (request.method === "GET" && url.pathname.startsWith("/sub/")) {
      const token = url.pathname.slice("/sub/".length);
      const profile = profiles.find((item) => item.publicToken === token);
      if (profile) return servePublished(env, profile, request);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    const now = new Date();
    const schedule = await scheduledRefreshDue(env, now);
    if (!schedule.due) {
      console.log(JSON.stringify({ event: "subscription-refresh-skipped", reason: "interval-not-due", intervalMinutes: schedule.settings.refreshIntervalMinutes }));
      return;
    }
    const results = await refreshAll(env);
    for (const result of results) {
      console.log(JSON.stringify({
        event: "subscription-refresh",
        subscriptionId: result.subscriptionId ?? null,
        action: result.action,
        reason: result.reason,
        validCount: result.validCount ?? 0
      }));
    }
  }
};

