# Subscription Sync

一个可审计的开源订阅同步项目：自动抓取一个已有订阅，按规则重命名，转换成 Clash/Mihomo YAML，并生成一个稳定的通用订阅链接；Clash 输出还支持代理组、Rule Providers 和分流规则。

## 目标功能

本项目按以下规则实现：

1. 一个 Worker 可以管理多个独立订阅源，每个源拥有独立的规则、状态和固定链接。
2. 原始订阅地址只从私有配置读取，不写入源码。
3. 定时抓取原始订阅，多个源按顺序处理，避免同时冲击上游。
4. 支持常见 Clash YAML、JSON、Base64 分享链接格式，并覆盖 VMess、VLESS、Trojan、SS、SSR、Hysteria2、TUIC、AnyTLS、HTTP/SOCKS5 等常见节点类型；Clash/Mihomo 节点字段会原样保留。
5. 按每个订阅源配置的正则规则改名。
6. 自动去重、排序并生成 Clash/Mihomo YAML。
7. 新内容有至少一个有效节点且哈希发生变化时才更新对应订阅。
8. 没有变化时保留对应旧版本。
9. 新内容解析失败、为空或没有有效节点时只保留当前源旧版本，不影响其他订阅。
10. 对外提供每个源的固定链接，更新内容时不要求客户端更换订阅地址。
11. 同一固定链接根据客户端 User-Agent 自动适配 Clash/Mihomo、Base64 分享链接或 sing-box，也支持 `?target=` 强制指定格式；AnyTLS 可输出 Clash/Mihomo、AnyTLS 单行链接、Base64 和 sing-box。
12. 不发送邮件、不上传订阅内容到分析服务、不记录 Token、不接受公开源地址参数。
13. 每次抓取到满足最低有效节点数的源节点快照都会保存到 D1；源站暂时不可用时，从最近有效快照重新套用当前改名和 Clash 配置。
14. Clash/Mihomo 配置可在后台统一维护代理组、Rule Providers 和 `rules`；代理组中的 `{{NODES}}` 会自动展开为当前有效节点。
15. 管理员可以为单个订阅手动上传 Clash YAML；上传内容验证通过后会作为该订阅的历史源保存到 D1（D1 暂不可用时使用 KV 兜底），并立即参与单订阅和汇总订阅。

## 开源与后门审查

- MIT License。
- 运行时代码没有遥测、广告、远程代码加载或隐藏管理入口。
- 没有依赖安装也可以运行核心测试；当前运行时依赖只有 JavaScript 标准能力。
- `wrangler.toml` 只包含 Worker、KV 和 D1 的公开绑定配置，不包含订阅地址、Token 或密钥。
- 部署构建变量已关闭 Wrangler 匿名遥测，预览 URL 已关闭。
- 真实的 `SOURCE_URL`、公开链接 Token 和重命名规则必须放在私有环境变量中。
- 详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [SECURITY.md](SECURITY.md)。

## 项目状态

Worker 已通过 GitHub 自动部署到 `https://subscription-sync.chongwuhou.workers.dev`，并绑定 `subscription-sync-state` KV、`subscription-sync-audit` D1 和每 5 分钟基础 Cron；实际刷新间隔可在管理员后台设置，默认每 30 分钟。D1 的 `source_snapshots` 表保存每个源的历史有效节点快照，按源内容哈希去重，不会因短暂源站失联而丢失可用数据。

## 本地检查

需要 Node.js 18.18 或更高版本：

```text
npm test
npm run check
```

核心逻辑不需要访问网络。测试使用内置 Node.js 测试运行器，覆盖解析、重命名、去重、哈希变更门禁、空节点保护、多订阅隔离和 Worker 刷新流程。

## 配置概念

部署适配层预留以下配置：

- `SOURCE_URL`：原始订阅地址，必须是 `https://`；确实需要 HTTP 时必须显式设置 `ALLOW_HTTP_SOURCE=true`。
- `PUBLIC_PATH_TOKEN`：固定通用链接中的随机路径片段。
- `RENAME_RULES_JSON`：例如 `[{"pattern":"\\s+\\|\\s+","replacement":"-"}]`。
- `MIN_VALID_NODES`：最低有效节点数，默认 1。
- `DEFAULT_TARGET`：无法从 User-Agent 判断时的默认输出格式，默认 `clash`。
- `CLASH_CONFIG_JSON`：可选的 Clash/Mihomo 分流配置 JSON；后台保存的配置优先于该环境变量。
- `SUBSCRIPTION_STATE`：保存最后一个成功版本的状态存储绑定。
- `SUBSCRIPTIONS_JSON`：多订阅配置。配置后优先于单订阅变量，例如：
- `ADMIN_TOKEN`：管理员后台令牌，必须作为 Cloudflare Secret 设置；未设置时后台 API 保持关闭。

```json
[
  {
    "id": "main",
    "name": "主订阅",
    "sourceUrl": "https://provider.example/sub?token=REDACTED",
    "publicToken": "main-random-token",
    "renameRules": [{"pattern": "\\s+\\|\\s+", "replacement": "-"}],
    "minValidNodes": 1,
    "defaultTarget": "clash"
  },
  {
    "id": "backup",
    "name": "备用订阅",
    "sourceUrl": "https://backup.example/sub?token=REDACTED",
    "publicToken": "backup-random-token"
  }
]
```

自动刷新和 Cloudflare 配置说明见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

固定链接默认自动识别客户端，也可以显式指定：`?target=clash`、`?target=base64`、`?target=sing-box` 或 `?target=links`。`mihomo`、`stash` 等别名会映射到 Clash YAML；V2Ray、Shadowrocket、Surge、Loon、Quantumult X 等别名会映射到 Base64 分享链接。

管理员后台地址为 `/admin`。输入 `ADMIN_TOKEN` 后可维护源头订阅地址、改名规则、多订阅 Token、最低有效节点数、默认输出格式、自动刷新间隔，以及统一的 Clash/Mihomo 分流配置；每个订阅还可以手动上传 YAML 作为历史源；令牌只在当前页面内存中使用，不写入浏览器存储。

Clash 分流配置示例（后台的折叠项中填写）：

```json
{
  "proxy-groups": [
    {"name":"PROXY","type":"select","proxies":["DIRECT","{{NODES}}"]}
  ],
  "rule-providers": {
    "ads": {
      "type":"http",
      "behavior":"domain",
      "url":"https://rules.example.com/ads.yaml",
      "path":"./ruleset/ads.yaml",
      "interval":86400
    }
  },
  "rules": ["RULE-SET,ads,REJECT","MATCH,PROXY"]
}
```

其中 `{{NODES}}` 是项目提供的占位符，会被替换成汇总订阅当前所有有效节点。Rule Provider 地址不会由项目偷偷注入，建议只填写自己信任的公开规则源。

改名规则可以直接复制下面的案例到后台的“改名规则 JSON”框：

```json
[
  {"pattern":"\\s*\\|\\s*","replacement":"-"}
]
```

上例会把 `US | New York` 改成 `US-New York`。也可以按顺序组合规则，例如：
`[{"pattern":"香港","replacement":"HK"},{"pattern":"新加坡","replacement":"SG"}]`。
保存后配置写入 Cloudflare KV，重新打开后台仍会保留；6 小时和 24 小时分别填写 `360` 和 `1440` 分钟。

`wrangler.toml.example` 是不绑定账号资源的公开模板；生产 `wrangler.toml` 只记录资源 ID，真实地址、Token 和规则仍放在 Cloudflare 私有配置中。

## 后续接入前的验收标准

- 原始订阅地址未配置时，服务不会尝试联网。
- 旧版本存在时，空订阅、解析失败和零有效节点都不能覆盖旧版本。
- 节点顺序变化但内容未变化时，不更新。
- 重命名规则变化时，内容哈希变化并生成新版本。
- 公开链接只返回最后一个成功版本。
- 日志中不能出现原始订阅 URL、Token、完整节点内容。

