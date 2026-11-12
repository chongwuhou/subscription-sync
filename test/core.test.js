import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidate, decidePublication } from "../src/core.js";
import { decodeSubscription, parseShareLink } from "../src/codec.js";

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

