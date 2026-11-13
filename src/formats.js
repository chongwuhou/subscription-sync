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
  ["shadowrocket", "surge"],
  ["surge", "surge"],
  ["loon", "base64"],
  ["quantumult", "base64"],
  ["quantumultx", "base64"],
  ["links", "links"],
  ["raw", "links"],
  ["sing-box", "sing-box"],
  ["singbox", "sing-box"]
]);

export const supportedTargets = ["clash", "base64", "links", "sing-box", "surge"];

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
  if (/shadowrocket|surge/.test(userAgent)) return "surge";
  if (/v2ray|nekoray|nekobox|loon|quantumult|hiddify|kitsunebi/.test(userAgent)) {
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
  const reality = node["reality-opts"] || {};
  return {
    security: node.tls ? "tls" : "none",
    sni: node.sni,
    type: node.network,
    path: node.network === "ws" ? ws?.path || "/" : undefined,
    host: node.network === "ws" ? ws?.headers?.Host : undefined,
    flow: node.flow,
    fp: node["client-fingerprint"],
    pbk: reality["public-key"] ?? reality.public_key,
    sid: reality["short-id"] ?? reality.short_id,
    allowInsecure: node["skip-cert-verify"] ? "1" : undefined,
    alpn: Array.isArray(node.alpn) ? node.alpn.join(",") : node.alpn,
    packetEncoding: node["packet-encoding"],
    upmbps: node.up,
    downmbps: node.down,
    obfs: node.obfs,
    "obfs-password": node["obfs-password"],
    congestion_control: node.congestion_controller,
    udp_relay_mode: node.udp_relay_mode,
    heartbeat: node.heartbeat,
    zero_rtt_handshake: node.zero_rtt_handshake ? "1" : undefined,
    reduce_rtt: node.reduce_rtt ? "1" : undefined
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
      sni: node.sni,
      alpn: Array.isArray(node.alpn) ? node.alpn.join(",") : node.alpn,
      fp: node["client-fingerprint"]
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
      insecure: node["skip-cert-verify"] ? "1" : undefined,
      alpn: Array.isArray(node.alpn) ? node.alpn.join(",") : node.alpn,
      fp: node["client-fingerprint"]
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
  const reality = node["reality-opts"];
  return compact({
    enabled: Boolean(node.tls),
    server_name: node.sni,
    insecure: node["skip-cert-verify"],
    alpn: node.alpn,
    utls: node["client-fingerprint"] ? { enabled: true, fingerprint: node["client-fingerprint"] } : undefined,
    reality: reality ? {
      enabled: true,
      public_key: reality["public-key"] ?? reality.public_key,
      short_id: reality["short-id"] ?? reality.short_id
    } : undefined
  });
}

function transportForSingBox(node) {
  if (node.network === "ws") {
    const ws = node["ws-opts"];
    return { type: "ws", path: ws?.path || "/", headers: ws?.headers };
  }
  if (node.network === "h2" || node.network === "http") {
    const h2 = node["h2-opts"] || {};
    return { type: "http", path: h2.path || "/", host: h2.host, headers: h2.headers };
  }
  if (node.network === "grpc") {
    return { type: "grpc", service_name: node["grpc-opts"]?.["grpc-service-name"] };
  }
  if (node.network === "httpupgrade") {
    const upgrade = node["http-upgrade-opts"] || {};
    return { type: "httpupgrade", path: upgrade.path || "/", headers: upgrade.headers };
  }
  if (node.network === "quic") return { type: "quic" };
  return undefined;
}

function toSingBoxOutbound(node, tag) {
  const common = {
    tag,
    server: node.server,
    server_port: node.port,
    domain_strategy: node["domain-strategy"],
    network_strategy: node["network-strategy"]
  };
  if (node.type === "vmess") {
    return compact({
      type: "vmess",
      ...common,
      uuid: node.uuid,
      security: node.cipher || "auto",
      alter_id: node.alterId ?? 0,
      packet_encoding: node["packet-encoding"],
      tls: tlsForSingBox(node),
      transport: transportForSingBox(node)
    });
  }
  if (node.type === "vless") {
    return compact({ type: "vless", ...common, uuid: node.uuid, flow: node.flow, packet_encoding: node["packet-encoding"], tls: tlsForSingBox(node), transport: transportForSingBox(node) });
  }
  if (node.type === "trojan") return compact({ type: "trojan", ...common, password: node.password, tls: tlsForSingBox(node), transport: transportForSingBox(node) });
  if (node.type === "ss") return compact({ type: "shadowsocks", ...common, method: node.cipher, password: node.password });
  if (node.type === "hysteria") return compact({ type: "hysteria", ...common, password: node.password, up_mbps: node.up, down_mbps: node.down, obfs: node.obfs || node["obfs-password"] ? { type: node.obfs || "salamander", password: node["obfs-password"] ?? node.obfs } : undefined, tls: tlsForSingBox(node) });
  if (node.type === "hysteria2") return compact({ type: "hysteria2", ...common, password: node.password, obfs: node.obfs || node["obfs-password"] ? { type: node.obfs || "salamander", password: node["obfs-password"] ?? node.obfs } : undefined, tls: tlsForSingBox(node) });
  if (node.type === "tuic") return compact({ type: "tuic", ...common, uuid: node.uuid, password: node.password, congestion_control: node.congestion_controller, udp_relay_mode: node.udp_relay_mode, heartbeat: node.heartbeat, zero_rtt_handshake: node.zero_rtt_handshake, reduce_rtt: node.reduce_rtt, tls: tlsForSingBox(node) });
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
  if (node.type === "wireguard") {
    return compact({
      type: "wireguard",
      ...common,
      local_address: [node.ip, node.ipv6].filter(Boolean),
      private_key: node["private-key"],
      peer_public_key: node["public-key"],
      pre_shared_key: node["pre-shared-key"],
      reserved: node.reserved,
      mtu: node.mtu
    });
  }
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

function surgeEscape(value) {
  return String(value ?? "").replace(/([\\,|])/g, "\\$1");
}

function surgeHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const values = Object.entries(headers).map(([key, value]) => `${key}:${value}`);
  return values.length > 0 ? values.join("|") : undefined;
}

function surgeCommonParameters(node) {
  const values = [];
  if (node.tls) values.push("tls=true");
  if (node.sni) values.push(`sni=${surgeEscape(node.sni)}`);
  if (node["skip-cert-verify"]) values.push("skip-cert-verify=true");
  if (node.alpn) values.push(`alpn=${surgeEscape(Array.isArray(node.alpn) ? node.alpn.join(",") : node.alpn)}`);
  if (node.network === "ws") {
    const ws = node["ws-opts"] || {};
    values.push("ws=true", `ws-path=${surgeEscape(ws.path || "/")}`);
    const headers = surgeHeaders(ws.headers);
    if (headers) values.push(`ws-headers=${surgeEscape(headers)}`);
  }
  if (node.network === "grpc" && node["grpc-opts"]?.["grpc-service-name"]) {
    values.push(`grpc-service-name=${surgeEscape(node["grpc-opts"]["grpc-service-name"])}`);
  }
  return values;
}

function surgeProxyLine(node) {
  let protocol = node.type;
  if (node.type === "socks5" && node.tls) protocol = "socks5-tls";
  if (node.type === "http" && node.tls) protocol = "https";
  if (!["http", "https", "socks5", "socks5-tls", "ss", "vmess", "vless", "trojan", "tuic", "hysteria2", "anytls", "wireguard"].includes(protocol)) return null;
  const values = [surgeEscape(node.name), protocol, surgeEscape(node.server), String(node.port)];
  if (node.type === "http" || node.type === "socks5") {
    if (node.username) values.push(`username=${surgeEscape(node.username)}`);
    if (node.password) values.push(`password=${surgeEscape(node.password)}`);
  } else if (node.type === "ss") {
    values.push(`encrypt-method=${surgeEscape(node.cipher)}`, `password=${surgeEscape(node.password)}`);
  } else if (node.type === "vmess" || node.type === "vless") {
    values.push(`username=${surgeEscape(node.uuid)}`);
    if (node.cipher && node.type === "vmess") values.push(`encrypt-method=${surgeEscape(node.cipher)}`);
    if (node.flow) values.push(`flow=${surgeEscape(node.flow)}`);
  } else if (node.type === "trojan" || node.type === "hysteria2" || node.type === "anytls") {
    values.push(`password=${surgeEscape(node.password)}`);
  } else if (node.type === "tuic") {
    values.push(`username=${surgeEscape(node.uuid)}`, `password=${surgeEscape(node.password)}`);
    if (node.congestion_controller) values.push(`congestion-controller=${surgeEscape(node.congestion_controller)}`);
    if (node.udp_relay_mode) values.push(`udp-relay-mode=${surgeEscape(node.udp_relay_mode)}`);
  } else if (node.type === "wireguard") {
    values.push(`private-key=${surgeEscape(node["private-key"])}`, `peer-public-key=${surgeEscape(node["public-key"])}`, `local-address=${surgeEscape([node.ip, node.ipv6].filter(Boolean).join(","))}`);
    if (node["pre-shared-key"]) values.push(`preshared-key=${surgeEscape(node["pre-shared-key"])}`);
  }
  values.push(...surgeCommonParameters(node));
  return values.join(", ");
}

function renderSurge(nodes, clashConfig) {
  const entries = nodes
    .map((node) => ({ node, line: surgeProxyLine(node) }))
    .filter((entry) => entry.line);
  const lines = entries.map((entry) => entry.line);
  if (lines.length === 0) throw new Error("No nodes can be rendered for Surge/Shadowrocket");
  const names = entries.map((entry) => entry.node.name);
  const rules = Array.isArray(clashConfig?.rules)
    ? clashConfig.rules
      .filter((rule) => typeof rule === "string" && !/^RULE-SET,/i.test(rule))
      .map((rule) => /^MATCH,/i.test(rule) ? `FINAL,${rule.split(",").slice(1).join(",") || "PROXY"}` : rule)
    : [];
  if (!rules.some((rule) => /^FINAL,/i.test(rule))) rules.push("FINAL,PROXY");
  return [
    "[General]",
    "test-timeout = 5",
    "",
    "[Proxy]",
    ...lines,
    "",
    "[Proxy Group]",
    `PROXY = url-test, ${names.map(surgeEscape).join(", ")}, url=https://www.gstatic.com/generate_204, interval=300, timeout=5, tolerance=50`,
    "",
    "[Rule]",
    ...rules,
    ""
  ].join("\n");
}

export function renderSubscription(nodes, target = "clash", clashConfig) {
  const normalized = normalizeTarget(target);
  if (!normalized) throw new Error("Unsupported subscription target");
  if (normalized === "clash") return { body: renderClashYaml(nodes, clashConfig), contentType: "text/yaml; charset=utf-8" };
  if (normalized === "surge") return { body: renderSurge(nodes, clashConfig), contentType: "text/plain; charset=utf-8" };
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


