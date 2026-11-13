# Cloudflare deployment

需要把项目复制到其他 Cloudflare 账号时，请优先阅读中文的[跨账号完整部署手册](CF_ACCOUNT_DEPLOYMENT.md)。本页保留基础资源说明和兼容配置参考。

这份文档只描述部署方式，不会自动创建 Cloudflare 资源，也不要求把任何密钥提交到 GitHub。

## 资源

单订阅版本需要：

- 一个 Cloudflare Worker
- 一个 KV namespace，绑定名为 `SUBSCRIPTION_STATE`
- 一个 Cron Trigger，基础触发频率为每 5 分钟；实际刷新间隔由后台设置控制，默认每 30 分钟

本项目当前已在目标 Cloudflare 账户中创建：

- KV：`subscription-sync-state`
- D1：`subscription-sync-audit`

生产 `wrangler.toml` 会记录这两个资源的账号 ID 以支持 GitHub 自动部署；这些 ID 不是访问凭据。公开仓库仍不记录任何订阅地址、Token、API 令牌或其他密钥。

生产部署的构建变量 `WRANGLER_SEND_METRICS=false` 已关闭 Wrangler 匿名遥测，`preview_urls = false` 已关闭预览链接。生产固定地址仍使用 `workers.dev`，方便后续生成稳定订阅链接。

D1 是生产控制面的最终来源。启用 `SUBSCRIPTION_AUDIT` 后，运行 `migrations/0001_audit.sql` 至 `migrations/0004_source_snapshot_chunks.sql`。`subscription_control` 保存后台订阅配置、刷新设置、汇总 Token 和过期地址；首次读取时会把旧 KV 配置迁移到 D1，之后以 D1 为准，KV 只作兼容缓存。除刷新审计外，`source_snapshots` 会保存每个源的历史有效节点 JSON，并按源内容哈希去重；默认保留最近 30 个不同版本，并额外保护当前正在使用的版本。超过安全大小的历史快照会写入 `source_snapshot_chunks` 分块表，无法安全分块时只跳过这次历史写入，不会覆盖现有发布版本。源站暂时不可用时，Worker 会读取最近快照重新套用当前规则。节点 JSON 可能包含 UUID、密码等敏感凭据，应限制 D1 管理访问。

## 多订阅配置

多订阅时使用一个私有的 `SUBSCRIPTIONS_JSON`，每个元素对应一个独立的源和固定链接：

```json
[
  {
    "id": "main",
    "name": "主订阅",
    "sourceUrl": "https://provider.example/sub?token=REDACTED",
    "publicToken": "main-random-token",
    "renameRules": [],
    "minValidNodes": 1
  }
]
```

Worker 为每个 `id` 使用独立的 KV key：`published-state-v1:<id>`，公开链接格式为 `/sub/<publicToken>`。一个源失败、无有效节点或没有变化时，不会覆盖其他源。

## 客户端格式适配

同一个固定链接会根据请求头自动选择格式：

- Clash、Clash Meta、Mihomo、Stash：Clash/Mihomo YAML。
- V2RayN、V2RayNG、Loon、Quantumult X 等：Base64 分享链接。
- Shadowrocket、Surge：原生 Surge `[Proxy]` / `[Proxy Group]` 配置。
- sing-box：sing-box JSON。
- 无法判断时：Clash/Mihomo YAML。

也可以用查询参数强制格式：`?target=clash`、`?target=base64`、`?target=sing-box`、`?target=surge`、`?target=links`。查询参数只选择输出格式，不允许传入或覆盖订阅源地址。

## 私有配置

不要把下列值写进公开仓库：

- `SOURCE_URL`：真实订阅地址，建议作为 Worker Secret。
- `PUBLIC_PATH_TOKEN`：通用订阅链接中的随机路径片段，建议作为 Worker Secret。
- `RENAME_RULES_JSON`：节点重命名规则；不含敏感信息时可以作为变量，但建议仍然单独配置。
- `ADMIN_TOKEN`：管理员后台令牌，必须作为 Worker Secret；没有它时 `/api/admin/*` 返回不可用。

可选配置：

- `MIN_VALID_NODES`：默认 `1`。
- `DEFAULT_TARGET`：无法识别客户端时的默认格式，默认 `clash`。
- `REFRESH_INTERVAL_MINUTES`：后台尚未保存设置时的刷新间隔，5-1440 分钟，按 5 分钟递增，默认 `30`。

部署后访问 `/admin`，输入 `ADMIN_TOKEN` 即可管理多个源和刷新间隔。后台保存的订阅配置写入受保护的 D1，并同步 KV 兼容缓存；管理员 API 不接受公开源地址参数，且不把源地址写入日志。后台状态面板显示最近刷新结果、有效节点数和历史源使用情况。

后台勾选“正则模式”时的改名规则示例：

```json
[
  {"pattern":"\\s*\\|\\s*","replacement":"-"}
]
```

这会把 `US | New York` 改成 `US-New York`。多个替换规则会按数组顺序执行，例如把地区统一成短名：
`[{"pattern":"香港","replacement":"HK"},{"pattern":"新加坡","replacement":"SG"}]`。
配置保存到 D1，并同步 KV 兼容缓存，重新打开后台仍会保留；6 小时和 24 小时分别填写 `360` 和 `1440` 分钟。
- `SOURCE_TIMEOUT_MS`：默认 `15000`。
- `MAX_SOURCE_BYTES`：默认 `5242880`。
- `SOURCE_RETRY_COUNT`：额外重试次数，默认 `2`，范围 `0-3`；只对网络错误、超时、408/425/429 和 5xx 重试。
- `SOURCE_SNAPSHOT_RETENTION`：每个订阅保留的不同历史源版本数，默认 `30`，范围 `3-100`。
- `ALLOW_HTTP_SOURCE=true`：只有上游确实没有 HTTPS 时才启用。

## 发布行为

Cron 触发器执行刷新：

1. Worker 读取私有 `SOURCE_URL`，或读取多订阅的 `SUBSCRIPTIONS_JSON`；已有版本会带上 `If-None-Match` / `If-Modified-Since` 条件请求。
2. 解析、重命名、去重、排序并验证节点。
3. 没有有效节点时保留 D1/KV 中的最后成功版本。
4. 内容哈希不变时不写 KV。
5. 内容有效且哈希变化时才替换 KV 中的发布版本。
6. 公共链接只读取 KV，不会把上游地址暴露给客户端。

如果源站返回 `304 Not Modified`，Worker 会直接基于最近有效源节点重新执行当前规则，不重复下载内容；临时失败会有限重试，非临时 4xx、Cloudflare 挑战页和超大响应会立即进入历史回退流程。

首次没有成功版本时，如果上游为空或解析失败，公共链接返回 `503`，不会生成空订阅。

## 部署前检查

```text
npm test
npm run check
```

部署后应先访问 `/healthz`，再确认固定订阅路径在首次成功刷新后按客户端返回对应格式。不要把真实返回内容、订阅 Token 或 Worker Secret 粘贴到公开 Issue、提交记录或日志中。

