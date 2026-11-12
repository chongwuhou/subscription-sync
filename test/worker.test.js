import test from "node:test";
import assert from "node:assert/strict";
import worker, { refresh, refreshAggregate, refreshAll } from "../src/worker.js";

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
    this.snapshots = [];
  }

  prepare(sql) {
    return {
      bind: (...values) => {
        const isSnapshot = sql.includes("source_snapshots");
        return {
          run: async () => {
            if (/^CREATE TABLE/i.test(sql)) {
              return;
            }
            if (isSnapshot) {
              if (!this.snapshots.some((row) => row[0] === values[0] && row[2] === values[2])) this.snapshots.push(values);
            } else {
              this.rows.push(values);
            }
          },
          first: async () => {
            const row = this.snapshots
              .filter((item) => item[0] === values[0])
              .sort((left, right) => String(right[1]).localeCompare(String(left[1])))[0];
            if (!row) return null;
            return sql.trimStart().startsWith("SELECT captured_at")
              ? { captured_at: row[1], valid_count: row[3] }
              : { nodes_json: row[4] };
          }
        };
      }
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
    assert.equal(invalid.reason, "latest-invalid-use-last-good");

    const published = JSON.parse(await state.get("published-state-v1:default"));
    assert.equal(published.validCount, 1);
    assert.match(published.output, /US-One/);
    assert.equal(audit.rows.length, 3);
    assert.equal(audit.snapshots.length, 1);
    assert.equal(audit.rows[0][0], "default");
    assert.equal(audit.rows[0][1], "2026-11-12T00:00:00.000Z");
    assert.equal(audit.rows[2][2], "keep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reprocesses the latest D1 source snapshot when the source is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const state = new MemoryKV();
  const audit = new MemoryD1();
  const env = {
    SOURCE_URL: "https://source.example.com/intermittent",
    PUBLIC_PATH_TOKEN: "snapshot-token",
    SUBSCRIPTION_STATE: state,
    SUBSCRIPTION_AUDIT: audit,
    RENAME_RULES_JSON: JSON.stringify([{ pattern: "\\s*\\|\\s*", replacement: "-" }])
  };
  globalThis.fetch = async () => new Response(validSource, { status: 200 });
  try {
    const first = await refresh(env, new Date("2026-11-12T00:00:00.000Z"));
    assert.equal(first.action, "initialize");
    assert.equal(audit.snapshots.length, 1);

    env.RENAME_RULES_JSON = JSON.stringify([{ pattern: "US", replacement: "United States" }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("source window closed"); };
    const fallback = await refresh(env, new Date("2026-11-12T00:06:00.000Z"));
    assert.equal(fallback.action, "update");
    assert.equal(fallback.reason, "source-unavailable-use-last-good");
    const published = JSON.parse(await state.get("published-state-v1:default"));
    assert.match(published.output, /United States \| One/);
    assert.equal(audit.snapshots.length, 1);
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
    AGGREGATE_PUBLIC_TOKEN: "all-token",
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
    const aggregate = await refreshAggregate(env, new Date("2026-11-12T01:00:00.000Z"));
    assert.equal(aggregate.action, "initialize");
    assert.equal(aggregate.validCount, 2);
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

    const aggregateResponse = await worker.fetch(new Request("https://worker.example.com/sub/all-token"), env);
    assert.equal(aggregateResponse.status, 200);
    const aggregateText = await aggregateResponse.text();
    assert.match(aggregateText, /one\.example\.com/);
    assert.match(aggregateText, /backup\.example\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin API manages subscriptions and refresh interval without public access", async () => {
  const state = new MemoryKV();
  const audit = new MemoryD1();
  const env = { SUBSCRIPTION_STATE: state, SUBSCRIPTION_AUDIT: audit, ADMIN_TOKEN: "admin-secret" };
  const page = await worker.fetch(new Request("https://worker.example.com/admin"), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /输入管理员令牌/);
  const pageText = await (await worker.fetch(new Request("https://worker.example.com/admin"), env)).text();
  assert.match(pageText, /Cloudflare KV/);
  assert.match(pageText, /一行规则示例/);
  assert.match(pageText, /修改后的通用订阅地址/);
  assert.match(pageText, /复制地址/);
  assert.match(pageText, /默认只替换名称/);
  assert.match(pageText, /Clash \/ Mihomo 分流配置/);
  assert.match(pageText, /Rule Providers|rule-providers/);
  assert.match(pageText, /上传并保存历史源/);
  assert.doesNotMatch(pageText, /固定链接路径 Token/);

  const unauthorized = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions"), env);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: "Bearer admin-secret", "content-type": "application/json" };
  const update = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      subscriptions: [{
        id: "工作一",
        name: "主订阅",
        sourceUrl: "https://source.example.com/sub?token=REDACTED",
        renameRules: [],
        minValidNodes: 1,
        defaultTarget: "base64"
      }]
    })
  }), env);
  assert.equal(update.status, 200);

  const settings = await worker.fetch(new Request("https://worker.example.com/api/admin/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      refreshIntervalMinutes: 15,
      clashConfig: {
        "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["DIRECT", "{{NODES}}"] }],
        "rule-providers": { ads: { type: "http", behavior: "domain", url: "https://rules.example.com/ads.yaml", path: "./ruleset/ads.yaml" } },
        rules: ["RULE-SET,ads,REJECT", "MATCH,PROXY"]
      }
    })
  }), env);
  assert.equal(settings.status, 200);

  const read = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", { headers }), env);
  const body = await read.json();
  assert.equal(body.managed, true);
  assert.equal(body.subscriptions[0].sourceUrl, "https://source.example.com/sub?token=REDACTED");
  assert.match(body.subscriptions[0].publicToken, /^[A-Za-z0-9_-]{24,64}$/);
  assert.deepEqual(body.subscriptions[0].renameRules, []);
  assert.match(body.aggregatePublicToken, /^[A-Za-z0-9_-]{24,64}$/);
  assert.equal(body.subscriptions[0].minValidNodes, 1);
  assert.equal(body.refreshIntervalMinutes, 15);
  assert.equal(body.clashConfig.rules[0], "RULE-SET,ads,REJECT");
  assert.equal(body.clashConfig["rule-providers"].ads.type, "http");

  const importResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "工作一", content: validSource })
  }), env);
  assert.equal(importResponse.status, 200);
  const importBody = await importResponse.json();
  assert.equal(importBody.validCount, 1);
  assert.equal(audit.snapshots.length, 1);
  const importedState = JSON.parse(await state.get("published-state-v1:工作一"));
  assert.match(importedState.output, /rule-providers/);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("source window closed"); };
    const historyPreviewResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "工作一", renameRules: [{ pattern: "One", replacement: "1" }] })
    }), env);
    assert.equal(historyPreviewResponse.status, 200);
    const historyPreview = await historyPreviewResponse.json();
    assert.equal(historyPreview.source, "history");
    assert.equal(historyPreview.original[0].name, "US | One");

  globalThis.fetch = async () => new Response(validSource, { status: 200 });
  try {
    const previewResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "工作一", renameRules: [[{ pattern: "\\s+\\|\\s+", replacement: "-" }], [{ pattern: "One", replacement: "1" }]], replaceAllFields: false })
    }), env);
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.original[0].name, "US | One");
    assert.equal(preview.modified[0].name, "US-1");
    assert.equal(preview.modified[0].server, "one.example.com");
    assert.equal(Object.hasOwn(preview.original[0], "uuid"), false);
    assert.equal(Object.hasOwn(preview.modified[0], "uuid"), false);

    const allFieldsPreviewResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "工作一", renameRules: [{ pattern: "one", replacement: "two", flags: "gi" }], replaceAllFields: true })
    }), env);
    assert.equal(allFieldsPreviewResponse.status, 200);
    const allFieldsPreview = await allFieldsPreviewResponse.json();
    assert.equal(allFieldsPreview.modified[0].server, "two.example.com");

    const refreshResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/refresh", {
      method: "POST",
      headers
    }), env);
    assert.equal(refreshResponse.status, 200);
    const refreshBody = await refreshResponse.json();
    assert.equal(Object.hasOwn(refreshBody.results[0], "nodes"), false);
    assert.equal(Object.hasOwn(refreshBody.results[0], "output"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

