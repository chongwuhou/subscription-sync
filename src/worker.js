import { buildAggregateCandidate, buildCandidate, buildCandidateFromNodes, buildPreview, buildPreviewFromNodes, decidePublication } from "./core.js";
import {
  buildExpiredDisplayNodes,
  normalizeExpiredSubscription,
  parseSubscriptionProfiles,
  parseSubscriptionProfilesJson,
  stateKey,
  validateSubscriptionProfiles
} from "./config.js";
import { decodeSubscription } from "./codec.js";
import { detectTarget, renderSubscription, supportedTargets } from "./formats.js";
import { normalizeAutomaticClashConfig } from "./clash.js";

// Expired aggregate links are rendered with universal display-only VMess placeholders.
const DEFAULT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const ADMIN_CONFIG_KEY = "subscription-config-v1";
const ADMIN_SETTINGS_KEY = "subscription-settings-v1";
const ADMIN_EXPIRED_KEY = "subscription-expired-v1";
const AGGREGATE_PUBLIC_TOKEN_KEY = "subscription-aggregate-config-v1";
const AGGREGATE_STATE_ID = "__all__";
const LAST_REFRESH_KEY = "subscription-refresh-meta-v1";
const CONTROL_PROFILES_KEY = "profiles";
const CONTROL_SETTINGS_KEY = "settings";
const CONTROL_EXPIRED_KEY = "expired-subscription";
const CONTROL_AGGREGATE_TOKEN_KEY = "aggregate-public-token";
const DEFAULT_REFRESH_INTERVAL_MINUTES = 30;
let sourceSnapshotSchemaPromise = null;
let controlPlaneSchemaPromise = null;

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Subscription Sync 管理</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 980px; margin: 2rem auto; padding: 0 1rem; }
    fieldset { margin: 1rem 0; border: 1px solid #8885; border-radius: 8px; }
    label { display: block; margin: .65rem 0; font-weight: 600; }
    input, textarea { display: block; box-sizing: border-box; width: 100%; margin-top: .3rem; padding: .55rem; font: inherit; }
    textarea { min-height: 3.2rem; font-family: ui-monospace, monospace; }
    .check-label { display: flex; align-items: center; gap: .5rem; }
    .check-label input { width: auto; margin: 0; }
    button { margin: .35rem .5rem .35rem 0; padding: .55rem .8rem; font: inherit; cursor: pointer; }
    #status { min-height: 1.5rem; white-space: pre-wrap; }
    .muted { opacity: .75; }
    .notice { padding: .7rem .9rem; border-radius: 6px; background: #16803c18; border: 1px solid #16803c55; }
    .rules-help { margin: .4rem 0 1rem; padding: .6rem .8rem; border: 1px solid #8885; border-radius: 6px; }
    .rules-help summary { cursor: pointer; font-weight: 600; }
    .rules-help pre { overflow-x: auto; white-space: pre-wrap; font-size: .9rem; }
    .rules-help code { font-family: ui-monospace, monospace; }
    .profile-card { margin: 1rem 0; padding: .45rem .8rem; border: 1px solid #8885; border-radius: 8px; }
    .profile-card > summary { cursor: pointer; font-weight: 700; padding: .25rem 0; }
    .profile-card fieldset { margin: .5rem 0 0; padding: 0; border: 0; }
    .preview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; margin: .8rem 0; }
    .preview-pane { border: 1px solid #8885; border-radius: 6px; padding: .6rem; min-width: 0; }
    .preview-pane h3 { margin: 0 0 .4rem; font-size: 1rem; }
    .preview-pane ul { margin: 0; padding-left: 1.2rem; max-height: 16rem; overflow: auto; }
    .filter-rules { margin: .8rem 0; padding: .7rem; border: 1px solid #8885; border-radius: 6px; }
    .filter-rules-title { font-weight: 600; margin-bottom: .5rem; }
    .history-panel { margin: .8rem 0; padding: .65rem .75rem; border: 1px solid #8885; border-radius: 6px; }
    .history-panel > summary { cursor: pointer; font-weight: 600; }
    .history-version-row { display: flex; align-items: center; justify-content: space-between; gap: .8rem; margin: .55rem 0 0; padding: .55rem; border: 1px solid #8884; border-radius: 5px; }
    .history-version-meta { min-width: 0; }
    .history-version-meta strong { display: block; }
    .history-version-meta small { display: block; margin-top: .15rem; opacity: .75; overflow-wrap: anywhere; }
    .history-version-row button { flex: 0 0 auto; margin: 0; }
    .status-panel { margin: .7rem 0; padding: .65rem .8rem; border: 1px solid #8885; border-radius: 6px; background: color-mix(in srgb, Canvas 94%, #16803c 6%); }
    .status-panel strong { display: block; margin-bottom: .25rem; }
    .status-panel small { display: block; opacity: .78; line-height: 1.45; }
    .rename-rules { margin: .8rem 0; padding: .7rem; border: 1px solid #8885; border-radius: 6px; }
    .rename-rules-title { font-weight: 600; margin-bottom: .5rem; }
    .rename-rule-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto auto; gap: .45rem; align-items: end; margin: .45rem 0; }
    .rename-rule-row label { margin: 0; }
    .rename-rule-row input[type="checkbox"] { width: auto; }
    .rename-rule-row .remove-rule { margin: 0; }
    @media (max-width: 720px) { .rename-rule-row { grid-template-columns: 1fr; } }
    @media (max-width: 720px) { .preview-grid { grid-template-columns: 1fr; } }
    .actions-bottom { position: sticky; bottom: 0; margin: 1rem 0 3rem; padding: .7rem; background: Canvas; border: 1px solid #8885; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>Subscription Sync 管理</h1>
  <p class="muted">管理源头订阅地址、节点过滤、节点改名规则、最低有效节点数和客户端输出格式。配置以受保护的 Cloudflare D1 为准，KV 只作兼容缓存，不保存在浏览器。</p>
  <p><button id="login">输入管理员令牌</button> <button id="reload" disabled>重新读取</button> <button id="save" disabled>保存订阅配置</button> <button id="refresh" disabled>立即刷新</button> <button id="add" disabled>新增订阅</button></p>
  <label>自动刷新间隔（分钟，5-1440，按 5 分钟粒度）<input id="interval" type="number" min="5" max="1440" step="5" value="30" disabled></label>
  <p class="notice">保存后，订阅配置、改名规则、Clash 分流配置和刷新间隔以 Cloudflare D1 为最终来源，并同步 KV 兼容缓存；源订阅节点在下一次定时刷新或点击“立即刷新”后更新。源站临时不可用时使用 D1 最近一次有效快照并重新套用当前规则。只有管理员令牌可以读取源地址。</p>
  <div id="status"></div>
  <div id="clash-settings"></div>
  <div id="aggregate"></div>
  <div id="profiles"></div>
  <div class="actions-bottom"><button id="save-bottom" disabled>保存订阅配置</button><span class="muted"> 保存后会保留在 Cloudflare KV</span></div>
  <script>
    const state = {
      token: "",
      profiles: [],
      aggregatePublicToken: "",
      expiredSubscription: { tokens: [], nodeNames: ["订阅已过期", "请联系顾问", "续费后恢复"] },
      refreshIntervalMinutes: 30,
      clashConfig: {
        "proxy-groups": [{ name: "PROXY", type: "url-test", url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50, lazy: false, proxies: ["{{NODES}}"] }],
        "rule-providers": {},
        rules: ["MATCH,PROXY"]
      },
      aggregateCustomNodes: [],
      aggregateCustomNodePosition: "tail",
      aggregateStatus: null,
      controlPlane: ""
    };
    const status = document.getElementById("status");
    const aggregateRoot = document.getElementById("aggregate");
    const clashSettingsRoot = document.getElementById("clash-settings");
    const root = document.getElementById("profiles");
    const interval = document.getElementById("interval");
    const buttons = ["reload", "save", "save-bottom", "refresh", "add"].map((id) => document.getElementById(id));
    const setStatus = (text) => { status.textContent = text || ""; };
    const setEnabled = (enabled) => buttons.forEach((button) => { button.disabled = !enabled; });
    async function api(path, options) {
      const headers = Object.assign({}, options && options.headers, { Authorization: "Bearer " + state.token });
      const response = await fetch(path, Object.assign({}, options, { headers }));
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!response.ok) throw new Error(data && data.error ? data.error : "请求失败 " + response.status);
      return data;
    }
    function addField(parent, key, label, value, type, placeholder) {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
      if (type && type !== "textarea") input.type = type;
      input.dataset.field = key;
      input.value = value == null ? "" : String(value);
      if (placeholder) input.placeholder = placeholder;
      wrapper.appendChild(input);
      parent.appendChild(wrapper);
      return input;
    }
    function addCheckbox(parent, key, label, checked) {
      const wrapper = document.createElement("label");
      wrapper.className = "check-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.field = key;
      input.checked = checked === true;
      wrapper.appendChild(input);
      wrapper.appendChild(document.createTextNode(label));
      parent.appendChild(wrapper);
      return input;
    }
    function addSelect(parent, key, label, value, options) {
      const wrapper = document.createElement("label");
      wrapper.textContent = label;
      const select = document.createElement("select");
      select.dataset.field = key;
      options.forEach((option) => {
        const item = document.createElement("option");
        item.value = option.value;
        item.textContent = option.label;
        item.selected = option.value === value;
        select.appendChild(item);
      });
      wrapper.appendChild(select);
      parent.appendChild(wrapper);
      return select;
    }
    function publicLinkFor(token) {
      return token ? location.origin + "/sub/" + encodeURIComponent(token) : "";
    }
    function publicTokenFromLink(value, index) {
      const text = value.trim();
      if (!text) return "";
      if (/^[A-Za-z0-9_-]{1,128}$/.test(text)) return text;
      let parsed;
      try { parsed = new URL(text, location.origin); } catch { throw new Error("订阅 " + (index + 1) + " 的输出地址不是合法 URL"); }
      if (parsed.origin !== location.origin || parsed.search || parsed.hash || !parsed.pathname.startsWith("/sub/")) {
        throw new Error("订阅 " + (index + 1) + " 的输出地址只能修改 /sub/ 后面的路径，域名不能改");
      }
      const token = decodeURIComponent(parsed.pathname.slice("/sub/".length));
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) throw new Error("订阅 " + (index + 1) + " 的输出地址路径只能使用字母、数字、下划线和短横线");
      return token;
    }
    function flattenRenameRules(value) {
      if (Array.isArray(value)) return value.flatMap(flattenRenameRules);
      return value && typeof value === "object" ? [value] : [];
    }
    function renderRenameRulesEditor(parent, rules) {
      const editor = document.createElement("section");
      editor.className = "rename-rules";
      editor.dataset.renameRulesEditor = "true";
      const title = document.createElement("div");
      title.className = "rename-rules-title";
      title.textContent = "节点改名规则（按顺序执行）";
      editor.appendChild(title);
      const rows = document.createElement("div");
      rows.className = "rename-rule-rows";
      const addRow = (rule = {}) => {
        const row = document.createElement("div");
        row.className = "rename-rule-row";
        const patternLabel = document.createElement("label");
        patternLabel.textContent = "查找";
        const pattern = document.createElement("input");
        pattern.dataset.renameField = "pattern";
        pattern.value = rule.pattern == null ? "" : String(rule.pattern);
        pattern.placeholder = "例如：网址:nnbin.com";
        patternLabel.appendChild(pattern);
        row.appendChild(patternLabel);
        const replacementLabel = document.createElement("label");
        replacementLabel.textContent = "替换为";
        const replacement = document.createElement("input");
        replacement.dataset.renameField = "replacement";
        replacement.value = rule.replacement == null ? "" : String(rule.replacement);
        replacement.placeholder = "留空表示删除";
        replacementLabel.appendChild(replacement);
        row.appendChild(replacementLabel);
        const regexLabel = document.createElement("label");
        regexLabel.className = "check-label";
        const regex = document.createElement("input");
        regex.type = "checkbox";
        regex.dataset.renameField = "regex";
        regex.checked = rule.literal !== true;
        regexLabel.appendChild(regex);
        regexLabel.appendChild(document.createTextNode("正则模式"));
        row.appendChild(regexLabel);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove-rule";
        remove.textContent = "删除";
        remove.onclick = () => { row.remove(); };
        row.appendChild(remove);
        rows.appendChild(row);
      };
      const initialRules = flattenRenameRules(rules);
      (initialRules.length > 0 ? initialRules : [{}]).forEach(addRow);
      editor.appendChild(rows);
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "添加一行规则";
      add.onclick = () => addRow();
      editor.appendChild(add);
      const help = document.createElement("p");
      help.className = "muted";
      help.textContent = "默认按普通文字匹配，不需要转义；只有勾选“正则模式”时才按 JavaScript 正则匹配。替换为留空就是删除。";
      editor.appendChild(help);
      parent.appendChild(editor);
      return editor;
    }
    function collectRenameRules(editor, index) {
      const result = [];
      editor.querySelectorAll(".rename-rule-row").forEach((row, rowIndex) => {
        const pattern = row.querySelector("[data-rename-field='pattern']").value;
        const replacement = row.querySelector("[data-rename-field='replacement']").value;
        const regex = row.querySelector("[data-rename-field='regex']").checked;
        if (!pattern && !replacement) return;
        if (!pattern) throw new Error("订阅 " + (index + 1) + " 的第 " + (rowIndex + 1) + " 条规则还没有填写查找内容");
        result.push(regex ? { pattern, replacement, flags: "g" } : { pattern, replacement, literal: true });
      });
      return result;
    }
    function renderPreviewPane(parent, title, nodes) {
      const pane = document.createElement("section");
      pane.className = "preview-pane";
      const heading = document.createElement("h3");
      heading.textContent = title + "（" + nodes.length + " 个节点）";
      pane.appendChild(heading);
      const list = document.createElement("ul");
      nodes.forEach((node) => {
        const item = document.createElement("li");
        item.textContent = node.name + " · " + node.type + " · " + node.server + ":" + node.port;
        list.appendChild(item);
      });
      pane.appendChild(list);
      parent.appendChild(pane);
    }
    function formatDate(value) {
      if (!value) return "暂无";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }
    function renderStatusPanel(parent, title, status, extra = "") {
      const panel = document.createElement("section");
      panel.className = "status-panel";
      const heading = document.createElement("strong");
      heading.textContent = title;
      panel.appendChild(heading);
      const detail = document.createElement("small");
      const value = status || {};
      detail.textContent = "最近处理：" + formatDate(value.lastRefreshAt) + " · " + (value.lastAction || "暂无") + (value.lastReason ? "（" + value.lastReason + "）" : "") + " · 有效节点：" + Number(value.lastValidCount || 0) + (extra ? " · " + extra : "");
      panel.appendChild(detail);
      const source = document.createElement("small");
      source.textContent = "最近有效源：" + formatDate(value.sourceSnapshotAt) + (value.publishedAt ? " · 最近发布：" + formatDate(value.publishedAt) : "");
      panel.appendChild(source);
      parent.appendChild(panel);
    }
    function renderAggregate() {
      aggregateRoot.replaceChildren();
      const card = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = "全部订阅汇总";
      card.appendChild(legend);
      const link = addField(card, "aggregateLink", "汇总后的通用订阅地址（所有已发布有效节点，一键订阅）", publicLinkFor(state.aggregatePublicToken), "url", location.origin + "/sub/汇总地址");
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "复制汇总地址";
      copy.onclick = async () => {
        const text = link.value.trim();
        if (!text) { setStatus("请先保存订阅配置，系统会生成汇总地址"); return; }
        try {
          await navigator.clipboard.writeText(text);
          setStatus("已复制全部订阅汇总地址");
        } catch {
          link.focus();
          link.select();
          setStatus("浏览器禁止自动复制，请按 Ctrl+C 复制已选中的汇总地址");
        }
      };
      card.appendChild(copy);
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "汇总地址会合并所有源头订阅的已发布有效节点；某个源头失效时保留它上一次的有效版本。修改 /sub/ 后面的路径后点击保存即可。";
      card.appendChild(note);
      renderStatusPanel(card, "汇总运行状态", state.aggregateStatus, "控制面：" + (state.controlPlane === "d1" ? "D1 权威" : "兼容回退"));
      addField(
        card,
        "aggregateCustomNodes",
        "汇总自定义节点（每行一个完整节点链接）",
        (state.aggregateCustomNodes || []).join("\\n"),
        "textarea",
        "例如：vless://...#备用节点"
      );
      addSelect(card, "aggregateCustomNodePosition", "自定义节点位置", state.aggregateCustomNodePosition || "tail", [
        { value: "top", label: "顶部" },
        { value: "tail", label: "尾部" }
      ]);
      const customNote = document.createElement("p");
      customNote.className = "muted";
      customNote.textContent = "支持常见 vmess、vless、trojan、ss、ssr、hysteria2、tuic、anytls、socks5、http 节点链接；每行一个。只加入汇总订阅，不会加入单独订阅。";
      card.appendChild(customNote);
      aggregateRoot.appendChild(card);

      const expiredCard = document.createElement("fieldset");
      const expiredLegend = document.createElement("legend");
      expiredLegend.textContent = "已过期的旧汇总地址";
      expiredCard.appendChild(expiredLegend);
      const expiredLinks = addField(
        expiredCard,
        "expiredLinks",
        "旧汇总订阅地址（每行一个；这些地址只显示过期提示节点）",
        (state.expiredSubscription.tokens || []).map(publicLinkFor).join("\\n"),
        "textarea",
        "把旧的汇总地址粘贴到这里"
      );
      const expiredNames = Array.isArray(state.expiredSubscription.nodeNames)
        ? state.expiredSubscription.nodeNames
        : ["订阅已过期", "请联系顾问", "续费后恢复"];
      [0, 1, 2].forEach((index) => addField(
        expiredCard,
        "expiredName" + index,
        "过期提示节点 " + (index + 1) + " 名称",
        expiredNames[index] || ["订阅已过期", "请联系顾问", "续费后恢复"][index],
        "text",
        ["例如：订阅已过期", "例如：请联系顾问", "例如：续费后恢复"][index]
      ));
      const expiredNote = document.createElement("p");
      expiredNote.className = "muted";
      expiredNote.textContent = "操作顺序：先把上面的汇总地址改成新地址，再把旧地址粘贴到这里，最后点击保存。旧地址会继续有效，但只返回这 3 个提示名称；新地址返回正常节点。";
      expiredCard.appendChild(expiredNote);
      aggregateRoot.appendChild(expiredCard);
    }
    function parseClashConfigInput(value) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error("Clash 分流配置必须是合法 JSON"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Clash 分流配置必须是 JSON 对象");
      return parsed;
    }
    function renderClashSettings() {
      clashSettingsRoot.replaceChildren();
      const details = document.createElement("details");
      details.className = "rules-help";
      const summary = document.createElement("summary");
      summary.textContent = "Clash / Mihomo 分流配置（默认自动测速，汇总和各订阅共用）";
      details.appendChild(summary);
      const label = document.createElement("label");
      label.textContent = "配置 JSON（proxy-groups、rule-providers、rules）";
      const input = document.createElement("textarea");
      input.dataset.field = "clashConfig";
      input.value = JSON.stringify(state.clashConfig, null, 2);
      label.appendChild(input);
      details.appendChild(label);
      const help = document.createElement("p");
      help.className = "muted";
      help.textContent = "默认使用 url-test 自动测速并在节点失联时切换可用节点；代理组中的 {{NODES}} 会自动展开为当前所有有效节点。规则提供商地址请使用你信任的来源。通常不需要修改这里。";
      details.appendChild(help);
      clashSettingsRoot.appendChild(details);
    }
    function render() {
      renderClashSettings();
      renderAggregate();
      root.replaceChildren();
      if (state.profiles.length === 0) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "当前没有保存的订阅。请先点击“新增订阅”，填写订阅名称/ID和完整源头订阅地址，再点击“保存订阅配置”。";
        root.appendChild(empty);
        return;
      }
      state.profiles.forEach((profile, index) => {
        const profileCard = document.createElement("details");
        profileCard.className = "profile-card";
        profileCard.open = index === 0;
        const summary = document.createElement("summary");
        summary.textContent = "订阅 " + (index + 1) + " · " + (profile.id || "未命名");
        profileCard.appendChild(summary);
        const card = document.createElement("fieldset");
        renderStatusPanel(card, "刷新状态", profile.status, profile.paused ? "自动更新已暂停" : "自动更新中");
        addField(card, "id", "订阅名称 / ID（唯一）", profile.id, "text", "例如：主订阅 或 backup");
        addField(card, "sourceUrl", "完整源头订阅地址（把 ?token=... 一起粘贴，仅管理员可见）", profile.sourceUrl, "url", "https://供应商.example/subscribe?token=...");
        const uploadLabel = document.createElement("label");
        uploadLabel.textContent = "手动上传 YAML（源站不可用时作为历史源）";
        const uploadInput = document.createElement("input");
        uploadInput.type = "file";
        uploadInput.accept = ".yaml,.yml,.txt,text/yaml,application/yaml,text/plain";
        uploadLabel.appendChild(uploadInput);
        const uploadName = document.createElement("span");
        uploadName.className = "muted";
        uploadInput.onchange = () => { uploadName.textContent = uploadInput.files?.[0]?.name ? " 已选择：" + uploadInput.files[0].name : ""; };
        uploadLabel.appendChild(uploadName);
        card.appendChild(uploadLabel);
        const uploadButton = document.createElement("button");
        uploadButton.type = "button";
        uploadButton.textContent = "上传并保存历史源";
        uploadButton.onclick = async () => {
          const file = uploadInput.files?.[0];
          if (!file) { setStatus("请先选择 YAML 文件"); return; }
          if (file.size > 5 * 1024 * 1024) { setStatus("YAML 文件不能超过 5 MB"); return; }
          uploadButton.disabled = true;
          try {
            const content = await file.text();
            const data = await api("/api/admin/import", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: profile.id, content })
            });
            await load();
            setStatus("已上传并绑定订阅 " + profile.id + " 的历史有效源，共 " + data.validCount + " 个节点（" + (data.storage === "d1" ? "D1" : "KV 兜底") + "）；源站不可用时会自动使用。");
          } catch (error) { setStatus(error.message); }
          finally { uploadButton.disabled = false; }
        };
        card.appendChild(uploadButton);
        if (profile.capturedAt) {
          const historyNote = document.createElement("p");
          historyNote.className = "muted";
          historyNote.textContent = "已绑定历史源（" + (profile.sourceStorage === "d1" ? "D1" : "KV 兜底") + "）：" + (profile.validCount || 0) + " 个有效节点，保存于 " + new Date(profile.capturedAt).toLocaleString();
          card.appendChild(historyNote);
        }
        const historyVersions = Array.isArray(profile.historyVersions) ? profile.historyVersions : [];
        const historyPanel = document.createElement("details");
        historyPanel.className = "history-panel";
        const historySummary = document.createElement("summary");
        historySummary.textContent = "历史内容版本（" + historyVersions.length + " 个）";
        historyPanel.appendChild(historySummary);
        const historyHint = document.createElement("p");
        historyHint.className = "muted";
        historyHint.textContent = "只按源头内容去重；相同内容的不同刷新时间不会重复显示。选择后会立即套用当前规则并发布。";
        historyPanel.appendChild(historyHint);
        if (historyVersions.length === 0) {
          const emptyHistory = document.createElement("p");
          emptyHistory.className = "muted";
          emptyHistory.textContent = "暂无不同内容版本";
          historyPanel.appendChild(emptyHistory);
        } else {
          historyVersions.forEach((version) => {
            const row = document.createElement("div");
            row.className = "history-version-row";
            const meta = document.createElement("div");
            meta.className = "history-version-meta";
            const title = document.createElement("strong");
            title.textContent = new Date(version.capturedAt).toLocaleString() + " · " + Number(version.validCount || 0) + " 个有效节点";
            meta.appendChild(title);
            const hash = document.createElement("small");
            hash.textContent = "内容版本：" + String(version.sourceContentHash || "").slice(0, 12);
            meta.appendChild(hash);
            row.appendChild(meta);
            const pauseLabel = document.createElement("label");
            pauseLabel.className = "check-label";
            const pauseInput = document.createElement("input");
            pauseInput.type = "checkbox";
            pauseInput.checked = profile.paused === true;
            pauseLabel.appendChild(pauseInput);
            pauseLabel.appendChild(document.createTextNode("同时暂停自动更新"));
            row.appendChild(pauseLabel);
            const useButton = document.createElement("button");
            useButton.type = "button";
            useButton.textContent = "使用此版本";
            useButton.onclick = async () => {
              useButton.disabled = true;
              pauseInput.disabled = true;
              try {
                const data = await api("/api/admin/history/use", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: profile.id, sourceContentHash: version.sourceContentHash, pauseUpdates: pauseInput.checked })
                });
                await load();
                setStatus("已使用 " + profile.id + " 的历史版本并重新发布（" + data.validCount + " 个有效节点）" + (pauseInput.checked ? "，自动更新已暂停" : ""));
              } catch (error) {
                setStatus(error.message);
                useButton.disabled = false;
                pauseInput.disabled = false;
              }
            };
            row.appendChild(useButton);
            historyPanel.appendChild(row);
          });
        }
        card.appendChild(historyPanel);
        const publicLinkInput = addField(card, "publicLink", "修改后的通用订阅地址（可修改 /sub/ 后面的路径）", publicLinkFor(profile.publicToken), "url", location.origin + "/sub/保存后自动生成");
        const copyLink = document.createElement("button");
        copyLink.type = "button";
        copyLink.textContent = "复制地址";
        copyLink.onclick = async () => {
          const text = publicLinkInput.value.trim();
          if (!text) { setStatus("请先保存订阅，系统会生成通用订阅地址"); return; }
          try {
            await navigator.clipboard.writeText(text);
            setStatus("已复制通用订阅地址");
          } catch {
            publicLinkInput.focus();
            publicLinkInput.select();
            setStatus("浏览器禁止自动复制，请按 Ctrl+C 复制已选中的地址");
          }
        };
        card.appendChild(copyLink);
        addField(card, "minValidNodes", "最低有效节点数", profile.minValidNodes || 1, "number");
        const filterRules = document.createElement("section");
        filterRules.className = "filter-rules";
        const filterTitle = document.createElement("div");
        filterTitle.className = "filter-rules-title";
        filterTitle.textContent = "节点名称组合筛选（可留空）";
        filterRules.appendChild(filterTitle);
        addField(filterRules, "nodeNameIncludeAll", "必须包含（且；多个关键词用 | 分隔）", profile.nodeNameIncludeAll || "", "text", "例如：VIP2");
        addField(filterRules, "nodeNameInclude", "以下任意一个（或；多个关键词用 | 分隔）", profile.nodeNameInclude || "", "text", "例如：美国1|美国2|美国3");
        addField(filterRules, "nodeNameExclude", "排除任意一个（多个关键词用 | 分隔）", profile.nodeNameExclude || "", "text", "例如：到期|续费");
        const filterHelp = document.createElement("p");
        filterHelp.className = "muted";
        filterHelp.textContent = "示例：必须包含填 VIP2，以下任意一个填 美国1|美国2|美国3，排除任意一个填 到期|续费，最终就是 VIP2 且（美国1/美国2/美国3 任意一个），并排除到期或续费。先过滤原始节点名称，再执行改名规则。三项都留空就是不过滤。";
        filterRules.appendChild(filterHelp);
        card.appendChild(filterRules);
        addCheckbox(card, "paused", "暂停自动更新（固定当前已发布版本）", profile.paused === true);
        addField(card, "defaultTarget", "无法识别客户端时的格式（clash/base64/sing-box/links）", profile.defaultTarget || "clash", "text", "clash");
        addCheckbox(card, "replaceAllFields", "允许替换节点全部字段（高级；默认只替换名称）", profile.replaceAllFields);
        const renameRulesEditor = renderRenameRulesEditor(card, profile.renameRules || []);
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.textContent = "预览原版 / 规则修改后";
        const previewGrid = document.createElement("div");
        previewGrid.className = "preview-grid";
        previewButton.onclick = async () => {
          previewButton.disabled = true;
          previewGrid.replaceChildren();
          try {
            const renameRules = collectRenameRules(renameRulesEditor, index);
            const replaceAllFields = card.querySelector("[data-field='replaceAllFields']").checked;
            const nodeNameInclude = card.querySelector("[data-field='nodeNameInclude']").value;
            const nodeNameIncludeAll = card.querySelector("[data-field='nodeNameIncludeAll']").value;
            const nodeNameExclude = card.querySelector("[data-field='nodeNameExclude']").value;
            const data = await api("/api/admin/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: profile.id, renameRules, replaceAllFields, nodeNameInclude, nodeNameIncludeAll, nodeNameExclude }) });
            renderPreviewPane(previewGrid, "原版", data.original || []);
            renderPreviewPane(previewGrid, "规则修改后", data.modified || []);
            setStatus((data.source === "history" ? "源头暂不可用，已使用 D1 历史快照" : "已读取当前源头") + "加载预览；默认只替换名称。需要长期生效请点击“保存本订阅”或“保存订阅配置”");
          } catch (error) { setStatus(error.message); }
          finally { previewButton.disabled = false; }
        };
        card.appendChild(previewButton);
        card.appendChild(previewGrid);
        const saveOne = document.createElement("button");
        saveOne.type = "button";
        saveOne.textContent = "保存本订阅";
        saveOne.onclick = () => saveAll(index + 1);
        card.appendChild(saveOne);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "删除此订阅";
        remove.onclick = () => { state.profiles.splice(index, 1); render(); };
        card.appendChild(remove);
        profileCard.appendChild(card);
        root.appendChild(profileCard);
      });
    }
    function collect() {
      return Array.from(root.querySelectorAll("fieldset")).map((card, index) => {
        const value = (key) => card.querySelector("[data-field='" + key + "']").value;
        const checked = (key) => card.querySelector("[data-field='" + key + "']").checked;
        const id = value("id").trim();
        const sourceUrl = value("sourceUrl").trim();
        const publicToken = publicTokenFromLink(value("publicLink"), index);
        if (!id || !sourceUrl) {
          throw new Error("订阅 " + (index + 1) + " 还没有填写完整：订阅名称/ID和完整源头订阅地址必填");
        }
        if (!/^https?:\\/\\//i.test(sourceUrl)) {
          throw new Error("订阅 " + (index + 1) + " 的源头订阅地址必须以 https:// 或 http:// 开头");
        }
        const renameRules = collectRenameRules(card.querySelector("[data-rename-rules-editor]"), index);
        return {
          id,
          name: id,
          sourceUrl,
          publicToken,
          replaceAllFields: checked("replaceAllFields"),
          paused: checked("paused"),
          nodeNameInclude: value("nodeNameInclude").trim(),
          nodeNameIncludeAll: value("nodeNameIncludeAll").trim(),
          nodeNameExclude: value("nodeNameExclude").trim(),
          minValidNodes: Number(value("minValidNodes")),
          defaultTarget: value("defaultTarget").trim(),
          renameRules
        };
      });
    }
    async function load() {
      try {
        const data = await api("/api/admin/subscriptions");
        state.profiles = data.subscriptions || [];
        state.aggregatePublicToken = data.aggregatePublicToken || "";
        state.expiredSubscription = data.expiredSubscription || { tokens: [], nodeNames: ["订阅已过期", "请联系顾问", "续费后恢复"] };
        state.refreshIntervalMinutes = data.refreshIntervalMinutes || 30;
        state.clashConfig = data.clashConfig || state.clashConfig;
        state.aggregateCustomNodes = Array.isArray(data.aggregateCustomNodes) ? data.aggregateCustomNodes : [];
        state.aggregateCustomNodePosition = data.aggregateCustomNodePosition || "tail";
        interval.value = state.refreshIntervalMinutes;
        interval.disabled = false;
        setEnabled(true);
        state.aggregateStatus = data.aggregateStatus || null;
        state.controlPlane = data.controlPlane || "";
        render();
        setStatus("已读取 " + state.profiles.length + " 个订阅（" + (data.controlPlane === "d1" ? "D1 是权威配置源，KV 为兼容缓存" : data.managed ? "兼容 KV 已保存配置" : "使用环境变量回退") + "）");
      } catch (error) { setStatus(error.message); }
    }
    document.getElementById("login").onclick = async () => {
      const value = prompt("请输入 ADMIN_TOKEN（不会保存到浏览器）");
      if (!value) return;
      state.token = value;
      await load();
    };
    document.getElementById("reload").onclick = load;
    document.getElementById("add").onclick = () => {
      state.profiles.push({ id: "", name: "", sourceUrl: "", publicToken: "", nodeNameInclude: "", nodeNameIncludeAll: "", nodeNameExclude: "", replaceAllFields: false, paused: false, minValidNodes: 1, defaultTarget: "clash", renameRules: [] });
      render();
    };
    async function saveAll(focusIndex = null) {
      try {
        const subscriptions = collect();
        const clashConfig = parseClashConfigInput(clashSettingsRoot.querySelector("[data-field='clashConfig']").value);
        const aggregateLink = aggregateRoot.querySelector("[data-field='aggregateLink']");
        const aggregatePublicToken = aggregateLink ? publicTokenFromLink(aggregateLink.value, 0) : "";
        const expiredLinks = aggregateRoot.querySelector("[data-field='expiredLinks']")?.value || "";
        const expiredTokens = expiredLinks.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean).map((item, index) => publicTokenFromLink(item, index));
        const expiredNodeNames = [0, 1, 2].map((index) => aggregateRoot.querySelector("[data-field='expiredName" + index + "']")?.value.trim() || "");
        const aggregateCustomNodes = aggregateRoot.querySelector("[data-field='aggregateCustomNodes']")?.value.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean) || [];
        const aggregateCustomNodePosition = aggregateRoot.querySelector("[data-field='aggregateCustomNodePosition']")?.value || "tail";
        if (expiredNodeNames.some((name) => !name)) throw new Error("过期提示节点名称不能留空");
        if (subscriptions.length === 0) throw new Error("当前没有订阅配置，请先点击“新增订阅”并填写完整后再保存");
        await api("/api/admin/subscriptions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscriptions, aggregatePublicToken, expiredSubscription: { tokens: expiredTokens, nodeNames: expiredNodeNames } }) });
        const settingsResult = await api("/api/admin/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshIntervalMinutes: Number(interval.value), clashConfig, aggregateCustomNodes, aggregateCustomNodePosition }) });
        const scope = focusIndex ? "第 " + focusIndex + " 个订阅" : subscriptions.length + " 个订阅";
        await load();
        setStatus("已保存" + scope + "、分流配置、刷新间隔及汇总自定义节点到 D1（KV 同步为兼容缓存，已识别 " + Number(settingsResult.aggregateCustomNodeCount || 0) + " 个自定义节点）。");
      } catch (error) { setStatus(error.message); }
    }
    document.getElementById("save").onclick = () => saveAll();
    document.getElementById("save-bottom").onclick = () => saveAll();
    document.getElementById("refresh").onclick = async () => {
      try { const data = await api("/api/admin/refresh", { method: "POST" }); setStatus(JSON.stringify(data.results, null, 2)); }
      catch (error) { setStatus(error.message); }
    };
  </script>
</body>
</html>`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function getSourceUrl(env, profile) {
  const url = new URL(profile.sourceUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("SOURCE_URL must use HTTP or HTTPS");
  if (url.protocol === "http:" && env.ALLOW_HTTP_SOURCE !== "true") {
    throw new Error("HTTP source is disabled; set ALLOW_HTTP_SOURCE=true only when explicitly required");
  }
  return url.toString();
}

async function readResponseWithLimit(response, maxBytes) {
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Source response is too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Source response is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchSource(env, profile) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(env.SOURCE_TIMEOUT_MS ?? 15000));
  try {
    const response = await fetch(getSourceUrl(env, profile), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "text/plain, text/yaml, application/json;q=0.9, */*;q=0.1" }
    });
    return await readResponseWithLimit(response, Number(env.MAX_SOURCE_BYTES ?? DEFAULT_MAX_SOURCE_BYTES));
  } finally {
    clearTimeout(timeout);
  }
}

async function loadState(env, profileId) {
  if (!env.SUBSCRIPTION_STATE?.get) return null;
  const raw = await env.SUBSCRIPTION_STATE.get(stateKey(profileId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadProfilesFromLegacy(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_CONFIG_KEY);
    if (stored !== null) return parseSubscriptionProfilesJson(stored);
  }
  return parseSubscriptionProfiles(env);
}

async function loadProfilesFromKv(env) {
  if (!env.SUBSCRIPTION_STATE?.get) return null;
  const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_CONFIG_KEY);
  return stored === null ? null : parseSubscriptionProfilesJson(stored);
}

async function ensureControlPlaneSchema(env) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return false;
  if (!controlPlaneSchemaPromise) {
    controlPlaneSchemaPromise = env.SUBSCRIPTION_AUDIT
      .prepare("CREATE TABLE IF NOT EXISTS subscription_control (control_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)")
      .bind()
      .run()
      .then(() => true)
      .catch(() => {
        controlPlaneSchemaPromise = null;
        return false;
      });
  }
  return controlPlaneSchemaPromise;
}

async function readControlValue(env, key) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare || !await ensureControlPlaneSchema(env)) {
    return { available: false, exists: false, value: null };
  }
  try {
    const row = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT value_json FROM subscription_control WHERE control_key = ? LIMIT 1")
      .bind(key)
      .first();
    if (!row?.value_json) return { available: true, exists: false, value: null };
    return { available: true, exists: true, value: JSON.parse(row.value_json) };
  } catch {
    return { available: false, exists: false, value: null };
  }
}

async function writeControlValue(env, key, value, now = new Date()) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return false;
  if (!await ensureControlPlaneSchema(env)) throw new Error("D1 control plane is unavailable");
  await env.SUBSCRIPTION_AUDIT
    .prepare("INSERT INTO subscription_control (control_key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(control_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), now.toISOString())
    .run();
  return true;
}

async function deleteControlValue(env, key) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare || !await ensureControlPlaneSchema(env)) return false;
  await env.SUBSCRIPTION_AUDIT.prepare("DELETE FROM subscription_control WHERE control_key = ?").bind(key).run();
  return true;
}

async function loadCanonicalValue(env, key, legacyLoader) {
  const control = await readControlValue(env, key);
  if (control.available) {
    if (control.exists) return { value: control.value, managed: true, fromD1: true };
    const legacy = await legacyLoader();
    if (legacy !== null && legacy !== undefined) {
      await writeControlValue(env, key, legacy);
      return { value: legacy, managed: true, fromD1: true, migrated: true };
    }
    return { value: null, managed: false, fromD1: true };
  }
  return { value: await legacyLoader(), managed: false, fromD1: false };
}

async function loadProfiles(env) {
  const result = await loadCanonicalValue(env, CONTROL_PROFILES_KEY, () => loadProfilesFromKv(env));
  return Array.isArray(result.value) ? result.value : loadProfilesFromLegacy(env);
}

function normalizeRefreshInterval(value, fallback = DEFAULT_REFRESH_INTERVAL_MINUTES) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 5 || number > 1440 || number % 5 !== 0) return fallback;
  return number;
}

function normalizeAggregateCustomNodes(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  return [...new Set(values
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))]
    .slice(0, 500);
}

function normalizeAggregateCustomNodePosition(value) {
  return String(value ?? "").toLowerCase() === "top" ? "top" : "tail";
}

function parseAggregateCustomNodes(value) {
  const lines = normalizeAggregateCustomNodes(value);
  if (lines.length === 0) return [];
  const combined = lines.join("\n");
  try {
    const parsed = decodeSubscription(combined);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Try each line below so one pasted node cannot hide other valid nodes.
  }
  return lines.flatMap((line) => {
    try {
      const parsed = decodeSubscription(line);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
}

function createPublicToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.replace(/-/g, "");
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseAggregateToken(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.publicToken ?? "").trim();
  } catch {
    return String(raw).trim();
  }
}

async function loadAggregateTokenFromLegacy(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(AGGREGATE_PUBLIC_TOKEN_KEY);
    const token = parseAggregateToken(stored);
    if (token) return token;
  }
  return String(env.AGGREGATE_PUBLIC_TOKEN ?? "").trim();
}

async function loadAggregateToken(env) {
  const result = await loadCanonicalValue(env, CONTROL_AGGREGATE_TOKEN_KEY, async () => {
    if (!env.SUBSCRIPTION_STATE?.get) return null;
    const stored = await env.SUBSCRIPTION_STATE.get(AGGREGATE_PUBLIC_TOKEN_KEY);
    if (stored === null) return null;
    const legacy = parseAggregateToken(stored);
    return legacy || null;
  });
  return typeof result.value === "string" ? result.value : String(result.value?.publicToken ?? "").trim() || String(env.AGGREGATE_PUBLIC_TOKEN ?? "").trim();
}

async function ensureAggregateToken(env, requested = "") {
  const candidate = String(requested ?? "").trim();
  if (candidate && /^[A-Za-z0-9_-]{1,128}$/.test(candidate)) {
    await writeControlValue(env, CONTROL_AGGREGATE_TOKEN_KEY, candidate);
    if (env.SUBSCRIPTION_STATE?.put) {
      await env.SUBSCRIPTION_STATE.put(AGGREGATE_PUBLIC_TOKEN_KEY, JSON.stringify({ publicToken: candidate }));
    }
    return candidate;
  }
  const existing = await loadAggregateToken(env);
  if (existing) return existing;
  if (!env.SUBSCRIPTION_STATE?.put) return "";
  const generated = createPublicToken();
  await writeControlValue(env, CONTROL_AGGREGATE_TOKEN_KEY, generated);
  await env.SUBSCRIPTION_STATE.put(AGGREGATE_PUBLIC_TOKEN_KEY, JSON.stringify({ publicToken: generated }));
  return generated;
}

async function loadExpiredSubscriptionFromLegacy(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_EXPIRED_KEY);
    if (stored !== null) {
      try { return normalizeExpiredSubscription(JSON.parse(stored)); } catch { /* use defaults */ }
    }
  }
  return normalizeExpiredSubscription(null);
}

async function loadExpiredSubscription(env) {
  const result = await loadCanonicalValue(env, CONTROL_EXPIRED_KEY, async () => {
    if (!env.SUBSCRIPTION_STATE?.get) return null;
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_EXPIRED_KEY);
    if (stored === null) return null;
    try { return normalizeExpiredSubscription(JSON.parse(stored)); } catch { return normalizeExpiredSubscription(null); }
  });
  return normalizeExpiredSubscription(result.value ?? await loadExpiredSubscriptionFromLegacy(env));
}

async function saveExpiredSubscription(env, value) {
  const normalized = normalizeExpiredSubscription(value);
  await writeControlValue(env, CONTROL_EXPIRED_KEY, normalized);
  if (env.SUBSCRIPTION_STATE?.put) {
    await env.SUBSCRIPTION_STATE.put(ADMIN_EXPIRED_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

async function loadSettingsFromLegacy(env) {
  if (env.SUBSCRIPTION_STATE?.get) {
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_SETTINGS_KEY);
    if (stored !== null) {
      try {
        const parsed = JSON.parse(stored);
        return {
          refreshIntervalMinutes: normalizeRefreshInterval(parsed.refreshIntervalMinutes),
          clashConfig: normalizeAutomaticClashConfig(parsed.clashConfig),
          aggregateCustomNodes: normalizeAggregateCustomNodes(parsed.aggregateCustomNodes),
          aggregateCustomNodePosition: normalizeAggregateCustomNodePosition(parsed.aggregateCustomNodePosition)
        };
      } catch {
        // Fall through to the private environment variable if the setting is corrupt.
      }
    }
  }
  return {
    refreshIntervalMinutes: normalizeRefreshInterval(env.REFRESH_INTERVAL_MINUTES),
    clashConfig: normalizeAutomaticClashConfig(env.CLASH_CONFIG_JSON),
    aggregateCustomNodes: normalizeAggregateCustomNodes(env.AGGREGATE_CUSTOM_NODES),
    aggregateCustomNodePosition: normalizeAggregateCustomNodePosition(env.AGGREGATE_CUSTOM_NODE_POSITION)
  };
}

async function loadSettings(env) {
  const result = await loadCanonicalValue(env, CONTROL_SETTINGS_KEY, async () => {
    if (!env.SUBSCRIPTION_STATE?.get) return null;
    const stored = await env.SUBSCRIPTION_STATE.get(ADMIN_SETTINGS_KEY);
    if (stored === null) return null;
    try { return JSON.parse(stored); } catch { return null; }
  });
  const value = result.value && typeof result.value === "object" ? result.value : await loadSettingsFromLegacy(env);
  return {
    refreshIntervalMinutes: normalizeRefreshInterval(value.refreshIntervalMinutes ?? env.REFRESH_INTERVAL_MINUTES),
    clashConfig: normalizeAutomaticClashConfig(value.clashConfig ?? env.CLASH_CONFIG_JSON),
    aggregateCustomNodes: normalizeAggregateCustomNodes(value.aggregateCustomNodes ?? env.AGGREGATE_CUSTOM_NODES),
    aggregateCustomNodePosition: normalizeAggregateCustomNodePosition(value.aggregateCustomNodePosition ?? env.AGGREGATE_CUSTOM_NODE_POSITION)
  };
}

async function scheduledRefreshDue(env, now) {
  const settings = await loadSettings(env);
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) return { due: true, settings };
  const raw = await env.SUBSCRIPTION_STATE.get(LAST_REFRESH_KEY);
  if (raw) {
    try {
      const previous = JSON.parse(raw);
      const lastRun = Date.parse(previous.lastRunAt);
      if (Number.isFinite(lastRun) && now.getTime() - lastRun < settings.refreshIntervalMinutes * 60 * 1000) {
        return { due: false, settings };
      }
    } catch {
      // A malformed marker is treated as due and replaced below.
    }
  }
  await env.SUBSCRIPTION_STATE.put(LAST_REFRESH_KEY, JSON.stringify({ lastRunAt: now.toISOString() }));
  return { due: true, settings };
}

async function storedProfiles(env) {
  const control = await readControlValue(env, CONTROL_PROFILES_KEY);
  if (control.available && control.exists) {
    return { managed: true, profiles: Array.isArray(control.value) ? control.value : [] };
  }
  const storedProfiles = await loadProfilesFromKv(env);
  if (control.available && storedProfiles !== null) {
    const profiles = storedProfiles;
    await writeControlValue(env, CONTROL_PROFILES_KEY, profiles);
    return { managed: true, profiles };
  }
  return { managed: false, profiles: await loadProfilesFromLegacy(env) };
}

function isAdminAuthorized(request, env) {
  const token = String(env.ADMIN_TOKEN ?? "").trim();
  return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Request body is too large");
  return JSON.parse(text);
}

function previewNode(node) {
  return {
    name: node.name,
    type: node.type,
    server: node.server,
    port: node.port,
    network: node.network,
    tls: Boolean(node.tls)
  };
}

function summarizeRefreshResult(result) {
  const { nodes: _nodes, output: _output, ...summary } = result;
  return summary;
}

async function handleAdminApi(request, env, url) {
  if (!isAdminAuthorized(request, env)) {
    return json({ error: env.ADMIN_TOKEN ? "unauthorized" : "admin-disabled" }, env.ADMIN_TOKEN ? 401 : 503);
  }
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return json({ error: "state-store-not-configured" }, 503);
  }
  if (url.pathname === "/api/admin/subscriptions" && request.method === "GET") {
    const current = await storedProfiles(env);
    const settings = await loadSettings(env);
    const expiredSubscription = await loadExpiredSubscription(env);
    const aggregatePublicToken = await ensureAggregateToken(env);
    const subscriptions = await Promise.all(current.profiles.map(async (profile) => {
      const d1Meta = await loadLatestSourceSnapshotMeta(env, profile.id);
      const historyVersions = await listSourceSnapshotMeta(env, profile.id);
      const status = await loadStatus(env, profile.id, d1Meta);
      if (d1Meta) return { ...profile, ...d1Meta, historyVersions, sourceStorage: "d1", status };
      const state = await loadState(env, profile.id);
      if (state?.sourceSnapshotAt || state?.sourceNodes?.length || state?.nodes?.length) {
        return {
          ...profile,
          capturedAt: state.sourceSnapshotAt ?? state.updatedAt ?? "",
          validCount: Number(state.validCount ?? state.nodes?.length ?? 0),
          historyVersions,
          sourceStorage: "kv",
          status
        };
      }
      return { ...profile, historyVersions, status };
    }));
    const aggregateStatus = await loadStatus(env, AGGREGATE_STATE_ID);
    return json({
      managed: current.managed,
      subscriptions,
      aggregatePublicToken,
      expiredSubscription,
      refreshIntervalMinutes: settings.refreshIntervalMinutes,
      clashConfig: settings.clashConfig,
      aggregateCustomNodes: settings.aggregateCustomNodes,
      aggregateCustomNodePosition: settings.aggregateCustomNodePosition,
      aggregateStatus,
      controlPlane: await ensureControlPlaneSchema(env) ? "d1" : "kv-fallback"
    });
  }
  if (url.pathname === "/api/admin/subscriptions" && request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const rawSubscriptions = body?.subscriptions ?? body;
      if (!Array.isArray(rawSubscriptions)) return json({ error: "subscriptions must be an array" }, 400);
      const current = await storedProfiles(env);
      const existingTokens = new Map(current.profiles.map((profile) => [profile.id, profile.publicToken]));
      const prepared = rawSubscriptions.map((item) => {
        const profile = item && typeof item === "object" ? item : {};
        const id = String(profile.id ?? "").trim();
        return {
          ...profile,
          publicToken: String(profile.publicToken ?? existingTokens.get(id) ?? "").trim() || createPublicToken()
        };
      });
      const checked = validateSubscriptionProfiles(prepared);
      if (checked.error) return json({ error: checked.error }, 400);
      const requestedAggregateToken = String(body?.aggregatePublicToken ?? "").trim();
      const aggregateCandidate = requestedAggregateToken && /^[A-Za-z0-9_-]{1,128}$/.test(requestedAggregateToken)
        ? requestedAggregateToken
        : await loadAggregateToken(env);
      const expiredSubscriptionInput = Object.prototype.hasOwnProperty.call(body ?? {}, "expiredSubscription")
        ? normalizeExpiredSubscription(body.expiredSubscription)
        : await loadExpiredSubscription(env);
      if (aggregateCandidate && expiredSubscriptionInput.tokens.includes(aggregateCandidate)) {
        return json({ error: "current aggregate address cannot also be marked expired" }, 400);
      }
      const aggregatePublicToken = await ensureAggregateToken(env, requestedAggregateToken);
      await writeControlValue(env, CONTROL_PROFILES_KEY, checked.profiles);
      await env.SUBSCRIPTION_STATE.put(ADMIN_CONFIG_KEY, JSON.stringify(checked.profiles));
      const expiredSubscription = await saveExpiredSubscription(env, expiredSubscriptionInput);
      await reprocessConfiguredProfiles(env, checked.profiles);
      return json({ ok: true, count: checked.profiles.length, expiredSubscription });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid-json" }, 400);
    }
  }
  if (url.pathname === "/api/admin/history/use" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const id = String(body?.id ?? "").trim();
      const sourceContentHash = String(body?.sourceContentHash ?? "").trim().toLowerCase();
      if (!id || !/^[a-f0-9]{64}$/.test(sourceContentHash)) return json({ error: "invalid-history-version" }, 400);
      const profile = (await loadProfiles(env)).find((item) => item.id === id);
      if (!profile) return json({ error: "subscription-not-found" }, 404);
      const snapshot = await loadSourceSnapshotByHash(env, profile.id, sourceContentHash);
      if (!snapshot?.nodes?.length) return json({ error: "history-version-not-found" }, 404);
      const settings = await loadSettings(env);
      const previous = await loadState(env, profile.id);
      const candidate = await buildCandidateFromNodes(snapshot.nodes, {
        renameRules: profile.renameRules,
        nodeNameInclude: profile.nodeNameInclude,
        nodeNameIncludeAll: profile.nodeNameIncludeAll,
        nodeNameExclude: profile.nodeNameExclude,
        replaceAllFields: profile.replaceAllFields,
        minValidNodes: profile.minValidNodes,
        clashConfig: settings.clashConfig
      });
      if (!candidate.valid) {
        return json({ error: "historical-version-below-minimum", validCount: candidate.validCount, minValidNodes: candidate.minValidNodes }, 400);
      }
      const pauseUpdates = Object.prototype.hasOwnProperty.call(body ?? {}, "pauseUpdates")
        ? body.pauseUpdates === true
        : profile.paused === true;
      const current = await storedProfiles(env);
      const checked = validateSubscriptionProfiles(current.profiles.map((item) => item.id === id ? { ...item, paused: pauseUpdates } : item));
      if (checked.error) return json({ error: checked.error }, 400);
      await writeControlValue(env, CONTROL_PROFILES_KEY, checked.profiles);
      await env.SUBSCRIPTION_STATE.put(ADMIN_CONFIG_KEY, JSON.stringify(checked.profiles));
      const now = new Date();
      const decision = decidePublication(candidate, previous);
      const published = await publishDecision(env, profile.id, decision, now, {
        sourceOrigin: "manual-history",
        sourceSnapshotAt: snapshot.capturedAt
      });
      await writeAudit(env, profile.id, published, now);
      const profiles = await loadProfiles(env);
      const aggregate = await refreshAggregate(env, now, profiles, settings);
      return json({
        ok: true,
        subscriptionId: profile.id,
        versionId: snapshot.versionId,
        capturedAt: snapshot.capturedAt,
        sourceContentHash: snapshot.sourceContentHash,
        action: published.action,
        reason: published.reason,
        validCount: candidate.validCount,
        paused: pauseUpdates,
        aggregateAction: aggregate.action
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "history-version-use-failed" }, 400);
    }
  }
  if (url.pathname === "/api/admin/import" && request.method === "POST") {
    try {
      const body = await readJsonBody(request, DEFAULT_MAX_SOURCE_BYTES + 64 * 1024);
      const id = String(body?.id ?? "").trim();
      const content = String(body?.content ?? "");
      const profile = (await loadProfiles(env)).find((item) => item.id === id);
      if (!profile) return json({ error: "subscription-not-found" }, 404);
      if (!content.trim()) return json({ error: "uploaded-source-is-empty" }, 400);
      if (new TextEncoder().encode(content).byteLength > DEFAULT_MAX_SOURCE_BYTES) {
        return json({ error: "uploaded-source-is-too-large" }, 413);
      }
      const settings = await loadSettings(env);
      const candidate = await buildCandidate(content, {
        renameRules: profile.renameRules,
        nodeNameInclude: profile.nodeNameInclude,
        nodeNameIncludeAll: profile.nodeNameIncludeAll,
        nodeNameExclude: profile.nodeNameExclude,
        replaceAllFields: profile.replaceAllFields,
        minValidNodes: profile.minValidNodes,
        clashConfig: settings.clashConfig
      });
      if (!candidate.sourceValidCount) {
        return json({ error: "uploaded-source-has-no-valid-nodes", validCount: 0 }, 400);
      }
      const capturedAt = new Date();
      const storedInD1 = await writeSourceSnapshot(env, profile.id, candidate, capturedAt);
      const previous = await loadState(env, profile.id);
      const decision = candidate.valid
        ? await publishDecision(env, profile.id, decidePublication(candidate, previous), capturedAt, {
        sourceOrigin: "manual-upload",
        sourceSnapshotAt: capturedAt.toISOString()
        })
        : { action: "keep", reason: "filters-produced-no-valid-nodes", validCount: 0 };
      const profiles = await loadProfiles(env);
      const aggregate = await refreshAggregate(env, capturedAt, profiles, settings);
      return json({
        ok: true,
        subscriptionId: profile.id,
        action: decision.action,
        validCount: candidate.validCount,
        sourceValidCount: candidate.sourceValidCount,
        storage: storedInD1 ? "d1" : "kv-fallback",
        aggregateAction: aggregate.action
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "upload-failed" }, 400);
    }
  }
  if (url.pathname === "/api/admin/settings" && request.method === "PUT") {
    try {
      const body = await readJsonBody(request);
      const value = Number(body?.refreshIntervalMinutes);
      if (!Number.isInteger(value) || value < 5 || value > 1440 || value % 5 !== 0) {
        return json({ error: "refreshIntervalMinutes must be an integer from 5 to 1440 in 5-minute increments" }, 400);
      }
      const current = await loadSettings(env);
      const clashConfig = Object.prototype.hasOwnProperty.call(body ?? {}, "clashConfig")
        ? normalizeAutomaticClashConfig(body.clashConfig, true)
        : current.clashConfig;
      const aggregateCustomNodes = Object.prototype.hasOwnProperty.call(body ?? {}, "aggregateCustomNodes")
        ? normalizeAggregateCustomNodes(body.aggregateCustomNodes)
        : current.aggregateCustomNodes;
      const aggregateCustomNodePosition = Object.prototype.hasOwnProperty.call(body ?? {}, "aggregateCustomNodePosition")
        ? normalizeAggregateCustomNodePosition(body.aggregateCustomNodePosition)
        : current.aggregateCustomNodePosition;
      const settingsValue = {
        refreshIntervalMinutes: value,
        clashConfig,
        aggregateCustomNodes,
        aggregateCustomNodePosition
      };
      await writeControlValue(env, CONTROL_SETTINGS_KEY, settingsValue);
      await env.SUBSCRIPTION_STATE.put(ADMIN_SETTINGS_KEY, JSON.stringify(settingsValue));
      await reprocessConfiguredProfiles(env, await loadProfiles(env), new Date(), {
        refreshIntervalMinutes: value,
        clashConfig,
        aggregateCustomNodes,
        aggregateCustomNodePosition
      });
      return json({
        ok: true,
        refreshIntervalMinutes: value,
        aggregateCustomNodePosition,
        aggregateCustomNodeCount: parseAggregateCustomNodes(aggregateCustomNodes).length
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid-json" }, 400);
    }
  }
  if (url.pathname === "/api/admin/preview" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const id = String(body?.id ?? "").trim();
      const profile = (await loadProfiles(env)).find((item) => item.id === id);
      if (!profile) return json({ error: "subscription-not-found" }, 404);
      const renameRules = Array.isArray(body?.renameRules) ? body.renameRules : profile.renameRules;
      const replaceAllFields = typeof body?.replaceAllFields === "boolean" ? body.replaceAllFields : profile.replaceAllFields;
      const nodeNameInclude = typeof body?.nodeNameInclude === "string" ? body.nodeNameInclude : profile.nodeNameInclude;
      const nodeNameIncludeAll = typeof body?.nodeNameIncludeAll === "string" ? body.nodeNameIncludeAll : profile.nodeNameIncludeAll;
      const nodeNameExclude = typeof body?.nodeNameExclude === "string" ? body.nodeNameExclude : profile.nodeNameExclude;
      let preview;
      let source = "live";
      try {
        const rawText = await fetchSource(env, profile);
        preview = buildPreview(rawText, { renameRules, replaceAllFields, nodeNameInclude, nodeNameIncludeAll, nodeNameExclude });
        if (preview.original.length === 0 || preview.modified.length === 0) throw new Error("latest-source-has-no-valid-nodes");
      } catch (liveError) {
        const historicalNodes = await loadLatestSourceSnapshot(env, profile.id);
        const state = await loadState(env, profile.id);
        const fallbackNodes = historicalNodes?.length
          ? historicalNodes
          : Array.isArray(state?.sourceNodes) && state.sourceNodes.length > 0
            ? state.sourceNodes
            : state?.nodes;
        if (!fallbackNodes?.length) throw liveError;
        preview = buildPreviewFromNodes(fallbackNodes, { renameRules, replaceAllFields, nodeNameInclude, nodeNameIncludeAll, nodeNameExclude });
        if (preview.original.length === 0 || preview.modified.length === 0) throw liveError;
        source = "history";
      }
      return json({
        subscriptionId: profile.id,
        source,
        original: preview.original.map(previewNode),
        modified: preview.modified.map(previewNode)
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "preview-failed" }, 400);
    }
  }
  if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
    const refreshed = await refreshEverything(env);
    return json({ results: refreshed.results.map(summarizeRefreshResult), aggregate: summarizeRefreshResult(refreshed.aggregate) });
  }
  if (url.pathname === "/api/admin/subscriptions/reset" && request.method === "POST") {
    if (!env.SUBSCRIPTION_STATE.delete) return json({ error: "state-store-does-not-support-delete" }, 503);
    await deleteControlValue(env, CONTROL_PROFILES_KEY);
    await deleteControlValue(env, CONTROL_SETTINGS_KEY);
    await deleteControlValue(env, CONTROL_EXPIRED_KEY);
    await deleteControlValue(env, CONTROL_AGGREGATE_TOKEN_KEY);
    await env.SUBSCRIPTION_STATE.delete(ADMIN_CONFIG_KEY);
    await env.SUBSCRIPTION_STATE.delete(ADMIN_EXPIRED_KEY);
    await env.SUBSCRIPTION_STATE.delete(AGGREGATE_PUBLIC_TOKEN_KEY);
    await env.SUBSCRIPTION_STATE.delete(stateKey(AGGREGATE_STATE_ID));
    return json({ ok: true, managed: false });
  }
  return json({ error: "not-found" }, 404);
}

async function saveState(env, profileId, state) {
  if (!env.SUBSCRIPTION_STATE?.put) throw new Error("SUBSCRIPTION_STATE KV binding is not configured");
  await env.SUBSCRIPTION_STATE.put(stateKey(profileId), JSON.stringify(state));
}

async function publishDecision(env, profileId, decision, now, metadata = {}) {
  if (decision.action === "keep") return decision;
  await saveState(env, profileId, {
    version: 1,
    subscriptionId: profileId,
    contentHash: decision.contentHash,
    sourceContentHash: decision.sourceContentHash,
    sourceOrigin: metadata.sourceOrigin ?? "source-url",
    sourceSnapshotAt: metadata.sourceSnapshotAt ?? now.toISOString(),
    validCount: decision.validCount,
    updatedAt: now.toISOString(),
    sourceNodes: decision.sourceNodes ?? decision.nodes,
    nodes: decision.nodes,
    output: decision.output
  });
  return decision;
}

async function writeSourceSnapshot(env, profileId, candidate, now) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare || !candidate?.sourceContentHash) return false;
  try {
    if (!await ensureSourceSnapshotSchema(env)) return false;
    const nodes = Array.isArray(candidate.sourceNodes) ? candidate.sourceNodes : [];
    if (nodes.length === 0) return false;
    await env.SUBSCRIPTION_AUDIT
      .prepare("INSERT OR IGNORE INTO source_snapshots (subscription_id, captured_at, source_content_hash, valid_count, nodes_json) VALUES (?, ?, ?, ?, ?)")
      .bind(profileId, now.toISOString(), candidate.sourceContentHash, candidate.sourceValidCount ?? nodes.length, JSON.stringify(nodes))
      .run();
    return true;
  } catch {
    console.log(JSON.stringify({ event: "source-snapshot-write-failed" }));
    return false;
  }
}

async function loadLatestSourceSnapshot(env, profileId) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return null;
  try {
    if (!await ensureSourceSnapshotSchema(env)) return null;
    const result = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT nodes_json FROM source_snapshots WHERE subscription_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
      .bind(profileId)
      .first();
    if (!result?.nodes_json) return null;
    const nodes = JSON.parse(result.nodes_json);
    return Array.isArray(nodes) ? nodes : null;
  } catch {
    return null;
  }
}

async function loadLatestSourceSnapshotMeta(env, profileId) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return null;
  try {
    if (!await ensureSourceSnapshotSchema(env)) return null;
    const result = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT captured_at, valid_count FROM source_snapshots WHERE subscription_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1")
      .bind(profileId)
      .first();
    if (!result) return null;
    return { capturedAt: String(result.captured_at ?? ""), validCount: Number(result.valid_count ?? 0) };
  } catch {
    return null;
  }
}

async function listSourceSnapshotMeta(env, profileId) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return [];
  try {
    if (!await ensureSourceSnapshotSchema(env)) return [];
    const result = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT id, captured_at, source_content_hash, valid_count FROM source_snapshots WHERE subscription_id = ? ORDER BY captured_at DESC, id DESC")
      .bind(profileId)
      .all();
    return (Array.isArray(result?.results) ? result.results : []).map((row) => ({
      versionId: String(row.id ?? ""),
      capturedAt: String(row.captured_at ?? ""),
      sourceContentHash: String(row.source_content_hash ?? ""),
      validCount: Number(row.valid_count ?? 0)
    })).filter((row) => row.sourceContentHash);
  } catch {
    return [];
  }
}

async function loadLatestAuditMeta(env, subscriptionId) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return null;
  try {
    const result = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT created_at, action, reason, valid_count, content_hash FROM refresh_audit WHERE subscription_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .bind(subscriptionId)
      .first();
    if (!result) return null;
    return {
      lastRefreshAt: String(result.created_at ?? ""),
      lastAction: String(result.action ?? ""),
      lastReason: String(result.reason ?? ""),
      lastValidCount: Number(result.valid_count ?? 0),
      contentHash: result.content_hash ? String(result.content_hash) : ""
    };
  } catch {
    return null;
  }
}

async function loadStatus(env, subscriptionId, sourceMeta = null) {
  const audit = await loadLatestAuditMeta(env, subscriptionId);
  const state = await loadState(env, subscriptionId);
  const stateSourceAt = state?.sourceSnapshotAt ?? state?.updatedAt ?? "";
  return {
    lastRefreshAt: audit?.lastRefreshAt ?? state?.lastRefreshAt ?? state?.updatedAt ?? "",
    lastAction: audit?.lastAction ?? state?.lastAction ?? (state ? "published" : ""),
    lastReason: audit?.lastReason ?? state?.lastReason ?? "",
    lastValidCount: audit?.lastValidCount ?? Number(state?.validCount ?? state?.nodes?.length ?? 0),
    publishedAt: state?.updatedAt ?? "",
    sourceSnapshotAt: sourceMeta?.capturedAt ?? stateSourceAt,
    sourceStorage: sourceMeta ? "d1" : state?.sourceSnapshotAt ? "kv" : "",
    hasPublishedOutput: Boolean(state?.output || state?.nodes?.length)
  };
}

async function loadSourceSnapshotByHash(env, profileId, sourceContentHash) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return null;
  try {
    if (!await ensureSourceSnapshotSchema(env)) return null;
    const result = await env.SUBSCRIPTION_AUDIT
      .prepare("SELECT id, captured_at, source_content_hash, valid_count, nodes_json FROM source_snapshots WHERE subscription_id = ? AND source_content_hash = ? ORDER BY id DESC LIMIT 1")
      .bind(profileId, sourceContentHash)
      .first();
    if (!result?.nodes_json) return null;
    const nodes = JSON.parse(result.nodes_json);
    if (!Array.isArray(nodes)) return null;
    return {
      versionId: String(result.id ?? ""),
      capturedAt: String(result.captured_at ?? ""),
      sourceContentHash: String(result.source_content_hash ?? sourceContentHash),
      validCount: Number(result.valid_count ?? nodes.length),
      nodes
    };
  } catch {
    return null;
  }
}

async function ensureSourceSnapshotSchema(env) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return false;
  if (!sourceSnapshotSchemaPromise) {
    sourceSnapshotSchemaPromise = env.SUBSCRIPTION_AUDIT
      .prepare("CREATE TABLE IF NOT EXISTS source_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT NOT NULL, captured_at TEXT NOT NULL, source_content_hash TEXT NOT NULL, valid_count INTEGER NOT NULL, nodes_json TEXT NOT NULL, UNIQUE (subscription_id, source_content_hash))")
      .bind()
      .run()
      .then(() => true)
      .catch(() => {
        sourceSnapshotSchemaPromise = null;
        return false;
      });
  }
  return sourceSnapshotSchemaPromise;
}

async function writeAudit(env, profileId, result, now) {
  if (!env.SUBSCRIPTION_AUDIT?.prepare) return;
  try {
    await env.SUBSCRIPTION_AUDIT
      .prepare("INSERT INTO refresh_audit (subscription_id, created_at, action, reason, valid_count, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(
        profileId,
        now.toISOString(),
        result.action ?? "unknown",
        result.reason ?? "unknown",
        Number(result.validCount ?? 0),
        result.contentHash ?? null
      )
      .run();
  } catch {
    // Audit storage is best-effort. It must never replace a valid published state.
    console.log(JSON.stringify({ event: "audit-write-failed" }));
  }
}

async function reprocessStoredProfile(env, profile, now, settings, previous = null, fallbackReason = "historical-reprocess") {
  const state = previous ?? await loadState(env, profile.id);
  const snapshotNodes = await loadLatestSourceSnapshot(env, profile.id);
  const historicalNodes = snapshotNodes?.length > 0
    ? snapshotNodes
    : Array.isArray(state?.sourceNodes) && state.sourceNodes.length > 0
      ? state.sourceNodes
      : Array.isArray(state?.nodes) && state.nodes.length > 0
        ? state.nodes
        : [];
  if (historicalNodes.length === 0) {
    return { action: "keep", reason: "no-historical-valid-nodes" };
  }
  try {
    const candidate = await buildCandidateFromNodes(historicalNodes, {
      renameRules: profile.renameRules,
      nodeNameInclude: profile.nodeNameInclude,
      nodeNameIncludeAll: profile.nodeNameIncludeAll,
      nodeNameExclude: profile.nodeNameExclude,
      replaceAllFields: profile.replaceAllFields,
      minValidNodes: profile.minValidNodes,
      clashConfig: settings.clashConfig
    });
    if (!candidate.valid) return { action: "keep", reason: "historical-nodes-below-minimum", validCount: candidate.validCount };
    await writeSourceSnapshot(env, profile.id, candidate, now);
    const decision = await publishDecision(env, profile.id, decidePublication(candidate, state), now, {
      sourceOrigin: "historical-fallback",
      sourceSnapshotAt: state?.sourceSnapshotAt ?? now.toISOString()
    });
    if (decision.action === "keep") {
      return { ...decision, reason: fallbackReason, validCount: candidate.validCount };
    }
    return { ...decision, reason: fallbackReason };
  } catch (error) {
    return { action: "keep", reason: "historical-reprocess-error", error: error instanceof Error ? error.message : "unknown" };
  }
}

async function reprocessConfiguredProfiles(env, profiles, now = new Date(), settings = null) {
  const currentSettings = settings ?? await loadSettings(env);
  const results = [];
  for (const profile of profiles) {
    results.push({
      subscriptionId: profile.id,
      ...(profile.paused
        ? { action: "keep", reason: "paused" }
        : await reprocessStoredProfile(env, profile, now, currentSettings))
    });
  }
  const aggregate = await refreshAggregate(env, now, profiles, currentSettings);
  return { results, aggregate };
}

async function refreshProfile(env, profile, now, settings = null) {
  const finish = async (result) => {
    await writeAudit(env, profile.id, result, now);
    return result;
  };
  if (profile.paused) return finish({ action: "keep", reason: "paused" });
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return finish({ action: "keep", reason: "state-store-not-configured" });
  }
  const previous = await loadState(env, profile.id);
  const currentSettings = settings ?? await loadSettings(env);
  let rawText;
  try {
    rawText = await fetchSource(env, profile);
  } catch (error) {
    const fallback = await reprocessStoredProfile(env, profile, now, currentSettings, previous, "source-unavailable-use-last-good");
    return finish(fallback.reason === "no-historical-valid-nodes" ? {
      ...fallback,
      reason: "source-error",
      error: error instanceof Error ? error.message : "unknown"
    } : fallback);
  }

  let candidate;
  try {
    candidate = await buildCandidate(rawText, {
      renameRules: profile.renameRules,
      nodeNameInclude: profile.nodeNameInclude,
      nodeNameIncludeAll: profile.nodeNameIncludeAll,
      nodeNameExclude: profile.nodeNameExclude,
      replaceAllFields: profile.replaceAllFields,
      minValidNodes: profile.minValidNodes,
      clashConfig: currentSettings.clashConfig
    });
  } catch (error) {
    const fallback = await reprocessStoredProfile(env, profile, now, currentSettings, previous, "latest-parse-error-use-last-good");
    return finish(fallback.reason === "no-historical-valid-nodes" ? {
      ...fallback,
      reason: "parse-error",
      error: error instanceof Error ? error.message : "unknown"
    } : fallback);
  }

  if (candidate.sourceValidCount > 0) await writeSourceSnapshot(env, profile.id, candidate, now);
  const decision = decidePublication(candidate, previous);
  if (!candidate.valid) {
    const fallback = await reprocessStoredProfile(env, profile, now, currentSettings, previous, "latest-invalid-use-last-good");
    return finish(fallback.reason === "no-historical-valid-nodes" ? decision : fallback);
  }
  return finish(await publishDecision(env, profile.id, decision, now));
}

export async function refreshAll(env, now = new Date()) {
  const profiles = await loadProfiles(env);
  if (profiles.length === 0) return [{ action: "keep", reason: "no-subscriptions-configured" }];
  const settings = await loadSettings(env);
  const results = [];
  // Process sequentially to avoid a burst against upstream subscription providers.
  for (const profile of profiles) {
    results.push({
      subscriptionId: profile.id,
      ...(await refreshProfile(env, profile, now, settings))
    });
  }
  return results;
}

export async function refreshAggregate(env, now = new Date(), profiles = null, settings = null) {
  const finish = async (result) => {
    await writeAudit(env, AGGREGATE_STATE_ID, result, now);
    return result;
  };
  const sourceProfiles = profiles ?? await loadProfiles(env);
  if (sourceProfiles.length === 0) return finish({ subscriptionId: "all", action: "keep", reason: "no-subscriptions-configured" });
  if (!env.SUBSCRIPTION_STATE?.get || !env.SUBSCRIPTION_STATE?.put) {
    return finish({ subscriptionId: "all", action: "keep", reason: "state-store-not-configured" });
  }
  const currentSettings = settings ?? await loadSettings(env);
  const nodeGroups = [];
  for (const profile of sourceProfiles) {
    const state = await loadState(env, profile.id);
    if (Array.isArray(state?.nodes) && state.nodes.length > 0) nodeGroups.push(state.nodes);
  }
  const customNodes = parseAggregateCustomNodes(currentSettings.aggregateCustomNodes);
  let candidate;
  try {
    candidate = await buildAggregateCandidate(nodeGroups, {
      clashConfig: currentSettings.clashConfig,
      customNodes,
      customNodePosition: currentSettings.aggregateCustomNodePosition
    });
  } catch (error) {
    return finish({ subscriptionId: "all", action: "keep", reason: "aggregate-error", error: error instanceof Error ? error.message : "unknown" });
  }
  const previous = await loadState(env, AGGREGATE_STATE_ID);
  const decision = decidePublication(candidate, previous);
  if (decision.action === "keep") return finish({ subscriptionId: "all", ...decision });
  await saveState(env, AGGREGATE_STATE_ID, {
    version: 1,
    subscriptionId: "all",
    contentHash: decision.contentHash,
    validCount: decision.validCount,
    updatedAt: now.toISOString(),
    nodes: decision.nodes,
    output: decision.output
  });
  return finish({ subscriptionId: "all", ...decision });
}

export async function refreshEverything(env, now = new Date()) {
  const profiles = await loadProfiles(env);
  const results = await refreshAll(env, now);
  const aggregate = await refreshAggregate(env, now, profiles);
  return { results, aggregate };
}

export async function refresh(env, now = new Date()) {
  return (await refreshAll(env, now))[0];
}

function responseFromRendered(rendered) {
  const responseBody = rendered.contentType.startsWith("text/yaml") && !String(rendered.body).startsWith("\uFEFF")
    ? `\uFEFF${rendered.body}`
    : rendered.body;
  return new Response(responseBody, {
    status: 200,
    headers: {
      "content-type": rendered.contentType,
      "cache-control": "no-store",
      "vary": "User-Agent, Accept",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff"
    }
  });
}

async function serveExpiredSubscription(env, expiredSubscription, request) {
  const target = detectTarget(request, "clash");
  if (!target || !supportedTargets.includes(target)) {
    return json({ error: "unsupported-target", supportedTargets }, 406);
  }
  try {
    const settings = await loadSettings(env);
    const rendered = renderSubscription(buildExpiredDisplayNodes(expiredSubscription.nodeNames), target, settings.clashConfig);
    return responseFromRendered(rendered);
  } catch {
    return new Response("Expired subscription output is unavailable", { status: 503 });
  }
}

async function servePublishedState(env, stateId, defaultTarget, request) {
  const state = await loadState(env, stateId);
  if (!state?.output) return new Response("No valid subscription has been published yet", { status: 503 });
  const target = detectTarget(request, defaultTarget);
  if (!target || !supportedTargets.includes(target)) {
    return json({ error: "unsupported-target", supportedTargets }, 406);
  }

  let rendered;
  try {
    const settings = await loadSettings(env);
    // Older KV records contain only Clash YAML. Keep that format available
    // while requiring one successful refresh before serving other targets.
    rendered = state.nodes?.length
      ? renderSubscription(state.nodes, target, settings.clashConfig)
      : target === "clash"
        ? { body: state.output, contentType: "text/yaml; charset=utf-8" }
        : null;
  } catch {
    rendered = null;
  }
  if (!rendered) return new Response("This target is unavailable until the next valid refresh", { status: 503 });
  return responseFromRendered(rendered);
}

async function servePublished(env, profile, request) {
  return servePublishedState(env, profile.id, profile.defaultTarget, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
      });
    }
    if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env, url);
    const profiles = await loadProfiles(env);
    if (url.pathname === "/healthz") {
      return json({ ok: true, configured: profiles.length > 0, profiles: profiles.length });
    }
    if (request.method === "GET" && url.pathname.startsWith("/sub/")) {
      const token = url.pathname.slice("/sub/".length);
      const profile = profiles.find((item) => item.publicToken === token);
      if (profile) return servePublished(env, profile, request);
      const aggregateToken = await loadAggregateToken(env);
      if (token && aggregateToken && token === aggregateToken) {
        return servePublishedState(env, AGGREGATE_STATE_ID, "clash", request);
      }
      const expiredSubscription = await loadExpiredSubscription(env);
      if (token && expiredSubscription.tokens.includes(token)) {
        return serveExpiredSubscription(env, expiredSubscription, request);
      }
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    const now = new Date();
    const schedule = await scheduledRefreshDue(env, now);
    if (!schedule.due) {
      console.log(JSON.stringify({ event: "subscription-refresh-skipped", reason: "interval-not-due", intervalMinutes: schedule.settings.refreshIntervalMinutes }));
      return;
    }
    const refreshed = await refreshEverything(env, now);
    for (const result of [...refreshed.results, refreshed.aggregate]) {
      console.log(JSON.stringify({
        event: "subscription-refresh",
        subscriptionId: result.subscriptionId ?? null,
        action: result.action,
        reason: result.reason,
        validCount: result.validCount ?? 0
      }));
    }
  }
};

