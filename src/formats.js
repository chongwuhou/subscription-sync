import { renderClashYaml } from "./codec.js";

const TARGET_ALIASES = new Map([
  ["clash", "clash"],
  ["clashmeta", "clash"],
  ["clash-meta", "clash"],
  ["mihomo", "clash"],
  ["stash", "clash"],
  ["base64", "base64"],
  ["v2ray", "base64"],
  ["v2rayn", "base64"],
  ["v2rayng", "base64"],
  ["shadowrocket", "base64"],
  ["surge", "base64"],
  ["loon", "base64"],
  ["quantumult", "base64"],
  ["quantumultx", "base64"],
  ["links", "links"],
  ["raw", "links"],
  ["sing-box", "sing-box"],
  ["singbox", "sing-box"]
]);

export const supportedTargets = ["clash", "base64", "links", "sing-box"];

export function normalizeTarget(value) {
  const key = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  return TARGET_ALIASES.get(key) ?? null;
}

export function detectTarget(request, defaultTarget = "clash") {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("target") || url.searchParams.get("format");
  if (explicit) return normalizeTarget(explicit);

  const userAgent = request.headers.get("user-agent")?.toLowerCase() ?? "";
  if (/sing[-_ ]?box/.test(userAgent)) return "sing-box";
  if (/clash|mihomo|stash/.test(userAgent)) return "clash";
  if (/shadowrocket|v2ray|nekoray|nekobox|surge|loon|quantumult|hiddify|kitsunebi/.test(userAgent)) {
    return "base64";
  }
  return normalizeTarget(defaultTarget) ?? "clash";
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hostForUrl(value) {
  const host = String(value ?? "").replace(/^\[|\]$/g, "");
  return host.includes(":") ? `[${host}]` : host;
}

function endpoint(node) {
  return `${hostForUrl(node.server)}:${node.port}`;
}

function queryString(entries) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function commonParameters(node) {
  const ws = node["ws-opts"];
  return {
    security: node.tls ? "tls" : "none",
    sni: node.sni,
    type: node.network,
    path: node.network === "ws" ? ws?.path || "/" : undefined,
    host: node.network === "ws" ? ws?.headers?.Host : undefined
  };
}

function nodeToShareLink(node) {
  const name = encodeURIComponent(node.name);
  const target = endpoint(node);
  if (node.type === "vmess") {
    const ws = node["ws-opts"];
    const payload = {
      v: "2",
      ps: node.name,
      add: node.server,
      port: String(node.port),
      id: node.uuid,
      aid: String(node.alterId ?? 0),
      scy: node.cipher || "auto",
      net: node.network || "tcp",
      type: "none",
      host: ws?.headers?.Host,
      path: ws?.path,
      tls: node.tls ? "tls" : "",
      sni: node.sni
    };
    return `vmess://${encodeBase64(JSON.stringify(payload))}`;
  }
  if (node.type === "vless") {
    return `vless://${encodeURIComponent(node.uuid)}@${target}${queryString({ encryption: "none", ...commonParameters(node) })}#${name}`;
  }
  if (node.type === "trojan") {
    return `trojan://${encodeURIComponent(node.password)}@${target}${queryString(commonParameters(node))}#${name}`;
  }
  if (node.type === "ss") {
    const credentials = `${node.cipher}:${node.password}@${target}`;
    return `ss://${encodeBase64(credentials)}#${name}`;
  }
  if (node.type === "ssr") {
    const password = encodeBase64(node.password || "");
    const remarks = encodeBase64(node.name || "");
    const body = `${node.server}:${node.port}:${node.protocol}:${node.cipher}:${node.obfs}:${password}/?remarks=${remarks}`;
    return `ssr://${encodeBase64(body)}`;
  }
  if (node.type === "hysteria" || node.type === "hysteria2") {
    const scheme = node.type === "hysteria2" ? "hysteria2" : "hysteria";
    return `${scheme}://${encodeURIComponent(node.password || "")}@${target}${queryString(commonParameters(node))}#${name}`;
  }
  if (node.type === "tuic") {
    return `tuic://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password)}@${target}${queryString(commonParameters(node))}#${name}`;
  }
  if (node.type === "anytls") {
    return `anytls://${encodeURIComponent(node.password)}@${target}/${queryString({
      sni: node.sni,
      insecure: node["skip-cert-verify"] ? "1" : undefined
    }).replace(/^\?/, "?")}#${name}`;
  }
  if (node.type === "http" || node.type === "socks5") {
    const credentials = node.username
      ? `${encodeURIComponent(node.username)}:${encodeURIComponent(node.password || "")}@`
      : "";
    return `${node.type}://${credentials}${target}#${name}`;
  }
  return null;
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, compact(item)])
    );
  }
  return value;
}

function tlsForSingBox(node) {
  if (!node.tls && !node.sni) return undefined;
  return { enabled: Boolean(node.tls), server_name: node.sni };
}

function transportForSingBox(node) {
  if (node.network !== "ws") return undefined;
  const ws = node["ws-opts"];
  return {
    type: "ws",
    path: ws?.path || "/",
    headers: ws?.headers
  };
}

function toSingBoxOutbound(node, tag) {
  const common = { tag, server: node.server, server_port: node.port };
  if (node.type === "vmess") {
    return compact({
      type: "vmess",
      ...common,
      uuid: node.uuid,
      security: node.cipher || "auto",
      alter_id: node.alterId ?? 0,
      tls: tlsForSingBox(node),
      transport: transportForSingBox(node)
    });
  }
  if (node.type === "vless") {
    return compact({ type: "vless", ...common, uuid: node.uuid, tls: tlsForSingBox(node), transport: transportForSingBox(node) });
  }
  if (node.type === "trojan") return compact({ type: "trojan", ...common, password: node.password, tls: tlsForSingBox(node) });
  if (node.type === "ss") return compact({ type: "shadowsocks", ...common, method: node.cipher, password: node.password });
  if (node.type === "hysteria") return compact({ type: "hysteria", ...common, password: node.password, tls: tlsForSingBox(node) });
  if (node.type === "hysteria2") return compact({ type: "hysteria2", ...common, password: node.password, tls: tlsForSingBox(node) });
  if (node.type === "tuic") return compact({ type: "tuic", ...common, uuid: node.uuid, password: node.password, tls: tlsForSingBox(node) });
  if (node.type === "anytls") {
    return compact({
      type: "anytls",
      ...common,
      password: node.password,
      tls: {
        enabled: true,
        server_name: node.sni,
        insecure: node["skip-cert-verify"] === true,
        alpn: node.alpn,
        utls: node["client-fingerprint"]
          ? { enabled: true, fingerprint: node["client-fingerprint"] }
          : undefined
      },
      idle_session_check_interval: node["idle-session-check-interval"],
      idle_session_timeout: node["idle-session-timeout"],
      min_idle_session: node["min-idle-session"],
      client_metadata: node["client-metadata"]
    });
  }
  if (node.type === "http") return compact({ type: "http", ...common, username: node.username, password: node.password });
  if (node.type === "socks5") return compact({ type: "socks", ...common, username: node.username, password: node.password });
  return null;
}

function renderSingBox(nodes) {
  const usedTags = new Set();
  const outbounds = [];
  for (const node of nodes) {
    let tag = node.name;
    let suffix = 2;
    while (usedTags.has(tag) || tag === "DIRECT" || tag === "PROXY") tag = `${node.name}-${suffix++}`;
    usedTags.add(tag);
    const outbound = toSingBoxOutbound(node, tag);
    if (outbound) outbounds.push(outbound);
  }
  if (outbounds.length === 0) throw new Error("No nodes can be rendered for sing-box");
  return `${JSON.stringify({
    outbounds: [
      {
        type: "urltest",
        tag: "PROXY",
        outbounds: outbounds.map((item) => item.tag),
        url: "https://www.gstatic.com/generate_204",
        interval: "5m",
        tolerance: 50,
        idle_timeout: "30m",
        interrupt_exist_connections: false
      },
      { type: "direct", tag: "DIRECT" },
      ...outbounds
    ]
  }, null, 2)}\n`;
}

export function renderSubscription(nodes, target = "clash", clashConfig) {
  const normalized = normalizeTarget(target);
  if (!normalized) throw new Error("Unsupported subscription target");
  if (normalized === "clash") return { body: renderClashYaml(nodes, clashConfig), contentType: "text/yaml; charset=utf-8" };
  const links = nodes.map(nodeToShareLink).filter(Boolean);
  if (normalized === "links") {
    if (links.length === 0) throw new Error("No nodes can be rendered as share links");
    return { body: `${links.join("\n")}\n`, contentType: "text/plain; charset=utf-8" };
  }
  if (normalized === "base64") {
    if (links.length === 0) throw new Error("No nodes can be rendered as share links");
    return { body: `${encodeBase64(links.join("\n"))}\n`, contentType: "text/plain; charset=utf-8" };
  }
  return { body: renderSingBox(nodes), contentType: "application/json; charset=utf-8" };
}


