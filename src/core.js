import {
  decodeSubscription,
  isValidNode,
  normalizeNode,
  renderClashYaml
} from "./codec.js";

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function identityWithoutName(node) {
  const copy = { ...node };
  delete copy.name;
  return stableStringify(copy);
}

export async function buildCandidate(rawText, options = {}) {
  const renameRules = Array.isArray(options.renameRules) ? options.renameRules : [];
  const minValidNodes = Math.max(1, Number(options.minValidNodes ?? 1));
  const parsed = decodeSubscription(rawText);
  const deduped = new Map();
  for (const item of parsed) {
    const node = normalizeNode(item, renameRules);
    if (!isValidNode(node)) continue;
    deduped.set(identityWithoutName(node), node);
  }
  const nodes = [...deduped.values()].sort((left, right) =>
    `${left.name}\u0000${left.type}\u0000${left.server}\u0000${left.port}`.localeCompare(
      `${right.name}\u0000${right.type}\u0000${right.server}\u0000${right.port}`
    )
  );
  const valid = nodes.length >= minValidNodes;
  const canonical = valid ? stableStringify(nodes) : null;
  const hashFn = options.hashFn ?? sha256Hex;
  const contentHash = valid ? await hashFn(canonical) : null;
  return {
    valid,
    validCount: nodes.length,
    minValidNodes,
    contentHash,
    nodes,
    output: valid ? renderClashYaml(nodes) : null
  };
}

export function decidePublication(candidate, previous) {
  if (!candidate?.valid || !candidate.output || !candidate.contentHash) {
    return { action: "keep", reason: "no-valid-nodes" };
  }
  if (previous?.contentHash === candidate.contentHash && previous?.output) {
    return {
      action: "keep",
      reason: "unchanged",
      validCount: candidate.validCount,
      contentHash: candidate.contentHash
    };
  }
  return {
    action: previous?.output ? "update" : "initialize",
    reason: previous?.output ? "changed" : "first-valid-version",
    validCount: candidate.validCount,
    contentHash: candidate.contentHash,
    output: candidate.output
  };
}

