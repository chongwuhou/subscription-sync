import test from "node:test";
import assert from "node:assert/strict";
import { refresh, refreshAll } from "../src/worker.js";

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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

