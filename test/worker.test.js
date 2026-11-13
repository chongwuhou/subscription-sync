import test from "node:test";
import assert from "node:assert/strict";
import worker, { refresh, refreshAggregate, refreshAll } from "../src/worker.js";
import { renderClashYaml } from "../src/codec.js";

test("renders empty Clash list fields as valid YAML sequences", () => {
  const output = renderClashYaml([{
    name: "AnyTLS",
    type: "anytls",
    server: "node.example.com",
    port: 443,
    password: "secret",
    alpn: [],
    headers: {}
  }]);
  assert.match(output, /alpn: \[\]/);
  assert.match(output, /headers: \{\}/);
  assert.doesNotMatch(output, /alpn:\n\s*\n/);
});

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
    this.chunks = [];
    this.controls = new Map();
  }

  prepare(sql) {
    return {
      bind: (...values) => {
        const isSnapshot = sql.includes("source_snapshots");
        const isChunk = sql.includes("source_snapshot_chunks");
        const isControl = sql.includes("subscription_control");
        return {
          run: async () => {
            if (/^CREATE TABLE/i.test(sql)) {
              return;
            }
            if (isChunk) {
              if (sql.startsWith("INSERT")) {
                const existing = this.chunks.findIndex((row) => row[0] === values[0] && row[1] === values[1]);
                if (existing >= 0) this.chunks[existing] = values;
                else this.chunks.push(values);
              } else if (sql.startsWith("DELETE")) {
                this.chunks = this.chunks.filter((row) => row[0] !== values[0]);
              }
            } else if (isSnapshot && sql.startsWith("INSERT")) {
              if (!this.snapshots.some((row) => row[0] === values[0] && row[2] === values[2])) this.snapshots.push(values);
            } else if (isSnapshot && sql.startsWith("DELETE")) {
              this.snapshots = this.snapshots.filter((row) => row[0] !== values[0]);
            } else if (isControl && sql.startsWith("INSERT")) {
              this.controls.set(values[0], { control_key: values[0], value_json: values[1], updated_at: values[2] });
            } else if (isControl && sql.startsWith("DELETE")) {
              this.controls.delete(values[0]);
            } else {
              this.rows.push(values);
            }
          },
          first: async () => {
            if (isControl) return this.controls.get(values[0]) ?? null;
            if (isChunk) {
              const row = this.chunks.find((item) => item[0] === values[0]);
              return row ? { chunk_json: row[2] } : null;
            }
            if (sql.includes("refresh_audit")) {
              const row = this.rows
                .filter((item) => item[0] === values[0])
                .sort((left, right) => String(right[1]).localeCompare(String(left[1])))[0];
              return row
                ? { created_at: row[1], action: row[2], reason: row[3], valid_count: row[4], content_hash: row[5] }
                : null;
            }
            const row = this.snapshots
              .filter((item) => item[0] === values[0] && (!sql.includes("source_content_hash = ?") || item[2] === values[1]))
              .sort((left, right) => String(right[1]).localeCompare(String(left[1])))[0];
            if (!row) return null;
            if (sql.includes("source_content_hash = ?")) {
              return { id: this.snapshots.indexOf(row) + 1, captured_at: row[1], source_content_hash: row[2], valid_count: row[3], nodes_json: row[4] };
            }
            return sql.trimStart().startsWith("SELECT captured_at")
              ? { captured_at: row[1], valid_count: row[3] }
              : { nodes_json: row[4] };
          },
          all: async () => isChunk
            ? { results: this.chunks
              .filter((item) => item[0] === values[0])
              .sort((left, right) => left[1] - right[1])
              .map((row) => ({ chunk_json: row[2] })) }
            : { results: this.snapshots
              .filter((item) => item[0] === values[0])
              .sort((left, right) => String(right[1]).localeCompare(String(left[1])))
              .map((row) => ({ id: this.snapshots.indexOf(row) + 1, captured_at: row[1], source_content_hash: row[2], valid_count: row[3] })) }
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

test("uses conditional requests and retries transient source failures", async () => {
  const originalFetch = globalThis.fetch;
  const state = new MemoryKV();
  const audit = new MemoryD1();
  const env = {
    SOURCE_URL: "https://source.example.com/conditional",
    PUBLIC_PATH_TOKEN: "conditional-token",
    SUBSCRIPTION_STATE: state,
    SUBSCRIPTION_AUDIT: audit,
    SOURCE_RETRY_COUNT: "1"
  };
  const calls = [];
  globalThis.fetch = async (request, init) => {
    calls.push({ request: typeof request === "string" ? request : request.url, headers: init?.headers ?? {} });
    if (calls.length === 1) return new Response("temporary upstream failure", { status: 503 });
    if (calls.length === 2) {
      return new Response(validSource, {
        status: 200,
        headers: { etag: '"source-v1"', "last-modified": "Thu, 12 Nov 2026 00:00:00 GMT" }
      });
    }
    return new Response(null, { status: 304, headers: { etag: '"source-v1"' } });
  };
  try {
    const first = await refresh(env, new Date("2026-11-12T00:00:00.000Z"));
    assert.equal(first.action, "initialize");
    const published = JSON.parse(await state.get("published-state-v1:default"));
    assert.equal(published.sourceEtag, '"source-v1"');
    assert.equal(calls.length, 2);

    const unchanged = await refresh(env, new Date("2026-11-12T00:06:00.000Z"));
    assert.equal(unchanged.action, "keep");
    assert.equal(unchanged.reason, "unchanged");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers["if-none-match"], '"source-v1"');
    assert.equal(calls[2].headers["if-modified-since"], "Thu, 12 Nov 2026 00:00:00 GMT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chunks large D1 source snapshots and can read them for fallback", async () => {
  const originalFetch = globalThis.fetch;
  const state = new MemoryKV();
  const audit = new MemoryD1();
  const env = {
    SOURCE_URL: "https://source.example.com/large",
    PUBLIC_PATH_TOKEN: "large-token",
    SUBSCRIPTION_STATE: state,
    SUBSCRIPTION_AUDIT: audit
  };
  const padding = "x".repeat(1300);
  const largeSource = `proxies:\n${Array.from({ length: 1300 }, (_, index) => `  - name: Large ${index}\n    type: anytls\n    server: node-${index}.example.com\n    port: 443\n    password: ${padding}${index}\n`).join("")}`;
  globalThis.fetch = async () => new Response(largeSource, { status: 200 });
  try {
    const first = await refresh(env, new Date("2026-11-12T02:00:00.000Z"));
    assert.equal(first.action, "initialize");
    assert.equal(audit.snapshots.length, 1);
    assert.equal(audit.snapshots[0][4], "");
    assert.ok(audit.chunks.length > 1);

    globalThis.fetch = async () => { throw new Error("source closed"); };
    const fallback = await refresh(env, new Date("2026-11-12T02:06:00.000Z"));
    assert.equal(fallback.action, "keep");
    assert.equal(fallback.reason, "source-unavailable-use-last-good");
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
    const mainBytes = new Uint8Array(await mainResponse.arrayBuffer());
    assert.deepEqual(Array.from(mainBytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
    const mainText = new TextDecoder().decode(mainBytes);
    assert.match(mainText, /one.example.com/);
    assert.equal(mainResponse.headers.get("content-type"), "text/yaml; charset=utf-8");
    assert.match(await backupResponse.text(), /backup.example.com/);

    const surgeResponse = await worker.fetch(new Request("https://worker.example.com/sub/main-token", {
      headers: { "user-agent": "Shadowrocket/2.2" }
    }), env);
    assert.equal(surgeResponse.status, 200);
    assert.equal(surgeResponse.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(await surgeResponse.text(), /\[Proxy Group\]/);

    const base64Response = await worker.fetch(new Request("https://worker.example.com/sub/main-token?target=base64"), env);
    assert.equal(base64Response.status, 200);
    assert.equal(base64Response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(atob((await base64Response.text()).trim()), /vmess:\/\//);

    const singBoxResponse = await worker.fetch(new Request("https://worker.example.com/sub/main-token?target=sing-box"), env);
    assert.equal(singBoxResponse.status, 200);
    const singBox = JSON.parse(await singBoxResponse.text());
    assert.equal(singBox.outbounds[0].tag, "PROXY");
    assert.equal(singBox.outbounds[0].type, "urltest");

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
  assert.match(pageText, /Cloudflare D1/);
  assert.match(pageText, /节点改名规则（按顺序执行）/);
  assert.match(pageText, /添加一行规则/);
  assert.match(pageText, /正则模式/);
  assert.doesNotMatch(pageText, /改名规则 JSON/);
  assert.match(pageText, /修改后的通用订阅地址/);
  assert.match(pageText, /汇总后的通用订阅地址/);
  assert.match(pageText, /const card = document\.createElement\("details"\)/);
  assert.match(pageText, /复制地址/);
  assert.match(pageText, /默认只替换名称/);
  assert.match(pageText, /Clash \/ Mihomo 分流配置/);
  assert.match(pageText, /默认自动测速/);
  assert.match(pageText, /运行状态|D1/);
  assert.match(pageText, /Rule Providers|rule-providers/);
  assert.match(pageText, /上传并保存历史源/);
  assert.match(pageText, /节点名称组合筛选/);
  assert.match(pageText, /必须包含（且；多个关键词用 \| 分隔）/);
  assert.match(pageText, /以下任意一个（或；多个关键词用 \| 分隔）/);
  assert.match(pageText, /VIP2 且（美国1\/美国2\/美国3 任意一个）/);
  assert.match(pageText, /历史内容版本/);
  assert.match(pageText, /使用此版本/);
  assert.match(pageText, /同时暂停自动更新/);
  assert.match(pageText, /汇总自定义节点/);
  assert.match(pageText, /自定义节点位置/);
  assert.match(pageText, /已过期的旧汇总地址/);
  assert.match(pageText, /用户分发订阅/);
  assert.match(pageText, /自动到期分发地址（可调整日期）/);
  assert.match(pageText, /autoDistributionExpiry/);
  assert.match(pageText, /备注名称（仅自己可见）/);
  assert.match(pageText, /到期日期/);
  assert.match(pageText, /分发订阅地址/);
  assert.match(pageText, /expiredName/);
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
        nodeNameInclude: "US|VIP2",
        nodeNameIncludeAll: "US|One",
        nodeNameExclude: "到期|续费",
        minValidNodes: 1,
        defaultTarget: "base64"
      }],
      aggregatePublicToken: "new-aggregate-token-123456",
      expiredSubscription: {
        tokens: ["old-aggregate-token-123456"],
        nodeNames: ["已到期", "请联系顾问", "请改用新地址"]
      },
      distributionSubscriptions: [{ note: "张三", expiresOn: "2026-12-11" }]
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
      },
      aggregateCustomNodes: ["vless://11111111-1111-1111-1111-111111111111@custom.example.com:443?security=tls#Custom"],
      aggregateCustomNodePosition: "top"
    })
  }), env);
  assert.equal(settings.status, 200);

  const read = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", { headers }), env);
  const body = await read.json();
  assert.equal(body.managed, true);
  assert.equal(body.subscriptions[0].sourceUrl, "https://source.example.com/sub?token=REDACTED");
  assert.match(body.subscriptions[0].publicToken, /^[A-Za-z0-9_-]{24,64}$/);
  assert.deepEqual(body.subscriptions[0].renameRules, []);
  assert.equal(body.subscriptions[0].nodeNameInclude, "US|VIP2");
  assert.equal(body.subscriptions[0].nodeNameIncludeAll, "US|One");
  assert.equal(body.subscriptions[0].nodeNameExclude, "到期|续费");
  assert.match(body.aggregatePublicToken, /^[A-Za-z0-9_-]{24,64}$/);
  assert.equal(body.subscriptions[0].minValidNodes, 1);
  assert.equal(body.refreshIntervalMinutes, 15);
  assert.equal(body.clashConfig.rules[0], "RULE-SET,ads,REJECT");
  assert.equal(body.clashConfig["rule-providers"].ads.type, "http");
  assert.deepEqual(body.aggregateCustomNodes, ["vless://11111111-1111-1111-1111-111111111111@custom.example.com:443?security=tls#Custom"]);
  assert.equal(body.aggregateCustomNodePosition, "top");
  assert.equal(body.controlPlane, "d1");
  assert.equal(body.subscriptions[0].status.lastAction, "");
  assert.deepEqual(body.expiredSubscription, {
    tokens: ["old-aggregate-token-123456"],
    nodeNames: ["已到期", "请联系顾问", "请改用新地址"]
  });
  assert.equal(body.distributionSubscriptions.length, 1);
  assert.equal(body.distributionSubscriptions[0].note, "张三");
  assert.equal(body.distributionSubscriptions[0].expiresOn, "2026-12-11");
  assert.equal(body.distributionSubscriptions[0].displayName, "到期日期26-12-11");
  assert.match(body.distributionSubscriptions[0].publicToken, /^[A-Za-z0-9_-]{24,64}$/);
  const distributionToken = body.distributionSubscriptions[0].publicToken;
  assert.ok(audit.controls.has("profiles"));
  assert.ok(audit.controls.has("settings"));
  await state.put("subscription-config-v1", JSON.stringify([{
    id: "kv-only-different",
    name: "KV only",
    sourceUrl: "https://kv.example.com/source",
    publicToken: "kv-token"
  }]));
  const d1CanonicalRead = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", { headers }), env);
  const d1CanonicalBody = await d1CanonicalRead.json();
  assert.equal(d1CanonicalBody.subscriptions[0].id, "工作一");

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

  const secondImportResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "工作一", content: validSource.replace("one.example.com", "two.example.com") })
  }), env);
  assert.equal(secondImportResponse.status, 200);
  assert.equal(audit.snapshots.length, 2);
  const historyRead = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", { headers }), env);
  const historyBody = await historyRead.json();
  assert.equal(historyBody.subscriptions[0].historyVersions.length, 2);
  assert.notEqual(historyBody.subscriptions[0].historyVersions[0].sourceContentHash, historyBody.subscriptions[0].historyVersions[1].sourceContentHash);
  const currentSourceHash = JSON.parse(await state.get("published-state-v1:工作一")).sourceContentHash;
  const olderVersion = historyBody.subscriptions[0].historyVersions.find((version) => version.sourceContentHash !== currentSourceHash)
    ?? historyBody.subscriptions[0].historyVersions[1];
  const useHistoryResponse = await worker.fetch(new Request("https://worker.example.com/api/admin/history/use", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "工作一", sourceContentHash: olderVersion.sourceContentHash, pauseUpdates: true })
  }), env);
  assert.equal(useHistoryResponse.status, 200);
  const useHistoryBody = await useHistoryResponse.json();
  assert.equal(useHistoryBody.paused, true);
  assert.match(JSON.parse(await state.get("published-state-v1:工作一")).output, /one\.example\.com/);
  const pausedRefresh = await worker.fetch(new Request("https://worker.example.com/api/admin/refresh", { method: "POST", headers }), env);
  assert.equal(pausedRefresh.status, 200);
  assert.equal((await pausedRefresh.json()).results[0].reason, "paused");

  const expiredResponse = await worker.fetch(new Request("https://worker.example.com/sub/old-aggregate-token-123456"), env);
  assert.equal(expiredResponse.status, 200);
  const expiredBytes = new Uint8Array(await expiredResponse.arrayBuffer());
  const expiredText = new TextDecoder().decode(expiredBytes);
  assert.match(expiredText, /已到期/);
  assert.match(expiredText, /请联系顾问/);
  assert.match(expiredText, /请改用新地址/);

  const expiredV2Response = await worker.fetch(new Request("https://worker.example.com/sub/old-aggregate-token-123456", {
    headers: { "user-agent": "v2rayNG/1.10.0" }
  }), env);
  assert.equal(expiredV2Response.status, 200);
  assert.match(atob((await expiredV2Response.text()).trim()), /vmess:\/\//);

  const normalAggregateResponse = await worker.fetch(new Request("https://worker.example.com/sub/new-aggregate-token-123456"), env);
  assert.equal(normalAggregateResponse.status, 200);
  const normalAggregateText = await normalAggregateResponse.text();
  assert.match(normalAggregateText, /Custom/);
  assert.match(normalAggregateText, /US \| One/);
  assert.ok(normalAggregateText.indexOf("Custom") < normalAggregateText.indexOf("US | One"));

  const distributionResponse = await worker.fetch(new Request("https://worker.example.com/sub/" + distributionToken), env);
  assert.equal(distributionResponse.status, 200);
  const distributionText = await distributionResponse.text();
  assert.match(distributionText, /到期日期26-12-11/);
  assert.match(distributionText, /US \| One/);
  assert.ok(distributionText.indexOf("到期日期26-12-11") < distributionText.indexOf("US | One"));

  const aggregateStateKey = "published-state-v1:__all__";
  const staleAggregateState = JSON.parse(await state.get(aggregateStateKey));
  staleAggregateState.nodes = [
    { name: "订阅已过期", type: "vmess", server: "127.0.0.1", port: 1, uuid: "00000000-0000-0000-0000-000000000001" },
    { name: "请联系顾问", type: "vmess", server: "127.0.0.1", port: 2, uuid: "00000000-0000-0000-0000-000000000002" },
    { name: "续费后恢复", type: "vmess", server: "127.0.0.1", port: 3, uuid: "00000000-0000-0000-0000-000000000003" },
    ...staleAggregateState.nodes
  ];
  await state.put(aggregateStateKey, JSON.stringify(staleAggregateState));
  const isolatedDistributionResponse = await worker.fetch(new Request("https://worker.example.com/sub/" + distributionToken), env);
  assert.equal(isolatedDistributionResponse.status, 200);
  const isolatedDistributionText = await isolatedDistributionResponse.text();
  assert.match(isolatedDistributionText, /到期日期26-12-11/);
  assert.doesNotMatch(isolatedDistributionText, /订阅已过期|请联系顾问|续费后恢复/);

  const expiredDistributionUpdate = await worker.fetch(new Request("https://worker.example.com/api/admin/subscriptions", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      subscriptions: [{
        id: "工作一",
        name: "主订阅",
        sourceUrl: "https://source.example.com/sub?token=REDACTED",
        renameRules: [],
        nodeNameInclude: "US|VIP2",
        nodeNameIncludeAll: "US|One",
        nodeNameExclude: "到期|续费",
        minValidNodes: 1,
        defaultTarget: "base64"
      }],
      aggregatePublicToken: "new-aggregate-token-123456",
      expiredSubscription: {
        tokens: ["old-aggregate-token-123456"],
        nodeNames: ["已到期", "请联系顾问", "请改用新地址"]
      },
      distributionSubscriptions: [{ note: "张三", expiresOn: "2020-01-01", publicToken: distributionToken }]
    })
  }), env);
  assert.equal(expiredDistributionUpdate.status, 200);
  const autoExpiredDistributionResponse = await worker.fetch(new Request("https://worker.example.com/sub/" + distributionToken), env);
  assert.equal(autoExpiredDistributionResponse.status, 200);
  const autoExpiredDistributionText = await autoExpiredDistributionResponse.text();
  assert.match(autoExpiredDistributionText, /已到期/);
  assert.doesNotMatch(autoExpiredDistributionText, /US \| One/);

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

