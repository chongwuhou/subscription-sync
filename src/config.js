function parseRenameRules(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeMinValidNodes(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : 1;
}

function normalizeProfile(item, index) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? `subscription-${index + 1}`).trim();
  const sourceUrl = String(item.sourceUrl ?? "").trim();
  const publicToken = String(item.publicToken ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!sourceUrl || !publicToken || publicToken.includes("/")) return null;
  try {
    const parsedUrl = new URL(sourceUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) return null;
  } catch {
    return null;
  }
  return {
    id,
    name: String(item.name ?? id).trim() || id,
    sourceUrl,
    publicToken,
    renameRules: Array.isArray(item.renameRules) ? item.renameRules : [],
    replaceAllFields: item.replaceAllFields === true,
    minValidNodes: normalizeMinValidNodes(item.minValidNodes ?? 1),
    defaultTarget: String(item.defaultTarget ?? "clash").trim() || "clash"
  };
}

function parseProfiles(value, strict = false) {
  let raw;
  try {
    raw = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return strict ? { profiles: null, error: "SUBSCRIPTIONS_JSON must be valid JSON" } : [];
  }
  if (!Array.isArray(raw)) {
    return strict ? { profiles: null, error: "subscriptions must be an array" } : [];
  }
  const profiles = [];
  const ids = new Set();
  const tokens = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const profile = normalizeProfile(raw[index], index);
    if (!profile) {
      if (strict) return { profiles: null, error: `invalid subscription at index ${index}` };
      continue;
    }
    if (ids.has(profile.id) || tokens.has(profile.publicToken)) {
      if (strict) return { profiles: null, error: `duplicate id or publicToken at index ${index}` };
      continue;
    }
    ids.add(profile.id);
    tokens.add(profile.publicToken);
    profiles.push(profile);
  }
  return strict ? { profiles, error: null } : profiles;
}

export function parseSubscriptionProfilesJson(value) {
  return parseProfiles(value, false);
}

export function validateSubscriptionProfiles(value) {
  return parseProfiles(value, true);
}

export function parseSubscriptionProfiles(env) {
  if (env.SUBSCRIPTIONS_JSON) {
    return parseSubscriptionProfilesJson(env.SUBSCRIPTIONS_JSON);
  }

  if (!env.SOURCE_URL || !env.PUBLIC_PATH_TOKEN) return [];
  return [{
    id: "default",
    name: "default",
    sourceUrl: env.SOURCE_URL,
    publicToken: env.PUBLIC_PATH_TOKEN,
    renameRules: parseRenameRules(env.RENAME_RULES_JSON),
    replaceAllFields: String(env.REPLACE_ALL_FIELDS ?? "").toLowerCase() === "true",
    minValidNodes: normalizeMinValidNodes(env.MIN_VALID_NODES ?? 1),
    defaultTarget: String(env.DEFAULT_TARGET ?? "clash").trim() || "clash"
  }];
}

export function stateKey(profileId) {
  return `published-state-v1:${profileId}`;
}

