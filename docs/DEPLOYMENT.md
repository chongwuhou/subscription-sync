# Cloudflare deployment

这份文档只描述部署方式，不会自动创建 Cloudflare 资源，也不要求把任何密钥提交到 GitHub。

## 资源

单订阅版本需要：

- 一个 Cloudflare Worker
- 一个 KV namespace，绑定名为 `SUBSCRIPTION_STATE`
- 一个 Cron Trigger，示例配置为每 30 分钟刷新

本项目当前已在目标 Cloudflare 账户中创建：

- KV：`subscription-sync-state`
- D1：`subscription-sync-audit`

生产 `wrangler.toml` 会记录这两个资源的账号 ID 以支持 GitHub 自动部署；这些 ID 不是访问凭据。公开仓库仍不记录任何订阅地址、Token、API 令牌或其他密钥。

生产部署的构建变量 `WRANGLER_SEND_METRICS=false` 已关闭 Wrangler 匿名遥测，`preview_urls = false` 已关闭预览链接。生产固定地址仍使用 `workers.dev`，方便后续生成稳定订阅链接。

D1 是可选项。启用 `SUBSCRIPTION_AUDIT` 后，运行 `migrations/0001_audit.sql`，它只保存刷新时间、动作、原因、有效节点数和内容哈希，不保存原始订阅地址、Token 或生成的订阅正文。

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

## 私有配置

不要把下列值写进公开仓库：

- `SOURCE_URL`：真实订阅地址，建议作为 Worker Secret。
- `PUBLIC_PATH_TOKEN`：通用订阅链接中的随机路径片段，建议作为 Worker Secret。
- `RENAME_RULES_JSON`：节点重命名规则；不含敏感信息时可以作为变量，但建议仍然单独配置。

可选配置：

- `MIN_VALID_NODES`：默认 `1`。
- `SOURCE_TIMEOUT_MS`：默认 `15000`。
- `MAX_SOURCE_BYTES`：默认 `5242880`。
- `ALLOW_HTTP_SOURCE=true`：只有上游确实没有 HTTPS 时才启用。

## 发布行为

Cron 触发器执行刷新：

1. Worker 读取私有 `SOURCE_URL`，或读取多订阅的 `SUBSCRIPTIONS_JSON`。
2. 解析、重命名、去重、排序并验证节点。
3. 没有有效节点时保留 KV 中的最后成功版本。
4. 内容哈希不变时不写 KV。
5. 内容有效且哈希变化时才替换 KV 中的发布版本。
6. 公共链接只读取 KV，不会把上游地址暴露给客户端。

首次没有成功版本时，如果上游为空或解析失败，公共链接返回 `503`，不会生成空订阅。

## 部署前检查

```text
npm test
npm run check
```

部署后应先访问 `/healthz`，再确认固定订阅路径在首次成功刷新后返回 `text/yaml`。不要把真实返回内容、订阅 Token 或 Worker Secret 粘贴到公开 Issue、提交记录或日志中。

