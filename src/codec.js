import { expandProxyGroups, normalizeClashConfig } from "./clash.js";

const SUPPORTED_TYPES = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "tuic",
  "anytls",
  "socks5",
  "http"
]);

const SHARE_SCHEMES = [
  "vmess",
  "vless",
  "trojan",
  "ss",
  "ssr",
  "hysteria",
  "hysteria2",
  "hy2",
  "tuic",
  "socks5",
  "http"
];

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeBase64(text) {
  const normalized = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return null;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeBase64(text) {
  return text.length >= 8 && /^[A-Za-z0-9+/_=-]+$/.test(text) && !text.includes("://");
}

function stripYamlComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === '"') && value[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trim();
}

function splitTopLevel(text, delimiter = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ((character === "'" || character === '"') && text[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    }
    if (quote !== null) continue;
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === delimiter && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function splitKeyValue(text) {
  let quote = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ((character === "'" || character === '"') && text[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
    }
    if (quote !== null) continue;
    if (character === "[" || character === "{") depth += 1;
    if (character === "]" || character === "}") depth -= 1;
    if (character === ":" && depth === 0) {
      const key = text.slice(0, index).trim();
      if (/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(key)) {
        return [key, text.slice(index + 1).trim()];
      }
    }
  }
  return null;
}

function parseFlowMap(value) {
  const body = value.slice(1, -1).trim();
  const result = {};
  for (const part of splitTopLevel(body)) {
    const pair = splitKeyValue(part);
    if (!pair) continue;
    result[pair[0]] = parseScalar(pair[1]);
  }
  return result;
}

function parseScalar(value) {
  const clean = stripYamlComment(value);
  if (clean === "") return {};
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    if (clean.startsWith('"')) {
      try {
        return JSON.parse(clean);
      } catch {
        return clean.slice(1, -1);
      }
    }
    return clean.slice(1, -1).replace(/''/g, "'");
  }
  if (clean.startsWith("{") && clean.endsWith("}")) return parseFlowMap(clean);
  if (clean.startsWith("[") && clean.endsWith("]")) {
    return splitTopLevel(clean.slice(1, -1)).map((item) => parseScalar(item));
  }
  if (/^(true|false)$/i.test(clean)) return clean.toLowerCase() === "true";
  if (/^(null|~)$/i.test(clean)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(clean)) return Number(clean);
  return clean;
}

function indentOf(line) {
  return (line.match(/^\s*/) ?? [""])[0].replace(/\t/g, "  ").length;
}

export function parseClashYaml(text) {
  const lines = text.split(/\r?\n/);
  let proxiesIndent = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)proxies\s*:\s*$/);
    if (match) {
      proxiesIndent = match[1].replace(/\t/g, "  ").length;
      start = index + 1;
      break;
    }
  }
  if (start < 0) throw new Error("Clash YAML does not contain a proxies section");

  const nodes = [];
  let itemIndent = null;
  let current = null;
  let stack = [];
  const commit = () => {
    if (current && Object.keys(current).length > 0) nodes.push(current);
    current = null;
    stack = [];
  };

  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(raw);
    if (indent <= proxiesIndent && !trimmed.startsWith("-")) {
      break;
    }

    const listMatch = raw.match(/^\s*-\s*(.*)$/);
    if (listMatch && (itemIndent === null || indent === itemIndent)) {
      itemIndent ??= indent;
      if (indent !== itemIndent) continue;
      commit();
      current = {};
      stack = [{ indent: itemIndent - 1, object: current }];
      const first = listMatch[1].trim();
      if (first) {
        const pair = splitKeyValue(first);
        if (pair) current[pair[0]] = parseScalar(pair[1]);
        else if (first.startsWith("{") && first.endsWith("}")) {
          current = parseFlowMap(first);
          stack = [{ indent: itemIndent - 1, object: current }];
        }
      }
      continue;
    }

    if (!current || indent <= proxiesIndent) continue;
    const pair = splitKeyValue(trimmed);
    if (!pair) continue;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).object;
    if (pair[1] === "") {
      const child = {};
      parent[pair[0]] = child;
      stack.push({ indent, object: child });
    } else {
      parent[pair[0]] = parseScalar(pair[1]);
    }
  }
  commit();
  return nodes;
}

function parseHostPort(value) {
  const parsed = new URL(`http://${value}`);
  return { server: parsed.hostname, port: Number(parsed.port) };
}

function parseCommonUrl(link, type) {
  const url = new URL(link);
  const query = url.searchParams;
  const node = {
    name: decodeURIComponentSafe(url.hash.slice(1)) || `${type}-${url.hostname}`,
    type,
    server: url.hostname,
    port: Number(url.port),
    tls: query.get("security") === "tls" || query.get("tls") === "1" || type === "trojan",
    sni: query.get("sni") || query.get("peer") || undefined
  };
  const username = decodeURIComponentSafe(url.username);
  const password = decodeURIComponentSafe(url.password);
  if (type === "vless") node.uuid = username;
  if (type === "trojan" || type === "hysteria" || type === "hysteria2") node.password = username || password;
  if (type === "tuic") {
    node.uuid = username;
    node.password = password;
  }
  const network = query.get("type") || query.get("network");
  if (network) node.network = network;
  if (network === "ws") {
    node["ws-opts"] = {
      path: query.get("path") || "/",
      headers: query.get("host") ? { Host: query.get("host") } : undefined
    };
  }
  return node;
}

function parseVmess(link) {
  const body = link.slice("vmess://".length).split("#")[0];
  const decoded = decodeBase64(body);
  if (!decoded) throw new Error("Invalid VMess Base64 payload");
  const data = JSON.parse(decoded);
  const node = {
    name: decodeURIComponentSafe(link.split("#")[1] || data.ps || `vmess-${data.add}`),
    type: "vmess",
    server: data.add,
    port: Number(data.port),
    uuid: data.id,
    alterId: Number(data.aid || 0),
    cipher: data.scy || "auto",
    tls: data.tls === "tls" || data.tls === true,
    network: data.net || undefined,
    sni: data.sni || undefined
  };
  if (node.network === "ws") {
    node["ws-opts"] = {
      path: data.path || "/",
      headers: data.host ? { Host: data.host } : undefined
    };
  }
  return node;
}

function parseShadowsocks(link) {
  const withoutScheme = link.slice("ss://".length);
  const hashIndex = withoutScheme.indexOf("#");
  const fragment = hashIndex >= 0 ? withoutScheme.slice(hashIndex + 1) : "";
  const body = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
  let decodedBody = body;
  if (!body.includes("@")) decodedBody = decodeBase64(body) || body;
  const at = decodedBody.lastIndexOf("@");
  if (at < 0) throw new Error("Invalid Shadowsocks link");
  const credentials = decodedBody.slice(0, at);
  const endpoint = decodedBody.slice(at + 1).split("?")[0];
  const colon = credentials.indexOf(":");
  if (colon < 0) throw new Error("Invalid Shadowsocks credentials");
  const location = parseHostPort(endpoint);
  return {
    name: decodeURIComponentSafe(fragment) || `ss-${location.server}`,
    type: "ss",
    server: location.server,
    port: location.port,
    cipher: credentials.slice(0, colon),
    password: credentials.slice(colon + 1)
  };
}

function parseShadowsocksR(link) {
  const body = link.slice("ssr://".length).split("?")[0];
  const decoded = decodeBase64(body);
  if (!decoded) throw new Error("Invalid SSR Base64 payload");
  const [endpoint, queryText = ""] = decoded.split("/?");
  const parts = endpoint.split(":");
  if (parts.length < 6) throw new Error("Invalid SSR payload");
  const query = new URLSearchParams(queryText);
  const password = decodeBase64(parts.slice(5).join(":")) || parts.slice(5).join(":");
  return {
    name: decodeBase64(query.get("remarks") || "") || `ssr-${parts[0]}`,
    type: "ssr",
    server: parts[0],
    port: Number(parts[1]),
    protocol: parts[2],
    cipher: parts[3],
    obfs: parts[4],
    password
  };
}

export function parseShareLink(link) {
  const trimmed = link.trim();
  const scheme = trimmed.split(":", 1)[0].toLowerCase();
  if (scheme === "vmess") return parseVmess(trimmed);
  if (scheme === "ss") return parseShadowsocks(trimmed);
  if (scheme === "ssr") return parseShadowsocksR(trimmed);
  if (scheme === "hy2") return parseCommonUrl(trimmed.replace(/^hy2:/i, "hysteria2:"), "hysteria2");
  if (scheme === "vless" || scheme === "trojan" || scheme === "hysteria" || scheme === "hysteria2" || scheme === "tuic") {
    return parseCommonUrl(trimmed, scheme);
  }
  if (scheme === "socks5" || scheme === "http") {
    const url = new URL(trimmed);
    return {
      name: decodeURIComponentSafe(url.hash.slice(1)) || `${scheme}-${url.hostname}`,
      type: scheme,
      server: url.hostname,
      port: Number(url.port),
      username: decodeURIComponentSafe(url.username) || undefined,
      password: decodeURIComponentSafe(url.password) || undefined
    };
  }
  throw new Error(`Unsupported share-link scheme: ${scheme}`);
}

function fromJsonPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.proxies)) return payload.proxies;
  if (Array.isArray(payload.outbounds)) {
    return payload.outbounds
      .filter((item) => item && !["direct", "block", "dns", "selector", "urltest", "reject"].includes(item.type))
      .map((item) => {
        const type = {
          shadowsocks: "ss",
          socks: "socks5"
        }[item.type] || item.type;
        const node = {
          name: item.tag || `${type}-${item.server || "node"}`,
          type,
          server: item.server,
          port: item.server_port,
          uuid: item.uuid,
          password: item.password,
          method: item.method,
          cipher: item.method,
          tls: Boolean(item.tls?.enabled),
          sni: item.tls?.server_name
        };
        return node;
      });
  }
  throw new Error("JSON subscription does not contain proxies or supported outbounds");
}

export function decodeSubscription(input) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("Subscription response is empty");

  if (text.startsWith("{") || text.startsWith("[")) {
    return fromJsonPayload(JSON.parse(text));
  }
  if (/^\s*proxies\s*:/m.test(text)) return parseClashYaml(text);

  const links = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => SHARE_SCHEMES.some((scheme) => line.toLowerCase().startsWith(`${scheme}://`)));
  if (links.length > 0) {
    const parsed = [];
    for (const link of links) {
      try {
        parsed.push(parseShareLink(link));
      } catch {
        // Unsupported or malformed links are ignored; the update gate will
        // reject the whole candidate when no valid nodes remain.
      }
    }
    return parsed;
  }

  if (looksLikeBase64(text)) {
    const decoded = decodeBase64(text);
    if (decoded && decoded !== text) return decodeSubscription(decoded);
  }
  throw new Error("Unsupported subscription format");
}

export function applyRename(name, renameRules = []) {
  let result = String(name ?? "").trim();
  const rules = Array.isArray(renameRules)
    ? renameRules.reduce((items, rule) => items.concat(Array.isArray(rule) ? rule : [rule]), [])
    : [];
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== "string") continue;
    try {
      const flags = typeof rule.flags === "string" ? rule.flags : "g";
      result = result.replace(new RegExp(rule.pattern, flags), String(rule.replacement ?? ""));
    } catch {
      // Invalid operator-supplied rules are ignored instead of breaking a refresh.
    }
  }
  return result.trim();
}

function replaceTextFields(value, renameRules) {
  if (typeof value === "string") return applyRename(value, renameRules);
  if (Array.isArray(value)) return value.map((item) => replaceTextFields(item, renameRules));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTextFields(item, renameRules)]));
  }
  return value;
}

export function normalizeNode(input, renameRules = [], options = {}) {
  const node = { ...input };
  const replaceAllFields = options.replaceAllFields === true;
  if (replaceAllFields) {
    Object.assign(node, replaceTextFields(node, renameRules));
  }
  node.type = String(node.type ?? "").toLowerCase();
  node.server = String(node.server ?? "").trim();
  node.port = Number(node.port);
  const fallbackName = `${node.type}-${node.server}`;
  node.name = replaceAllFields
    ? String(node.name ?? fallbackName).trim() || fallbackName
    : applyRename(node.name || fallbackName, renameRules) || fallbackName;
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined));
}

export function isValidNode(node) {
  if (!node || typeof node !== "object") return false;
  if (!SUPPORTED_TYPES.has(node.type)) return false;
  if (!node.server || !Number.isInteger(Number(node.port)) || Number(node.port) < 1 || Number(node.port) > 65535) return false;
  if (["vmess", "vless", "tuic"].includes(node.type) && !node.uuid) return false;
  if (["trojan", "hysteria2", "anytls"].includes(node.type) && !node.password) return false;
  if (node.type === "ss" && (!node.cipher || !node.password)) return false;
  return true;
}

function yamlScalar(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  const text = String(value);
  if (/^[A-Za-z0-9._/@:+-]+$/.test(text) && !/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return text;
  return JSON.stringify(text);
}

function renderYaml(value, indent = 0) {
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const nested = renderYaml(item, indent + 2);
          return `${padding}-\n${nested}`;
        }
        return `${padding}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        if (item !== null && typeof item === "object") {
          return `${padding}${key}:\n${renderYaml(item, indent + 2)}`;
        }
        return `${padding}${key}: ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  return `${padding}${yamlScalar(value)}`;
}

export function renderClashYaml(nodes, clashConfig) {
  const names = nodes.map((node) => node.name);
  const normalized = normalizeClashConfig(clashConfig);
  const config = {
    proxies: nodes,
    "proxy-groups": expandProxyGroups(normalized, names),
    rules: normalized.rules
  };
  if (Object.keys(normalized["rule-providers"]).length > 0) {
    config["rule-providers"] = normalized["rule-providers"];
  }
  return `${renderYaml(config)}\n`;
}

export const supportedTypes = [...SUPPORTED_TYPES];

