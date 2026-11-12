import test from "node:test";
import assert from "node:assert/strict";
import { buildAggregateCandidate, buildCandidate, buildPreview, decidePublication } from "../src/core.js";
import { decodeSubscription, parseShareLink } from "../src/codec.js";
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

test("merges published nodes from multiple sources for one aggregate candidate", async () => {
  const first = (await buildCandidate(sampleClash)).nodes;
  const second = first.map((node) => ({ ...node, name: `Backup ${node.name}`, server: "backup.example.com" }));
  const candidate = await buildAggregateCandidate([first, second]);
  assert.equal(candidate.valid, true);
  assert.equal(candidate.validCount, 2);
  assert.match(candidate.output, /alpha\.example\.com/);
  assert.match(candidate.output, /backup\.example\.com/);
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
});

