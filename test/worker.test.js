import test from "node:test";
import assert from "node:assert/strict";
import worker, { refresh, refreshAll } from "../src/worker.js";

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

class MemoryD1 {
  constructor() {
    this.rows = [];
  }

  prepare() {
    return {
      bind: (...values) => ({
        run: async () => {
          this.rows.push(values);
        }
      })
    };
  }
}

const validSource = `
proxies:
  - name: US | One
    type: vmess
    server: one.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
`;

const invalidSource = `
proxies:
  - name: Missing Port
    type: vmess
    server: broken.example.com
    uuid: 22222222-2222-2222-2222-222222222222
`;

test("Worker refresh publishes only changed valid content", async () => {
  const originalFetch = globalThis.fetch;
  const state = new MemoryKV();
  const audit = new MemoryD1();
  const env = {
    SOURCE_URL: "https://source.example.com/subscription",
    PUBLIC_PATH_TOKEN: "test-token",
    SUBSCRIPTION_STATE: state,
    SUBSCRIPTION_AUDIT: audit,
    RENAME_RULES_JSON: JSON.stringify([{ pattern: "\\s*\\|\\s*", replacement: "-" }])
  };
  let source = validSource;
  globalThis.fetch = async () => new Response(source, { status: 200 });
  try {
    const first = await refresh(env, new Date("2026-11-12T00:00:00.000Z"));
    assert.equal(first.action, "initialize");

    const unchanged = await refresh(env, new Date("2026-11-12T00:01:00.000Z"));
    assert.equal(unchanged.action, "keep");
    assert.equal(unchanged.reason, "unchanged");

    source = invalidSource;
    const invalid = await refresh(env, new Date("2026-11-12T00:02:00.000Z"));
    assert.equal(invalid.action, "keep");
    assert.equal(invalid.reason, "no-valid-nodes");

    const published = JSON.parse(await state.get("published-state-v1:default"));
    assert.equal(published.validCount, 1);
    assert.match(published.output, /US-One/);
    assert.equal(audit.rows.length, 3);
    assert.equal(audit.rows[0][0], "default");
    assert.equal(audit.rows[0][1], "2026-11-12T00:00:00.000Z");
    assert.equal(audit.rows[2][2], "keep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multiple subscriptions have isolated state", async () => {
  const originalFetch = globalThis.fetch;
  const state = new MemoryKV();
  const env = {
    SUBSCRIPTIONS_JSON: JSON.stringify([
      {
        id: "main",
        sourceUrl: "https://source.example.com/main",
        publicToken: "main-token",
        renameRules: [{ pattern: "\\s*\\|\\s*", replacement: "-" }]
      },
      {
        id: "backup",
        sourceUrl: "https://source.example.com/backup",
        publicToken: "backup-token"
      }
    ]),
    SUBSCRIPTION_STATE: state
  };
  globalThis.fetch = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    const body = url.endsWith("/main") ? validSource : validSource.replace("one.example.com", "backup.example.com");
    return new Response(body, { status: 200 });
  };
  try {
    const results = await refreshAll(env, new Date("2026-11-12T01:00:00.000Z"));
    assert.deepEqual(results.map((item) => item.action), ["initialize", "initialize"]);
    assert.match(await state.get("published-state-v1:main"), /subscriptionId/);
    assert.match(await state.get("published-state-v1:backup"), /backup.example.com/);

    const mainResponse = await worker.fetch(new Request("https://worker.example.com/sub/main-token"), env);
    const backupResponse = await worker.fetch(new Request("https://worker.example.com/sub/backup-token"), env);
    assert.equal(mainResponse.status, 200);
    assert.equal(backupResponse.status, 200);
    assert.match(await mainResponse.text(), /one.example.com/);
    assert.match(await backupResponse.text(), /backup.example.com/);

    const base64Response = await worker.fetch(new Request("https://worker.example.com/sub/main-token", {
      headers: { "user-agent": "Shadowrocket/2.2" }
    }), env);
    assert.equal(base64Response.status, 200);
    assert.equal(base64Response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(atob((await base64Response.text()).trim()), /vmess:\/\//);

    const singBoxResponse = await worker.fetch(new Request("https://worker.example.com/sub/main-token?target=sing-box"), env);
    assert.equal(singBoxResponse.status, 200);
    assert.equal(JSON.parse(await singBoxResponse.text()).outbounds[0].tag, "PROXY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin API manages subscriptions and refresh interval without public access", async () => {
  const state = new MemoryKV();
  const env = { SUBSCRIPTION_STATE: state, ADMIN_TOKEN: "admin-secret" };
  const page = await worker.fetch(new Request("https://worker.example.com/admin"), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /输入管理员令牌/);
  const pageText = await (await worker.fetch(new Request("https://worker.example.com/admin"), env)).text();
  assert.match(pageText, /Cloudflare KV/);
  assert.match(pageText, /改名\/替换规则案例/);
  assert.match(pageText, /修改后的通用订阅地址/);
  assert.match(pageText, /复制地址/);
  assert.doesNotMatch(pageText, /固定链接路径 Token/);

  const unauthorized = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions"), env);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: "Bearer admin-secret", "content-type": "application/json" };
  const update = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      subscriptions: [{
        id: "main",
        name: "主订阅",
        sourceUrl: "https://source.example.com/sub?token=REDACTED",
        renameRules: [{ pattern: "\\s+\\|\\s+", replacement: "-" }],
        minValidNodes: 2,
        defaultTarget: "base64"
      }]
    })
  }), env);
  assert.equal(update.status, 200);

  const settings = await worker.fetch(new Request("https://worker.example.com/api/admin/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({ refreshIntervalMinutes: 15 })
  }), env);
  assert.equal(settings.status, 200);

  const read = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", { headers }), env);
  const body = await read.json();
  assert.equal(body.managed, true);
  assert.equal(body.subscriptions[0].sourceUrl, "https://source.example.com/sub?token=REDACTED");
  assert.match(body.subscriptions[0].publicToken, /^[A-Za-z0-9_-]{24,64}$/);
  assert.equal(body.subscriptions[0].minValidNodes, 2);
  assert.equal(body.refreshIntervalMinutes, 15);
});

