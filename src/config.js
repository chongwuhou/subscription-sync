function parseRenameRules(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeProfile(item, index) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? `subscription-${index + 1}`).trim();
  const sourceUrl = String(item.sourceUrl ?? "").trim();
  const publicToken = String(item.publicToken ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (!sourceUrl || !publicToken || publicToken.includes("/")) return null;
  return {
    id,
    name: String(item.name ?? id).trim() || id,
    sourceUrl,
    publicToken,
    renameRules: Array.isArray(item.renameRules) ? item.renameRules : [],
    minValidNodes: Math.max(1, Number(item.minValidNodes ?? 1))
  };
}

export function parseSubscriptionProfiles(env) {
  if (env.SUBSCRIPTIONS_JSON) {
    try {
      const raw = JSON.parse(env.SUBSCRIPTIONS_JSON);
      if (!Array.isArray(raw)) return [];
      const profiles = [];
      const ids = new Set();
      const tokens = new Set();
      for (let index = 0; index < raw.length; index += 1) {
        const profile = normalizeProfile(raw[index], index);
        if (!profile || ids.has(profile.id) || tokens.has(profile.publicToken)) continue;
        ids.add(profile.id);
        tokens.add(profile.publicToken);
        profiles.push(profile);
      }
      return profiles;
    } catch {
      return [];
    }
  }

  if (!env.SOURCE_URL || !env.PUBLIC_PATH_TOKEN) return [];
  return [{
    id: "default",
    name: "default",
    sourceUrl: env.SOURCE_URL,
    publicToken: env.PUBLIC_PATH_TOKEN,
    renameRules: parseRenameRules(env.RENAME_RULES_JSON),
    minValidNodes: Math.max(1, Number(env.MIN_VALID_NODES ?? 1))
  }];
}

export function stateKey(profileId) {
  return `published-state-v1:${profileId}`;
}

