const NODE_PLACEHOLDER = /^\{\{(?:NODES|ALL_NODES)\}\}$/;

export const DEFAULT_CLASH_CONFIG = Object.freeze({
  "proxy-groups": [
    {
      name: "PROXY",
      type: "url-test",
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
      lazy: false,
      proxies: ["{{NODES}}"]
    }
  ],
  "rule-providers": {},
  rules: ["MATCH,PROXY"]
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseObject(value, strict) {
  if (value === undefined || value === null || value === "") return clone(DEFAULT_CLASH_CONFIG);
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      if (strict) throw new Error("Clash 配置必须是合法 JSON");
      return clone(DEFAULT_CLASH_CONFIG);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (strict) throw new Error("Clash 配置必须是 JSON 对象");
    return clone(DEFAULT_CLASH_CONFIG);
  }
  return parsed;
}

function validateProxyGroups(value) {
  if (!Array.isArray(value)) throw new Error("proxy-groups 必须是数组");
  return value.map((group, index) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      throw new Error(`proxy-groups[${index}] 必须是对象`);
    }
    const name = String(group.name ?? "").trim();
    const type = String(group.type ?? "").trim();
    if (!name || !type) throw new Error(`proxy-groups[${index}] 需要 name 和 type`);
    if (group.proxies !== undefined && !Array.isArray(group.proxies)) {
      throw new Error(`proxy-groups[${index}].proxies 必须是数组`);
    }
    return { ...group, name, type };
  });
}

function validateRuleProviders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rule-providers 必须是对象");
  }
  return value;
}

function validateRules(value) {
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== "string" || !rule.trim())) {
    throw new Error("rules 必须是非空字符串数组");
  }
  return value.map((rule) => rule.trim());
}

export function normalizeClashConfig(value, strict = false) {
  try {
    const parsed = parseObject(value, strict);
    const groups = parsed["proxy-groups"] === undefined
      ? clone(DEFAULT_CLASH_CONFIG["proxy-groups"])
      : validateProxyGroups(parsed["proxy-groups"]);
    const providers = parsed["rule-providers"] === undefined
      ? {}
      : validateRuleProviders(parsed["rule-providers"]);
    const rules = parsed.rules === undefined
      ? ["MATCH,PROXY"]
      : validateRules(parsed.rules);
    return {
      "proxy-groups": groups,
      "rule-providers": providers,
      rules
    };
  } catch (error) {
    if (strict) throw error;
    return clone(DEFAULT_CLASH_CONFIG);
  }
}

export function normalizeAutomaticClashConfig(value, strict = false) {
  const normalized = normalizeClashConfig(value, strict);
  const groups = normalized["proxy-groups"];
  const legacyDefault = groups.length === 1
    && groups[0].name === "PROXY"
    && groups[0].type === "select"
    && Array.isArray(groups[0].proxies)
    && groups[0].proxies.length === 2
    && groups[0].proxies.includes("DIRECT")
    && groups[0].proxies.some((item) => /^\{\{(?:NODES|ALL_NODES)\}\}$/.test(String(item).trim()));
  if (!legacyDefault) return normalized;
  return {
    ...normalized,
    "proxy-groups": [{
      ...groups[0],
      type: "url-test",
      url: "https://www.gstatic.com/generate_204",
      interval: 300,
      tolerance: 50,
      lazy: false,
      proxies: ["{{NODES}}"]
    }]
  };
}

function expandNodes(value, names) {
  if (Array.isArray(value)) return value.flatMap((item) => expandNodes(item, names));
  if (typeof value === "string" && NODE_PLACEHOLDER.test(value.trim())) return names;
  return value;
}

export function expandProxyGroups(config, names) {
  return config["proxy-groups"].map((group) => ({
    ...group,
    ...(group.proxies ? { proxies: expandNodes(group.proxies, names) } : {})
  }));
}

