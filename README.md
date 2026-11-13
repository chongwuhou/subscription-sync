# Subscription Sync

一个可审计的开源订阅同步项目：自动抓取一个已有订阅，按规则重命名，转换成 Clash/Mihomo YAML，并生成一个稳定的通用订阅链接；Clash 输出还支持代理组、Rule Providers 和分流规则。

## 目标功能

本项目按以下规则实现：

1. 一个 Worker 可以管理多个独立订阅源，每个源拥有独立的规则、状态和固定链接。
2. 原始订阅地址只从私有配置读取，不写入源码。
3. 定时抓取原始订阅，多个源按顺序处理，避免同时冲击上游。
4. 支持常见 Clash YAML、JSON、Base64 分享链接格式，并覆盖 VMess、VLESS、Trojan、SS、SSR、Hysteria2、TUIC、AnyTLS、WireGuard、HTTP/SOCKS5 等常见节点类型；Clash/Mihomo 字段、sing-box 的传输层、Reality、TLS 指纹等关键字段会保留或映射。
5. 按每个订阅源配置的正则规则改名。
6. 自动去重、排序并生成 Clash/Mihomo YAML；只有连接和协议字段完全相同、仅节点名称不同的节点才会被合并。
7. 新内容有至少一个有效节点且哈希发生变化时才更新对应订阅。
8. 没有变化时保留对应旧版本。
9. 新内容解析失败、为空或没有有效节点时只保留当前源旧版本，不影响其他订阅。
10. 对外提供每个源的固定链接，更新内容时不要求客户端更换订阅地址。
11. 同一固定链接根据客户端 User-Agent 自动适配 Clash/Mihomo、Base64 分享链接、原生 Surge/Shadowrocket 配置或 sing-box，也支持 `?target=` 强制指定格式；AnyTLS 可输出 Clash/Mihomo、AnyTLS 单行链接、Base64、原生 Surge 和 sing-box。
12. 不发送邮件、不上传订阅内容到分析服务、不记录 Token、不接受公开源地址参数。
13. 每次抓取到满足最低有效节点数的源节点快照都会保存到 D1，并按源内容哈希去重；历史版本默认保留最近 30 个不同版本，并额外保护当前正在使用的版本；超过单行安全大小的快照会拆分到 D1 子表，过大的单节点快照会安全跳过历史写入，不影响现有发布版本。源站暂时不可用时，从最近有效快照重新套用当前改名和 Clash 配置。
14. Clash/Mihomo 配置可在后台统一维护代理组、Rule Providers 和 `rules`；代理组中的 `{{NODES}}` 会自动展开为当前有效节点。
15. 管理员可以为单个订阅手动上传 Clash YAML；上传内容验证通过后会作为该订阅的历史源保存到 D1（D1 暂不可用时使用 KV 兜底），并立即参与单订阅和汇总订阅。
16. 每个订阅后台会列出内容确实不同的历史版本，管理员可以选择某个版本重新套用当前规则并立即发布；也可以在使用版本时勾选暂停自动更新，固定该版本，之后定时刷新和手动刷新都会跳过该订阅。
17. “全部订阅汇总”支持额外维护自定义节点链接，每行一个，可选择插入汇总节点的顶部或尾部；这些节点只加入汇总地址，不会改变任何单独订阅。
18. 后台显示每个订阅和汇总的最近刷新、处理结果、有效节点数、最近有效源和最近发布时间；控制配置以 D1 为权威来源，KV 仅作为兼容缓存。
19. 源站抓取支持 `ETag` / `Last-Modified` 条件请求；遇到超时、网络错误、408/425/429 或 5xx 时进行有限指数退避重试，4xx、挑战页和超大响应不会盲目重试。
20. 汇总订阅下方可以创建多个“用户分发订阅”：每行一个展示文字和独立地址。分发地址会在汇总节点最上方插入一个只用于显示到期日期的提示节点，不改变原有汇总订阅和“已过期旧地址”模块。

## 开源与后门审查

- MIT License。
- 运行时代码没有遥测、广告、远程代码加载或隐藏管理入口。
- 没有依赖安装也可以运行核心测试；当前运行时依赖只有 JavaScript 标准能力。
- `wrangler.toml` 只包含 Worker、KV 和 D1 的公开绑定配置，不包含订阅地址、Token 或密钥。
- 部署构建变量已关闭 Wrangler 匿名遥测，预览 URL 已关闭。
- 真实的 `SOURCE_URL`、公开链接 Token 和重命名规则必须放在私有环境变量中。
- 详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [SECURITY.md](SECURITY.md)。

## 项目状态

Worker 已通过 GitHub 自动部署到 `https://subscription-sync.chongwuhou.workers.dev`，并绑定 `subscription-sync-state` KV、`subscription-sync-audit` D1 和每 5 分钟基础 Cron；实际刷新间隔可在管理员后台设置，默认每 30 分钟。D1 的 `subscription_control` 保存管理员控制配置，`source_snapshots` 保存每个源的历史有效节点快照，均按内容版本去重；KV 只保存发布状态和兼容缓存。源站暂时失联时不会丢失最近有效数据，后台状态面板会显示当前使用的是实时源还是历史快照。

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
- `INCLUDE_NODE_NAMES` / `EXCLUDE_NODE_NAMES`：可选的节点名称包含/排除关键词，多个关键词用 `|`、逗号或换行分隔；先过滤原始名称，再执行改名。
- `INCLUDE_NODE_NAMES_ALL`：可选的节点名称“且”过滤，多个关键词必须全部命中。
- `RENAME_RULES_JSON`：例如 `[{"pattern":"\\s+\\|\\s+","replacement":"-"}]`。
- `MIN_VALID_NODES`：最低有效节点数，默认 1。
- `DEFAULT_TARGET`：无法从 User-Agent 判断时的默认输出格式，默认 `clash`；支持 `clash`、`base64`、`links`、`sing-box` 和原生 `surge`。
- `SOURCE_RETRY_COUNT`：源站临时错误的额外重试次数，默认 2，范围 0-3。
- `SOURCE_SNAPSHOT_RETENTION`：每个订阅保留的不同 D1 历史源版本数，默认 30，范围 3-100；当前正在使用的版本会额外保留。
- `CLASH_CONFIG_JSON`：可选的 Clash/Mihomo 分流配置 JSON；后台保存的配置优先于该环境变量。
- `SUBSCRIPTION_STATE`：保存最后一个成功版本、公开输出和兼容缓存的 KV 绑定；管理员控制配置的最终来源是 `SUBSCRIPTION_AUDIT` 对应的 D1。
- `SUBSCRIPTION_AUDIT`：保存刷新审计、历史源快照和 `subscription_control` 控制面表；生产环境应限制该 D1 的管理访问。
- `SUBSCRIPTIONS_JSON`：多订阅配置。配置后优先于单订阅变量，例如：
- `ADMIN_TOKEN`：管理员后台令牌，必须作为 Cloudflare Secret 设置；未设置时后台 API 保持关闭。

```json
[
  {
    "id": "main",
    "name": "主订阅",
    "sourceUrl": "https://provider.example/sub?token=REDACTED",
    "publicToken": "main-random-token",
    "nodeNameInclude": "美国|VIP2",
    "nodeNameIncludeAll": "美国|VIP",
    "nodeNameExclude": "到期|续费",
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

自动刷新和 Cloudflare 配置说明见 [基础部署说明](docs/DEPLOYMENT.md)；如果要复制到其他 Cloudflare 账号，请按[跨账号完整部署手册](docs/CF_ACCOUNT_DEPLOYMENT.md)操作。该手册包含 Wrangler、KV、D1 migration、Secret、GitHub 自动部署、域名迁移和故障排查步骤。

固定链接默认自动识别客户端，也可以显式指定：`?target=clash`、`?target=base64`、`?target=sing-box`、`?target=surge` 或 `?target=links`。`mihomo`、`stash` 等别名会映射到 Clash YAML；Shadowrocket、Surge 会得到原生 `[Proxy]` / `[Proxy Group]` 配置；V2Ray、Loon、Quantumult X 等别名会映射到 Base64 分享链接。Clash/Mihomo 和 sing-box 都默认生成自动测速/故障切换组。

管理员后台地址为 `/admin`。输入 `ADMIN_TOKEN` 后可维护源头订阅地址、改名规则、多订阅 Token、最低有效节点数、默认输出格式、自动刷新间隔，以及统一的 Clash/Mihomo 分流配置；“全部订阅汇总”区域还可以每行填写一个自定义节点链接，并选择放在汇总顶部或尾部，这些节点只影响汇总地址。汇总区域下方的“用户分发订阅”可以为不同用户各建一条独立地址：备注名称只供管理员识别，不会输出给用户；选择固定的到期日期后，系统自动生成“到期日期26-12-11”这类提示节点，再接上当前汇总节点；到期当天（按中国时区）该分发地址会自动纳入旧汇总地址的过期逻辑，停止返回正常汇总节点。每行可单独复制、修改 `/sub/` 后路径或删除；旧汇总区域会同时列出手动旧地址和自动到期分发地址。它与普通汇总地址并行，地址 Token 不会互相冲突。每个订阅还可以手动上传 YAML 作为历史源，并在“历史内容版本”中选择不同内容重新发布。选择历史版本时勾选“同时暂停自动更新”即可固定该版本；也可以取消订阅卡片里的暂停勾选并保存，恢复正常自动更新。令牌只在当前页面内存中使用，不写入浏览器存储。前台改名规则使用“查找 / 替换为”逐行编辑，默认按普通文字匹配，不需要填写 JSON 或转义；勾选“正则模式”后才按 JavaScript 正则匹配，多个规则按页面顺序执行，替换内容留空表示删除。

后台还可以更换“全部订阅汇总”的公共地址，并把旧的汇总地址放入“已过期的旧汇总地址”。这样新地址继续返回正常汇总节点，旧地址仍然可访问但只返回三个可自定义名称的提示节点（仅用于展示，不保证连通），适合提示用户改用新的汇总地址。旧地址可以每行填写一个，多个历史地址都会显示同一组过期提示。

Clash 分流配置示例（后台的折叠项中填写）：

```json
{
  "proxy-groups": [
    {"name":"PROXY","type":"url-test","url":"https://www.gstatic.com/generate_204","interval":300,"tolerance":50,"lazy":false,"proxies":["{{NODES}}"]}
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

其中 `{{NODES}}` 是项目提供的占位符，会被替换成当前所有有效节点。默认的 `url-test` 每 5 分钟测试节点延迟，节点失联时自动跳过并选择其他可用节点；这测的是可达性和延迟，不是带宽测速，不需要在后台手动设置。Rule Provider 地址不会由项目偷偷注入，建议只填写自己信任的公开规则源。sing-box 输出也默认生成对应的 `urltest` 组，默认测试地址为 `https://www.gstatic.com/generate_204`。

改名规则可以在后台逐行填写“查找”和“替换为”；默认按普通文字匹配，不需要写 JSON 或转义。需要正则时勾选“正则模式”，再填写下面的案例：

```json
[
  {"pattern":"\\s*\\|\\s*","replacement":"-"}
]
```

上例会把 `US | New York` 改成 `US-New York`。也可以按顺序组合规则，例如：
`[{"pattern":"香港","replacement":"HK"},{"pattern":"新加坡","replacement":"SG"}]`。
保存后配置写入 Cloudflare D1，并同步到 Cloudflare KV 兼容缓存，重新打开后台仍会保留；6 小时和 24 小时分别填写 `360` 和 `1440` 分钟。

节点过滤在改名规则之前执行，后台按“组合条件”填写：必须包含 `VIP2`，以下任意一个填写 `美国1|美国2|美国3`，排除任意一个填写 `到期|续费`，最终就是 `VIP2 且（美国1/美国2/美国3 任意一个）`，并排除到期或续费。关键词是不区分大小写的名称包含匹配，三项都留空就是不过滤。过滤后有效节点不足最低数量时不会覆盖旧订阅，但未过滤的有效源节点仍会保存到 D1 历史快照，方便之后调整过滤条件重新处理。

`wrangler.toml.example` 是不绑定账号资源的公开模板；生产 `wrangler.toml` 只记录资源 ID，真实地址、Token 和规则仍放在 Cloudflare 私有配置中。模板中的 D1 migration 会同时创建历史快照分块表。

## 后续接入前的验收标准

- 原始订阅地址未配置时，服务不会尝试联网。
- 旧版本存在时，空订阅、解析失败和零有效节点都不能覆盖旧版本。
- 节点顺序变化但内容未变化时，不更新。
- 重命名规则变化时，内容哈希变化并生成新版本。
- 公开链接只返回最后一个成功版本。
- 日志中不能出现原始订阅 URL、Token、完整节点内容。

