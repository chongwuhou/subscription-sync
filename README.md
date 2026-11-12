# Subscription Sync

一个可审计的开源订阅同步项目：自动抓取一个已有订阅，按规则重命名，转换成 Clash/Mihomo YAML，并生成一个稳定的通用订阅链接。

## 目标功能

本项目按以下规则实现：

1. 原始订阅地址只从私有配置读取，不写入源码。
2. 定时抓取原始订阅。
3. 支持常见 Clash YAML、JSON、Base64 分享链接格式，并覆盖 VMess、VLESS、Trojan、SS、SSR、Hysteria2、TUIC、HTTP/SOCKS5 等常见节点类型。
4. 按用户配置的正则规则改名。
5. 自动去重、排序并生成 Clash/Mihomo YAML。
6. 新内容有至少一个有效节点且哈希发生变化时才更新。
7. 没有变化时保留旧版本。
8. 新内容解析失败、为空或没有有效节点时保留旧版本。
9. 对外提供固定链接，更新内容时不要求客户端更换订阅地址。
10. 不发送邮件、不上传订阅内容到分析服务、不记录 Token、不接受公开 URL 参数。

## 开源与后门审查

- MIT License。
- 运行时代码没有遥测、广告、远程代码加载或隐藏管理入口。
- 没有依赖安装也可以运行核心测试；当前运行时依赖只有 JavaScript 标准能力。
- Cloudflare 配置只是示例，不会自动创建 Worker、KV 或任何账号资源。
- 真实的 `SOURCE_URL`、公开链接 Token 和重命名规则必须放在私有环境变量中。
- 详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [SECURITY.md](SECURITY.md)。

## 项目状态

当前还没有填写真实订阅地址，也没有调用 Cloudflare、创建 KV 或执行部署。项目先在本地完成核心逻辑和测试。

## 本地检查

需要 Node.js 18.18 或更高版本：

```text
npm test
npm run check
```

核心逻辑不需要访问网络。测试使用内置 Node.js 测试运行器，覆盖解析、重命名、去重、哈希变更门禁、空节点保护和 Worker 刷新流程。

## 配置概念

部署适配层预留以下配置：

- `SOURCE_URL`：原始订阅地址，必须是 `https://`；确实需要 HTTP 时必须显式设置 `ALLOW_HTTP_SOURCE=true`。
- `PUBLIC_PATH_TOKEN`：固定通用链接中的随机路径片段。
- `RENAME_RULES_JSON`：例如 `[{"pattern":"\\s+\\|\\s+","replacement":"-"}]`。
- `MIN_VALID_NODES`：最低有效节点数，默认 1。
- `SUBSCRIPTION_STATE`：保存最后一个成功版本的状态存储绑定。

`wrangler.toml.example` 只作为公开配置模板，不包含真实地址、Token 或命名空间 ID。

## 后续接入前的验收标准

- 原始订阅地址未配置时，服务不会尝试联网。
- 旧版本存在时，空订阅、解析失败和零有效节点都不能覆盖旧版本。
- 节点顺序变化但内容未变化时，不更新。
- 重命名规则变化时，内容哈希变化并生成新版本。
- 公开链接只返回最后一个成功版本。
- 日志中不能出现原始订阅 URL、Token、完整节点内容。

