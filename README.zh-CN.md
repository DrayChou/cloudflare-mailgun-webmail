# Cloudflare Mailgun Webmail

[English](README.md) | **简体中文**

一个运行在 Cloudflare Workers、D1 和 R2 上的轻量级多账号网页邮箱。当前主要使用 Mailgun 收发邮件，并为未来接入 Cloudflare Email Routing 和 Email Sending 保留了基础支持。

> 当前界面以中文为主，欢迎贡献国际化、邮件 Provider 抽象和其他基础邮箱功能。

## 主要功能

- 完全无服务器的 Cloudflare Workers 部署
- 使用完整邮箱地址登录，例如 `user@example.com`
- 通过 Worker 配置和 Secret 初始化第一个管理员
- 管理员可以在网页中创建多个邮箱账号
- 不同用户的收件箱、已发送、邮件详情和附件严格隔离
- 通过 Mailgun Messages API 发送邮件
- 支持多个收件人、抄送 CC、密送 BCC 和发件附件
- 支持回复和转发，并生成标准 `In-Reply-To`、`References` 头
- 验证 Mailgun 入站 Webhook 签名，防止重放请求
- 使用 Mailgun `store()` 和 Events API 每五分钟轮询一次
- 使用 D1 保存用户、会话、邮件、同步状态和发件审计
- 使用 R2 保存附件和原始 MIME 邮件
- 支持“立即同步”手动收取邮件
- 响应式收件箱、写邮件和邮件详情界面
- 支持用户修改密码和命令行重置密码
- 提供可选的 Cloudflare Email Routing `email()` Handler
- 包含可选的 Cloudflare Email Sending 代码路径

## 架构

```text
Mailgun
  ├─ Messages API ───────────────────────┐
  ├─ Routes Webhook ────────────────────┤
  └─ store() + Events 轮询 ─────────────┤
                                         ▼
浏览器 ── HTTPS ── Cloudflare Worker ── D1
                              │
                              └───────── R2
```

详细设计请参阅 [架构文档](docs/architecture.md)。

## 环境要求

- Node.js 20 或更高版本
- Cloudflare 账号
- Cloudflare Workers、D1 和 R2
- Mailgun 账号和已经配置收发能力的域名
- Wrangler 4.x

低流量个人使用通常可以控制在 Cloudflare 免费额度内。Mailgun 费用取决于账号套餐和实际用量。

## 快速开始

```bash
git clone https://github.com/DrayChou/cloudflare-mailgun-webmail.git
cd cloudflare-mailgun-webmail
npm ci
npx wrangler login
```

创建 D1 数据库和 R2 Bucket：

```bash
npx wrangler d1 create cloudflare-mailgun-webmail
npx wrangler r2 bucket create cloudflare-mailgun-webmail
```

修改 `wrangler.toml`：

```toml
[vars]
INITIAL_EMAIL = "admin@example.com"
MAILGUN_API_BASE = "https://api.mailgun.net"
MAILGUN_POLL_ENABLED = "true"
SESSION_TTL_DAYS = "30"

[[d1_databases]]
binding = "MAIL_DB"
database_name = "cloudflare-mailgun-webmail"
database_id = "YOUR_D1_DATABASE_ID"
migrations_dir = "migrations"
```

交互式配置生产 Secret：

```bash
npx wrangler secret put INITIAL_PASSWORD
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
```

执行数据库迁移并部署：

```bash
npm run db:remote
npm run typecheck
npm run deploy
```

更完整的部署步骤请参阅 [中文部署文档](docs/deployment.zh-CN.md) 或 [英文部署文档](docs/deployment.md)。

## Mailgun 收件配置

在 Mailgun 中为你的域名创建 Receiving Route。

匹配表达式示例：

```text
match_recipient(".*@example.com")
```

推荐操作顺序：

```text
store()
forward("https://YOUR-WORKER/api/webhooks/mailgun/inbound")
stop()
```

说明：

- `forward()` 用于接近实时地把邮件推送到 Worker；
- `store()` 让 Worker 可以在 Webhook 失败时独立轮询完整邮件；
- Cron Trigger 每五分钟检查一次 Mailgun，并自动去重；
- 建议同时启用 Webhook 和轮询，而不是只配置其中一种。

## 多账号机制

第一次使用 `INITIAL_EMAIL` 和 `INITIAL_PASSWORD` 登录时，系统会创建管理员账号。管理员之后可以在“邮箱账号”管理页面创建其他邮箱用户。

每个账号：

- 使用完整邮箱地址登录；
- 只能查看分配给自己 D1 用户 ID 的邮件；
- 只能下载自己的附件；
- 只能使用当前登录账号作为发件地址；
- 拥有独立密码和登录会话。

如果收到的邮件地址还没有对应账号，该邮件不会被分配给其他用户。请先由管理员创建完全匹配的邮箱账号。

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

`.dev.vars` 已被 Git 忽略，只应使用测试凭据，禁止放入公开仓库。

本地测试定时任务：

```bash
npx wrangler dev --test-scheduled
curl http://localhost:8787/__scheduled
```

## 密码重置

不删除邮件的情况下重置已有邮箱账号密码：

```bash
./scripts/reset-password.sh user@example.com
```

脚本会：

1. 交互式输入并确认新密码；
2. 在本机计算密码哈希；
3. 更新远端 D1；
4. 注销该用户原有会话。

## Cloudflare 邮件服务支持

项目已经导出兼容 Cloudflare Email Routing 的 `email()` Handler，并包含可选的 Email Sending 分支。Mailgun 仍然是当前默认 Provider。

当前 Cloudflare 原生邮件能力还需要继续完善：

- Email Routing 配置文档；
- Email Sending Binding 示例；
- 附件发送；
- 投递状态和退信处理；
- Mailgun 与 Cloudflare 之间统一的 Provider 接口。

详情参阅 [Provider 文档](docs/providers.md)。

## 安全原则

公开仓库中禁止出现：

- 真实部署域名或私人邮箱服务地址；
- Mailgun API Key 或 Webhook Signing Key；
- Cloudflare Token；
- 用户密码；
- 生产 D1 ID 或数据库导出；
- R2 邮件对象和附件；
- 真实邮件正文、邮件地址或个人信息；
- `.dev.vars`、`.wrangler` 和生产 Wrangler 配置。

生产 Secret 必须使用 `wrangler secret put` 配置。详细规则参阅 [安全策略](SECURITY.md)。

## 已知限制

- 暂无草稿箱、垃圾箱、归档和文件夹
- 暂无全文搜索、分页和标签
- 暂未接入投递、退信和投诉状态
- HTML 邮件尚未直接渲染；启用前必须完成严格清理和 iframe 沙箱隔离
- 管理界面暂不支持停用或删除账号
- Mail Provider 代码仍集中在 `src/index.ts`，后续需要模块化
- Cloudflare Email Sending 模式暂不支持发件附件

## 项目文档

- [English README](README.md)
- [中文部署文档](docs/deployment.zh-CN.md)
- [English Deployment Guide](docs/deployment.md)
- [架构文档](docs/architecture.md)
- [邮件 Provider](docs/providers.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 开源许可

本项目使用 [MIT License](LICENSE)。
