# 复制到其他 Cloudflare 账号的完整部署手册

本手册用于把 Subscription Sync 部署到你自己的 Cloudflare 账号，也适合以后复制到另一个 Cloudflare Worker。

文档结构参考了 [cfnew 的 core-only 分支](https://github.com/byJoey/cfnew/tree/core-only)：把部署文件、变量说明、版本检查和故障排查写清楚，并明确区分“代码仓库”和“Cloudflare 账号资源”。本项目与 cfnew 的区别是：cfnew 将精简内核和独立面板分开；本项目把管理后台、订阅转换、定时刷新、KV 和 D1 控制面全部放在同一个 Worker 中，不需要额外部署面板。

## 1. 部署后是什么结构

    GitHub 仓库（公开代码、测试、migration、配置模板）
                              |
                              v
                  Cloudflare Worker（每个账号独立）
                       |                    |
                       v                    v
            SUBSCRIPTION_STATE KV    SUBSCRIPTION_AUDIT D1
            发布状态/兼容缓存         控制配置/审计/历史源节点

Worker 内置入口：

| 地址 | 用途 |
| --- | --- |
| /admin | 管理源订阅、筛选、改名、历史版本、汇总、用户分发地址和刷新间隔 |
| /healthz | 健康检查 |
| /api/admin/* | 需要 ADMIN_TOKEN 的管理接口 |
| /sub/<token> | 对外固定订阅链接，按客户端自动适配 |

D1 是控制面的最终数据源，KV 保存发布状态和兼容缓存。生产环境建议同时绑定 KV 与 D1。

## 2. 不要提交到 GitHub 的内容

公开仓库只保存代码和示例配置，以下内容必须留在 Cloudflare 或本地：

- 源头订阅地址，尤其是带 token 的完整 URL。
- ADMIN_TOKEN。
- 真实的 wrangler.toml、.dev.vars、.env。
- 导出的 D1 数据、历史 YAML、节点 UUID 和密码。
- 任何包含真实订阅链接的截图或日志。

仓库已经通过 .gitignore 忽略 wrangler.toml、.dev.vars、.env。KV ID 和 D1 ID 不是访问密码，但如果希望完全隐藏部署拓扑，也可以只放在私有部署仓库。

## 3. 推荐部署方式：GitHub + Wrangler

### 3.1 安装并克隆

需要 Node.js 18.18 或更高版本、Git 和一个有 Workers/KV/D1 权限的 Cloudflare 账号。

    git clone https://github.com/chongwuhou/subscription-sync.git
    Set-Location .\subscription-sync
    Copy-Item .\wrangler.toml.example .\wrangler.toml

登录 Cloudflare：

    npx wrangler login

浏览器授权后，Wrangler 会使用当前账号创建资源和发布 Worker。这个项目不需要调用付费 API。

### 3.2 创建 KV

    npx wrangler kv namespace create SUBSCRIPTION_STATE

把命令返回的 namespace ID 填到本地 wrangler.toml：

    [[kv_namespaces]]
    binding = "SUBSCRIPTION_STATE"
    id = "这里填写刚返回的 KV namespace ID"

SUBSCRIPTION_STATE 是绑定名称，不是普通文本变量。复制到另一个 Cloudflare 账号时，需要在新账号重新创建 KV，不能沿用旧账号 ID。

### 3.3 创建 D1

    npx wrangler d1 create subscription-sync-audit

把返回的 database ID 填到本地 wrangler.toml：

    [[d1_databases]]
    binding = "SUBSCRIPTION_AUDIT"
    database_name = "subscription-sync-audit"
    database_id = "这里填写刚返回的 D1 database ID"
    migrations_dir = "migrations"

D1 绑定名称必须是 SUBSCRIPTION_AUDIT。

### 3.4 检查本地 wrangler.toml

本地配置至少需要：

    name = "你的-worker-名称"
    main = "src/worker.js"
    compatibility_date = "2026-01-01"
    workers_dev = true
    preview_urls = false

    [[kv_namespaces]]
    binding = "SUBSCRIPTION_STATE"
    id = "你的 KV namespace ID"

    [[d1_databases]]
    binding = "SUBSCRIPTION_AUDIT"
    database_name = "subscription-sync-audit"
    database_id = "你的 D1 database ID"
    migrations_dir = "migrations"

    [triggers]
    crons = ["*/5 * * * *"]

name 可以改成自己的 Worker 名称。Cron 保持每 5 分钟触发，后台再根据实际设置决定是否真正抓取。这样才能支持 30 分钟、6 小时和 24 小时更新。

### 3.5 应用 D1 migration

首次部署前执行：

    npx wrangler d1 migrations apply subscription-sync-audit --remote

检查状态：

    npx wrangler d1 migrations list subscription-sync-audit --remote

当前会创建：

| 表 | 用途 |
| --- | --- |
| subscription_control | 订阅配置、刷新间隔、汇总 Token、过期地址 |
| refresh_audit | 刷新动作、原因和有效节点数 |
| source_snapshots | 按内容哈希保存历史有效源版本 |
| source_snapshot_chunks | 大型历史快照的分块存储 |

不要在生产环境直接删除这些表。历史版本、暂停版本和源站失联回退依赖它们。

### 3.6 设置管理员 Secret

    npx wrangler secret put ADMIN_TOKEN

按提示输入管理员令牌。输入内容不会显示，也不会写入 GitHub。不要把 ADMIN_TOKEN 写到 wrangler.toml 的 vars 中。

项目也兼容旧的环境配置，但新部署推荐只设置 ADMIN_TOKEN，然后进入 /admin 保存订阅到 D1：

    npx wrangler secret put SOURCE_URL
    npx wrangler secret put PUBLIC_PATH_TOKEN

上面两个旧变量只有在不使用后台多订阅管理时才需要。不要把真实值写进公开仓库。

### 3.7 检查并发布

    npm run check
    npm test
    npx wrangler deploy

发布成功后会得到类似：

    https://你的-worker-名称.你的账号.workers.dev

## 4. 首次上线检查

PowerShell 检查：

    $base = "https://你的-worker-域名"
    Invoke-WebRequest "$base/healthz" -UseBasicParsing
    Invoke-WebRequest "$base/admin" -UseBasicParsing

预期：

- /healthz 返回 HTTP 200。
- /admin 返回 HTTP 200。
- 未登录访问 /api/admin/subscriptions 返回 401。
- 页面能看到管理员令牌输入框和 D1 控制面提示。

然后打开：

    https://你的-worker-域名/admin

在页面直接输入 ADMIN_TOKEN，点击“进入管理”。令牌只保存在当前页面内存，不写浏览器存储。

## 5. 后台第一次配置

### 5.1 添加源订阅

点击“新增订阅”，填写：

1. 订阅名称 / ID：填写唯一值，例如 main。名称和 ID 前台只保留一个。
2. 完整源头订阅地址：把 ?token=... 一起粘贴，仅管理员可见。
3. 最低有效节点数：先用 1；如果源站经常返回不完整内容，可改高。
4. 节点名称组合筛选：可以全部留空。
5. 改名规则：点击“添加一行规则”，每行填写查找和替换为。
6. 默认输出：建议使用 clash；客户端会自动适配实际格式。

改名规则默认是普通文字匹配，不需要写 JSON。只有勾选“正则模式”时才按 JavaScript 正则处理。

点击底部“保存全部配置”。这个按钮会一次保存所有订阅、汇总节点、过期地址、分流配置和刷新间隔，并显示成功提示。

### 5.3 创建按用户分发的汇总地址

在“全部订阅汇总”下面找到“用户分发订阅（带到期展示节点）”，每一行对应一个用户：

1. 在“备注名称（仅自己可见）”填写对应用户或客户名称，例如 `张三`；这个备注不会进入订阅内容。
2. 在“到期日期”选择日期，例如 `2026-12-11`；系统会自动生成 `到期日期26-12-11` 作为唯一提示节点。
3. 点击“新增用户分发地址”，系统会生成一条独立的 `/sub/` 地址。
4. 复制该行地址给对应用户；到期日前，这一条地址会先输出日期提示节点，再输出当前汇总中的全部有效节点。
5. 到期当天（按 Asia/Shanghai 中国时区），系统会自动把该分发地址纳入旧汇总地址的过期逻辑，返回过期提示节点；后台“自动到期分发地址”列表会显示状态。手动旧地址仍然独立保留。
6. 如果需要更换路径，可以直接修改该行地址中 `/sub/` 后面的路径，再点击底部“保存全部配置”。

每个用户分发地址都会自动适配 Clash/Mihomo、Base64、sing-box、Surge/Shadowrocket 等输出格式。它只是在汇总输出前增加一个展示节点，不会修改源订阅、普通汇总地址或“已过期的旧汇总地址”。系统会阻止它与普通订阅、汇总地址和过期地址使用相同 Token。

### 5.4 设置刷新间隔

| 需求 | 后台填写 |
| --- | ---: |
| 30 分钟 | 30 |
| 6 小时 | 360 |
| 24 小时 | 1440 |

Cron 仍然每 5 分钟触发，但 Worker 会按后台保存的间隔决定是否请求源站。

### 5.5 复制订阅链接

保存后单订阅和汇总订阅都会显示固定地址：

    https://你的-worker-域名/sub/系统生成的路径

可以复制地址，也可以修改 /sub/ 后面的路径再保存。客户端只看到转换后的节点，不会看到源头订阅地址。

## 6. 抓取、历史和大文件保护

刷新流程：

    请求源站
      ├─ 200 且有有效节点：解析、筛选、改名、去重、发布
      ├─ 304：用历史节点重新执行当前规则
      ├─ 网络错误/超时/408/425/429/5xx：有限重试
      ├─ 空内容/解析失败/节点不足：不覆盖旧版本
      └─ 源站失效：读取 D1 最近有效历史源

已有版本会发送 If-None-Match 和 If-Modified-Since。默认额外重试 2 次，4xx、Cloudflare 挑战页和超大响应不会盲目重试。

每个订阅默认保留最近 30 个不同内容版本，并额外保护当前使用版本。可用变量调整：

    SOURCE_SNAPSHOT_RETENTION=30

大型历史源会自动写入 source_snapshot_chunks。单个节点大到无法安全分块时，只跳过这次历史写入，不会删除旧历史，也不会覆盖已发布版本。

如果源站暂时关闭，可以在对应订阅卡片中上传真实 YAML：

1. 展开对应订阅。
2. 选择“手动上传 YAML”。
3. 点击“上传并保存历史源”。
4. 在“历史内容版本”中确认版本已经出现。

不要把 YAML 上传到公开 GitHub，因为它可能包含 UUID、密码和服务器地址。

## 7. 多客户端输出

固定地址按 User-Agent 自动识别，也可以手动指定：

| 参数 | 输出 |
| --- | --- |
| ?target=clash | Clash/Mihomo YAML |
| ?target=base64 | Base64 分享链接，适合 V2RayNG 等 |
| ?target=sing-box | sing-box JSON，包含 urltest |
| ?target=surge | Surge/Shadowrocket 原生配置 |
| ?target=links | 原始分享链接列表 |

Clash/Mihomo 和 sing-box 默认生成自动测速/故障切换组。无法识别客户端时默认返回 Clash/Mihomo。

## 8. 自定义域名和跨账号复制

同一个 Worker 可以绑定多个域名。只要这些域名指向同一个 Worker 和同一组 KV/D1：

    https://domain-a.example/sub/同一个路径
    https://domain-b.example/sub/同一个路径

它们读取的是同一份发布状态。域名变化不会改变节点内容，但客户端订阅地址需要改成新域名。

复制到另一个 Cloudflare 账号：

    git clone https://github.com/chongwuhou/subscription-sync.git .\subscription-sync-other
    Set-Location .\subscription-sync-other
    Copy-Item .\wrangler.toml.example .\wrangler.toml
    npx wrangler login
    npx wrangler kv namespace create SUBSCRIPTION_STATE
    npx wrangler d1 create subscription-sync-audit
    # 把新账号返回的 ID 填入 wrangler.toml
    npx wrangler d1 migrations apply subscription-sync-audit --remote
    npx wrangler secret put ADMIN_TOKEN
    npm run check
    npm test
    npx wrangler deploy

旧账号的 KV、D1、订阅历史不会自动复制到新账号。新 Worker 部署后，在 /admin 重新添加源订阅。需要迁移历史时，应进行受控导出和导入，不要把 D1 文件提交到 GitHub。

## 9. GitHub 同步和自动部署

### 推荐：GitHub 保存代码，Wrangler 发布

后续更新：

    Set-Location .\subscription-sync
    git pull --ff-only origin main
    npm run check
    npm test
    npx wrangler deploy

GitHub 负责代码审查，Cloudflare 负责 Secret、KV、D1 和源订阅数据。

### Cloudflare Workers Builds

也可以在 Cloudflare 控制台选择 Workers & Pages → Create → Connect to Git，连接 GitHub 仓库。

因为公开仓库故意不包含真实 wrangler.toml，自动构建需要私有部署仓库或私有分支提供部署配置。建议：

    Root directory: /
    Build command: npm run check && npm test
    Deploy command: npx wrangler deploy

自动部署前确认：

1. KV ID 和 D1 ID 属于当前 Cloudflare 账号。
2. ADMIN_TOKEN 已在 Worker Production Secret 中设置。
3. D1 migration 已经执行。
4. 构建日志没有打印源订阅地址、Token、UUID 或完整节点。

如果构建找不到绑定，优先使用 Wrangler 部署，不要把真实凭据硬编码进公开仓库。

## 10. 可选变量

推荐日常配置都放在 /admin。以下变量用于初次部署、兼容旧环境和高级保护：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| ADMIN_TOKEN | 无 | 管理后台 Secret，必须设置 |
| SOURCE_RETRY_COUNT | 2 | 额外重试次数，范围 0-3 |
| SOURCE_TIMEOUT_MS | 15000 | 单次源站超时时间 |
| MAX_SOURCE_BYTES | 5242880 | 源站最大响应字节数 |
| SOURCE_SNAPSHOT_RETENTION | 30 | 历史版本保留数量，范围 3-100 |
| REFRESH_INTERVAL_MINUTES | 30 | D1 尚未保存设置时的默认间隔 |
| DEFAULT_TARGET | clash | 无法识别客户端时的格式 |
| ALLOW_HTTP_SOURCE | false | 只有源站无 HTTPS 时才改为 true |
| SOURCE_USER_AGENT | SubscriptionSync/1.0 | 源站请求 User-Agent |

SOURCE_URL、PUBLIC_PATH_TOKEN、SUBSCRIPTIONS_JSON 和 RENAME_RULES_JSON 是旧版兼容配置。使用 D1 控制面时，优先通过后台配置。

## 11. 故障排查

| 现象 | 检查 |
| --- | --- |
| /admin 打不开 | 检查 Worker 部署、域名路由和 Cloudflare Access/验证码。 |
| 输入令牌后 401 | 重新执行 npx wrangler secret put ADMIN_TOKEN，确认是 Production。 |
| 保存后重新读取为空 | 检查 KV/D1 是否绑定到同一个 Worker，并执行 D1 migration。 |
| 控制面显示 KV fallback | 确认绑定名是 SUBSCRIPTION_AUDIT，D1 ID 属于当前账号。 |
| 固定订阅 503 | 还没有首次成功版本，检查源地址、格式和最低节点数。 |
| 源站暂时关闭 | 不要删除历史；系统会使用 D1 最近有效源，也可以上传 YAML。 |
| Clash 中文乱码 | 强制使用 ?target=clash，并清除客户端订阅缓存后更新。 |
| V2RayNG 更新失败 | 使用 ?target=base64，不要让客户端按 Clash YAML 解析。 |
| Shadowrocket/Surge 不正确 | 使用 ?target=surge，确认 User-Agent 没被代理改写。 |
| 改名没有生效 | 先点预览；替换服务器、Host 等字段必须勾选允许替换全部字段。 |
| 历史版本太多 | 设置 SOURCE_SNAPSHOT_RETENTION；清理在后续写入新历史时执行。 |
| 上传后找不到 | 必须在对应订阅卡片上传，并展开历史内容版本。 |

## 12. 安全检查清单

- [ ] wrangler.toml 没有提交到公开 GitHub。
- [ ] ADMIN_TOKEN 只存在于 Cloudflare Secret。
- [ ] 源订阅 URL 只在 /admin 或私有 Secret 中保存。
- [ ] 未登录访问管理 API 返回 401。
- [ ] D1 migration 已执行。
- [ ] /healthz 返回 200。
- [ ] 首次刷新前不会生成空订阅。
- [ ] 源站异常时不会覆盖最后有效版本。
- [ ] GitHub/Cloudflare 构建日志没有打印源地址、Token、UUID 或完整节点。
- [ ] 公开订阅地址只发给需要使用的人。

## 13. 更新前检查

    git pull --ff-only origin main
    npm run check
    npm test
    npx wrangler d1 migrations list subscription-sync-audit --remote
    npx wrangler deploy

涉及新 migration 的版本，先执行 migration，再部署 Worker。不要使用 git reset --hard 覆盖本地配置，也不要把真实 wrangler.toml、.dev.vars 或导出的 D1 数据上传到 GitHub。


