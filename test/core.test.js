import test from "node:test";
import assert from "node:assert/strict";
import { buildAggregateCandidate, buildCandidate, buildPreview, decidePublication } from "../src/core.js";
import { applyRename, decodeSubscription, parseShareLink } from "../src/codec.js";
import { detectTarget, renderSubscription } from "../src/formats.js";

const sampleClash = `
proxies:
  - name: US | Alpha
    type: vmess
    server: alpha.example.com
    port: 443
    uuid: 11111111-1111-1111-1111-111111111111
    tls: true
  - name: Broken
    type: vmess
    server: missing-port.example.com
    uuid: 22222222-2222-2222-2222-222222222222
`;

const hashByContent = async (value) => `hash:${value}`;

test("parses Clash YAML and keeps only structurally valid nodes", async () => {
  const candidate = await buildCandidate(sampleClash, {
    renameRules: [{ pattern: "\\s*\\|\\s*", replacement: "-" }],
    hashFn: hashByContent
  });
  assert.equal(candidate.valid, true);
  assert.equal(candidate.validCount, 1);
  assert.equal(candidate.nodes[0].name, "US-Alpha");
  assert.match(candidate.output, /proxy-groups:/);
  assert.match(candidate.output, /type: url-test/);
});

test("accepts AnyTLS nodes in Clash YAML", async () => {
  const candidate = await buildCandidate(`
proxies:
  - name: AnyTLS test
    type: anytls
    server: anytls.example.com
    port: 443
    password: test-password
    sni: anytls.example.com
`);
  assert.equal(candidate.valid, true);
  assert.equal(candidate.validCount, 1);
  assert.match(candidate.output, /type: anytls/);
});

test("filters source names before rename and keeps the unfiltered history", async () => {
  const candidate = await buildCandidate(`
proxies:
  - name: 美国 VIP2 到期
    type: anytls
    server: expired.example.com
    port: 443
    password: expired
  - name: 美国 VIP2
    type: anytls
    server: active.example.com
    port: 443
    password: active
  - name: 日本普通节点
    type: anytls
    server: jp.example.com
    port: 443
    password: jp
`, {
    nodeNameInclude: "美国|VIP2",
    nodeNameExclude: "到期|续费",
    renameRules: [{ pattern: "美国", replacement: "US" }]
  });
  assert.equal(candidate.sourceValidCount, 3);
  assert.equal(candidate.sourceNodes.length, 3);
  assert.equal(candidate.validCount, 1);
  assert.equal(candidate.nodes[0].name, "US VIP2");
  assert.match(candidate.output, /active\.example\.com/);
  assert.doesNotMatch(candidate.output, /expired\.example\.com|jp\.example\.com/);
});

test("supports OR and AND node-name filters and flexible website cleanup", async () => {
  const candidate = await buildCandidate(`
proxies:
  - name: 美国 VIP2 网站:nnbin.com
    type: anytls
    server: us1.example.com
    port: 443
    password: one
  - name: 美国 VIP1 网址:nnbin.com
    type: anytls
    server: us2.example.com
    port: 443
    password: two
  - name: 美国 普通节点
    type: anytls
    server: us3.example.com
    port: 443
    password: three
  - name: 日本 VIP2
    type: anytls
    server: jp.example.com
    port: 443
    password: four
`, {
    nodeNameInclude: "美国|日本",
    nodeNameIncludeAll: "美国|VIP",
    renameRules: [{ pattern: "(?:网址|网站)[:：]?nnbin\\.com", replacement: "" }]
  });
  assert.equal(candidate.validCount, 2);
  assert.deepEqual(candidate.nodes.map((node) => node.name), ["美国 VIP1", "美国 VIP2"]);
});

test("builds an original and renamed preview without dropping valid nodes", () => {
  const preview = buildPreview(sampleClash, {
    renameRules: [{ pattern: "\\s*\\|\\s*", replacement: "-" }]
  });
  assert.equal(preview.original.length, 1);
  assert.equal(preview.modified.length, 1);
  assert.equal(preview.original[0].name, "US | Alpha");
  assert.equal(preview.modified[0].name, "US-Alpha");
  assert.equal(preview.original[0].uuid, preview.modified[0].uuid);
});

test("applies multiple rules even when pasted as nested arrays", () => {
  const preview = buildPreview(sampleClash, {
    renameRules: [
      [{ pattern: "US", replacement: "HK" }],
      [{ pattern: "Alpha", replacement: "1" }]
    ]
  });
  assert.equal(preview.modified[0].name, "HK | 1");
});

test("supports simple literal rename rules from the admin editor", () => {
  assert.equal(applyRename("VIP2 网址:nnbin.com", [
    { pattern: "网址:nnbin.com", replacement: "", literal: true },
    { pattern: "VIP2", replacement: "线路一", literal: true }
  ]), "线路一");
});

test("replaces non-name fields only when the advanced option is enabled", async () => {
  const candidate = await buildCandidate(sampleClash, {
    renameRules: [{ pattern: "alpha", replacement: "beta", flags: "gi" }],
    replaceAllFields: true
  });
  assert.equal(candidate.nodes[0].name, "US | beta");
  assert.equal(candidate.nodes[0].server, "beta.example.com");
});

test("merges published nodes from multiple sources for one aggregate candidate", async () => {
  const first = (await buildCandidate(sampleClash)).nodes;
  const second = first.map((node) => ({ ...node, name: `Backup ${node.name}`, server: "backup.example.com" }));
  const candidate = await buildAggregateCandidate([first, second]);
  assert.equal(candidate.valid, true);
  assert.equal(candidate.validCount, 2);
  assert.match(candidate.output, /alpha\.example\.com/);
  assert.match(candidate.output, /backup\.example\.com/);
});

test("places custom aggregate nodes at the selected edge", async () => {
  const sourceNodes = (await buildCandidate(sampleClash)).nodes;
  const customNodes = decodeSubscription("vless://11111111-1111-1111-1111-111111111111@custom.example.com:443?security=tls#Custom");
  const top = await buildAggregateCandidate([sourceNodes], { customNodes, customNodePosition: "top" });
  const tail = await buildAggregateCandidate([sourceNodes], { customNodes, customNodePosition: "tail" });
  assert.equal(top.nodes[0].name, "Custom");
  assert.equal(top.nodes[0].server, "custom.example.com");
  assert.equal(tail.nodes.at(-1).name, "Custom");
});

test("unchanged content is not republished", async () => {
  const candidate = await buildCandidate(sampleClash, { hashFn: hashByContent });
  const previous = { contentHash: candidate.contentHash, output: candidate.output };
  const decision = decidePublication(candidate, previous);
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "unchanged");
});

test("invalid or empty candidate never replaces the last good version", () => {
  const decision = decidePublication({ valid: false, output: null, contentHash: null }, {
    contentHash: "old",
    output: "old-config"
  });
  assert.deepEqual(decision, { action: "keep", reason: "no-valid-nodes" });
});

test("supports VMess and VLESS share links", () => {
  const vmessPayload = btoa(JSON.stringify({
    add: "vmess.example.com",
    port: "443",
    id: "11111111-1111-1111-1111-111111111111",
    ps: "VMess Test",
    tls: "tls",
    net: "ws",
    path: "/edge"
  }));
  const vmess = parseShareLink(`vmess://${vmessPayload}`);
  const vless = parseShareLink("vless://11111111-1111-1111-1111-111111111111@vless.example.com:443?security=tls&type=ws&path=%2Fedge#VLESS%20Test");
  assert.equal(vmess.type, "vmess");
  assert.equal(vmess.server, "vmess.example.com");
  assert.equal(vless.type, "vless");
  assert.equal(vless.name, "VLESS Test");
  assert.equal(vless["ws-opts"].path, "/edge");
});

test("supports AnyTLS share links and output formats", () => {
  const anytls = parseShareLink("anytls://secret@example.com:443/?sni=example.com&insecure=1#AnyTLS%20Test");
  assert.equal(anytls.type, "anytls");
  assert.equal(anytls.password, "secret");
  assert.equal(anytls["skip-cert-verify"], true);

  const links = renderSubscription([anytls], "links");
  assert.match(links.body, /^anytls:\/\/secret@example\.com:443\/?\?sni=example\.com&insecure=1#AnyTLS%20Test/);
  const singBox = JSON.parse(renderSubscription([anytls], "sing-box").body);
  assert.equal(singBox.outbounds[0].type, "urltest");
  assert.equal(singBox.outbounds[0].url, "https://www.gstatic.com/generate_204");
  assert.equal(singBox.outbounds[0].interval, "5m");
  const outbound = singBox.outbounds.find((item) => item.type === "anytls");
  assert.equal(outbound.password, "secret");
  assert.equal(outbound.tls.server_name, "example.com");
  assert.equal(outbound.tls.insecure, true);
});

test("preserves sing-box transport and Reality fields when converting to Clash and sing-box", async () => {
  const source = JSON.stringify({
    outbounds: [{
      type: "vless",
      tag: "Reality WS",
      server: "edge.example.com",
      server_port: 443,
      uuid: "11111111-1111-1111-1111-111111111111",
      flow: "xtls-rprx-vision",
      tls: {
        enabled: true,
        server_name: "www.example.com",
        reality: { enabled: true, public_key: "public-key", short_id: "short-id" },
        utls: { enabled: true, fingerprint: "chrome" }
      },
      transport: { type: "ws", path: "/subscribe", headers: { Host: "www.example.com" } }
    }]
  });
  const candidate = await buildCandidate(source);
  assert.equal(candidate.validCount, 1);
  assert.equal(candidate.nodes[0]["ws-opts"].path, "/subscribe");
  assert.equal(candidate.nodes[0]["reality-opts"]["public-key"], "public-key");
  const singBox = JSON.parse(renderSubscription(candidate.nodes, "sing-box").body);
  const outbound = singBox.outbounds.find((item) => item.type === "vless");
  assert.equal(outbound.flow, "xtls-rprx-vision");
  assert.equal(outbound.transport.path, "/subscribe");
  assert.equal(outbound.tls.reality.public_key, "public-key");
  assert.equal(outbound.tls.utls.fingerprint, "chrome");
});

test("accepts WireGuard in Clash input and keeps it in both structured outputs", async () => {
  const candidate = await buildCandidate(`
proxies:
  - name: WG Test
    type: wireguard
    server: wg.example.com
    port: 51820
    ip: 10.0.0.2/32
    private-key: private-key
    public-key: peer-public-key
    allowed-ips: [0.0.0.0/0, ::/0]
`);
  assert.equal(candidate.validCount, 1);
  assert.match(candidate.output, /type: wireguard/);
  const singBox = JSON.parse(renderSubscription(candidate.nodes, "sing-box").body);
  const outbound = singBox.outbounds.find((item) => item.type === "wireguard");
  assert.equal(outbound.server_port, 51820);
  assert.equal(outbound.peer_public_key, "peer-public-key");
  assert.deepEqual(outbound.local_address, ["10.0.0.2/32"]);
});

test("supports an SSR share link", () => {
  const payload = `ssr.example.com:443:origin:aes-256-gcm:plain:${btoa("secret")}/?remarks=${btoa("SSR Test")}`;
  const node = parseShareLink(`ssr://${btoa(payload)}`);
  assert.equal(node.type, "ssr");
  assert.equal(node.password, "secret");
  assert.equal(node.name, "SSR Test");
});

test("decodes a Base64 share-link subscription", () => {
  const input = "vless://11111111-1111-1111-1111-111111111111@node.example.com:443?security=tls#Node";
  const encoded = btoa(input);
  const nodes = decodeSubscription(encoded);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].server, "node.example.com");
});

test("renders multiple client formats and detects common client user agents", async () => {
  const candidate = await buildCandidate(sampleClash);
  const shadowrocketRequest = new Request("https://worker.example.com/sub/token", {
    headers: { "user-agent": "Shadowrocket/2.2" }
  });
  assert.equal(detectTarget(shadowrocketRequest), "base64");
  assert.equal(detectTarget(new Request("https://worker.example.com/sub/token?target=sing-box")), "sing-box");

  const links = renderSubscription(candidate.nodes, "links");
  assert.match(links.body, /^vmess:\/\//);
  const base64 = renderSubscription(candidate.nodes, "base64");
  assert.equal(base64.contentType, "text/plain; charset=utf-8");
  const decoded = atob(base64.body.trim());
  assert.match(decoded, /vmess:\/\//);
  const singBox = renderSubscription(candidate.nodes, "sing-box");
  assert.equal(JSON.parse(singBox.body).outbounds[0].tag, "PROXY");
  assert.equal(JSON.parse(singBox.body).outbounds[0].type, "urltest");
});

test("renders configurable Clash rule providers and expands all nodes in proxy groups", async () => {
  const candidate = await buildCandidate(sampleClash, {
    clashConfig: {
      "proxy-groups": [
        { name: "🚀 节点选择", type: "select", proxies: ["DIRECT", "{{NODES}}"] }
      ],
      "rule-providers": {
        ads: {
          type: "http",
          behavior: "domain",
          url: "https://rules.example.com/ads.yaml",
          path: "./ruleset/ads.yaml",
          interval: 86400
        }
      },
      rules: ["RULE-SET,ads,REJECT", "MATCH,🚀 节点选择"]
    }
  });
  assert.match(candidate.output, /rule-providers:/);
  assert.match(candidate.output, /RULE-SET,ads,REJECT/);
  assert.match(candidate.output, /alpha\.example\.com/);
  assert.match(candidate.output, /🚀 节点选择/);
});

