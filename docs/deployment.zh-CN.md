# 部署指南

[English](deployment.md) | **简体中文**

## 准备条件

- Node.js 20+
- npm
- 支持 Workers、D1、R2 的 Cloudflare 账号
- 已完成 Wrangler 登录
- 已配置收发域名的 Mailgun 账号
- 可选：托管在 Cloudflare 的自定义网页域名

## 1. 安装与登录

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

## 2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create cloudflare-mailgun-webmail
npx wrangler r2 bucket create cloudflare-mailgun-webmail
```

把创建 D1 后返回的 `database_id` 写入本机的 `wrangler.toml`，并把 `INITIAL_EMAIL` 改为管理员邮箱地址。

如果 Mailgun 域名位于欧洲区，使用：

```toml
MAILGUN_API_BASE = "https://api.eu.mailgun.net"
```

## 3. 配置 Secret

```bash
npx wrangler secret put INITIAL_PASSWORD
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
```

- `INITIAL_PASSWORD`：第一个管理员的初始密码；
- `MAILGUN_API_KEY`：Mailgun Private API Key，用于发送和查询邮件；
- `MAILGUN_SIGNING_KEY`：Mailgun HTTP Webhook Signing Key，用于验证入站请求。

Secret 不要写入 `wrangler.toml`、`.dev.vars.example` 或 GitHub Actions 文件。

## 4. 执行数据库迁移

```bash
npm run db:remote
```

查看迁移状态：

```bash
npx wrangler d1 migrations list MAIL_DB --remote
```

## 5. 部署前验证

```bash
npm run typecheck
npx wrangler deploy --dry-run
npm audit
```

## 6. 部署 Worker

```bash
npm run deploy
```

## 7. 配置 Mailgun Receiving Route

匹配表达式示例：

```text
match_recipient(".*@example.com")
```

推荐 Actions：

```text
store()
forward("https://YOUR-WORKER/api/webhooks/mailgun/inbound")
stop()
```

`store()` 为轮询提供完整邮件，`forward()` 提供实时 Webhook。两者应同时启用。

## 8. 可选自定义域名

在本机生产 Wrangler 配置中添加：

```toml
routes = [
  { pattern = "mail.example.com", custom_domain = true }
]
```

重新部署后，把 Mailgun Webhook 地址改为自定义域名即可。不要在公开仓库中提交私人生产域名。

## 9. 首次登录

访问 `/login`，使用：

- 用户名：`INITIAL_EMAIL`
- 密码：`INITIAL_PASSWORD` Secret

首次登录后，用户和密码哈希会写入 D1。以后修改 Worker Secret 不会自动覆盖已经存在的账号密码。

## 日常运维

重置用户密码：

```bash
./scripts/reset-password.sh user@example.com
```

查看实时日志：

```bash
npx wrangler tail
```

导出 D1 备份：

```bash
npx wrangler d1 export MAIL_DB --remote --output backup.sql
```

备份中可能包含账号和邮件数据，禁止提交到 Git。

## 生产配置建议

建议把公开示例配置和生产配置分开：

```text
wrangler.toml             # 可公开的示例配置
wrangler.production.toml  # 本机生产配置，必须被 Git 忽略
```

使用独立生产配置部署：

```bash
npx wrangler d1 migrations apply MAIL_DB --remote --config wrangler.production.toml
npx wrangler deploy --config wrangler.production.toml
```

部署前检查：

```bash
git status --ignored
git grep -n "你的生产域名"
git log --format='%an <%ae>'
```

确保代码、文档、Git 元数据和仓库 Homepage 都不包含私人部署信息。
