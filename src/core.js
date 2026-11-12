import {
  decodeSubscription,
  isValidNode,
  normalizeNode,
  renderClashYaml
} from "./codec.js";
import { normalizeClashConfig } from "./clash.js";

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

function sortNodes(nodes) {
  return [...nodes].sort((left, right) =>
    `${left.name}\u0000${left.type}\u0000${left.server}\u0000${left.port}`.localeCompare(
      `${right.name}\u0000${right.type}\u0000${right.server}\u0000${right.port}`
    )
  );
}

function filterTerms(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[|,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesNodeNameFilter(name, options = {}) {
  const normalizedName = String(name ?? "").toLocaleLowerCase();
  const include = filterTerms(options.nodeNameInclude).map((item) => item.toLocaleLowerCase());
  const includeAll = filterTerms(options.nodeNameIncludeAll).map((item) => item.toLocaleLowerCase());
  const exclude = filterTerms(options.nodeNameExclude).map((item) => item.toLocaleLowerCase());
  if (include.length > 0 && !include.some((term) => normalizedName.includes(term))) return false;
  if (includeAll.some((term) => !normalizedName.includes(term))) return false;
  if (exclude.some((term) => normalizedName.includes(term))) return false;
  return true;
}

export function buildPreviewFromNodes(sourceNodes, options = {}) {
  const renameRules = Array.isArray(options.renameRules) ? options.renameRules : [];
  const replaceAllFields = options.replaceAllFields === true;
  const original = new Map();
  const modified = new Map();
  for (const item of Array.isArray(sourceNodes) ? sourceNodes : []) {
    const originalNode = normalizeNode(item, []);
    const modifiedNode = normalizeNode(item, renameRules, { replaceAllFields });
    if (!matchesNodeNameFilter(originalNode.name, options)) continue;
    if (!isValidNode(originalNode) || !isValidNode(modifiedNode)) continue;
    const identity = identityWithoutName(originalNode);
    original.set(identity, originalNode);
    modified.set(identity, modifiedNode);
  }
  return { original: sortNodes(original.values()), modified: sortNodes(modified.values()) };
}

export function buildPreview(rawText, options = {}) {
  return buildPreviewFromNodes(decodeSubscription(rawText), options);
}

export async function buildAggregateCandidate(nodeGroups, options = {}) {
  const requestedMinimum = Number(options.minValidNodes ?? 1);
  const minValidNodes = Number.isFinite(requestedMinimum)
    ? Math.max(1, Math.floor(requestedMinimum))
    : 1;
  const deduped = new Map();
  for (const group of Array.isArray(nodeGroups) ? nodeGroups : []) {
    for (const item of Array.isArray(group) ? group : []) {
      const node = normalizeNode(item, []);
      if (!isValidNode(node)) continue;
      deduped.set(identityWithoutName(node), node);
    }
  }
  const nodes = sortNodes(deduped.values());
  const valid = nodes.length >= minValidNodes;
  const clashConfig = normalizeClashConfig(options.clashConfig);
  const canonical = valid ? stableStringify({ nodes, clashConfig }) : null;
  const sourceContentHash = valid ? await (options.hashFn ?? sha256Hex)(stableStringify(nodes)) : null;
  const hashFn = options.hashFn ?? sha256Hex;
  const contentHash = valid ? await hashFn(canonical) : null;
  return {
    valid,
    validCount: nodes.length,
    minValidNodes,
    contentHash,
    sourceContentHash,
    nodes,
    sourceNodes: nodes,
    output: valid ? renderClashYaml(nodes, clashConfig) : null
  };
}

export async function buildCandidateFromNodes(sourceNodes, options = {}) {
  const renameRules = Array.isArray(options.renameRules) ? options.renameRules : [];
  const requestedMinimum = Number(options.minValidNodes ?? 1);
  const minValidNodes = Number.isFinite(requestedMinimum)
    ? Math.max(1, Math.floor(requestedMinimum))
    : 1;
  const sourceDeduped = new Map();
  const deduped = new Map();
  for (const item of Array.isArray(sourceNodes) ? sourceNodes : []) {
    const sourceNode = normalizeNode(item, []);
    if (!isValidNode(sourceNode)) continue;
    sourceDeduped.set(identityWithoutName(sourceNode), sourceNode);
    if (!matchesNodeNameFilter(sourceNode.name, options)) continue;
    const node = normalizeNode(sourceNode, renameRules, { replaceAllFields: options.replaceAllFields === true });
    if (!isValidNode(node)) continue;
    deduped.set(identityWithoutName(node), node);
  }
  const historicalNodes = sortNodes(sourceDeduped.values());
  const nodes = sortNodes(deduped.values());
  const valid = nodes.length >= minValidNodes;
  const clashConfig = normalizeClashConfig(options.clashConfig);
  const canonical = valid ? stableStringify({ nodes, clashConfig }) : null;
  const hashFn = options.hashFn ?? sha256Hex;
  const contentHash = valid ? await hashFn(canonical) : null;
  const sourceContentHash = historicalNodes.length > 0 ? await hashFn(stableStringify(historicalNodes)) : null;
  return {
    valid,
    validCount: nodes.length,
    sourceValidCount: historicalNodes.length,
    minValidNodes,
    contentHash,
    sourceContentHash,
    sourceNodes: historicalNodes,
    nodes,
    output: valid ? renderClashYaml(nodes, clashConfig) : null
  };
}

export async function buildCandidate(rawText, options = {}) {
  const parsed = decodeSubscription(rawText);
  return buildCandidateFromNodes(parsed, options);
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
      contentHash: candidate.contentHash,
      sourceContentHash: candidate.sourceContentHash,
      sourceNodes: candidate.sourceNodes,
      nodes: candidate.nodes
    };
  }
  return {
    action: previous?.output ? "update" : "initialize",
    reason: previous?.output ? "changed" : "first-valid-version",
    validCount: candidate.validCount,
    contentHash: candidate.contentHash,
    sourceContentHash: candidate.sourceContentHash,
    sourceNodes: candidate.sourceNodes,
    nodes: candidate.nodes,
    output: candidate.output
  };
}

