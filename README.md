# Cloudflare Mailgun Webmail

**English** | [简体中文](README.zh-CN.md)

A lightweight, multi-account webmail application running on Cloudflare Workers, D1, and R2. Mailgun is the primary mail provider; Cloudflare Email Routing and Email Sending are planned as first-class alternatives.

> The UI is currently Chinese-first. Contributions for localization and provider abstraction are welcome.

## Features

- Serverless deployment on Cloudflare Workers
- Full email-address login (`user@example.com`)
- Initial administrator bootstrap through Worker configuration and a secret
- Multiple mailbox accounts managed from the administrator UI
- Per-user inbox, sent mail, message detail, and attachment isolation
- Mailgun Messages API sending with multiple To recipients, CC, BCC, and attachments
- Reply and forward compose flows with standard reply headers
- Mailgun inbound webhook signature verification and replay protection
- Mailgun `store()` + Events API polling every five minutes
- D1 storage for users, sessions, messages, sync state, and send audits
- R2 storage for attachments and raw MIME messages
- Manual “fetch mail now” action
- Responsive inbox and message-detail UI
- Password change and CLI password reset
- Optional Cloudflare Email Routing `email()` handler
- Optional Cloudflare Email Sending code path

## Architecture

```text
Mailgun
  ├─ Messages API ───────────────────────┐
  ├─ Routes webhook ────────────────────┤
  └─ store() + Events polling ──────────┤
                                         ▼
Browser ── HTTPS ── Cloudflare Worker ── D1
                              │
                              └───────── R2
```

See [docs/architecture.md](docs/architecture.md) for details.

## Requirements

- Node.js 20+
- Cloudflare account
- Cloudflare Workers, D1, and R2
- Mailgun account and a configured sending/receiving domain
- Wrangler 4.x

For low-volume personal use, Cloudflare resources may remain within free allowances. Mailgun pricing depends on your account and usage.

## Quick start

```bash
git clone https://github.com/DrayChou/cloudflare-mailgun-webmail.git
cd cloudflare-mailgun-webmail
npm ci
npx wrangler login
```

Create Cloudflare resources:

```bash
npx wrangler d1 create cloudflare-mailgun-webmail
npx wrangler r2 bucket create cloudflare-mailgun-webmail
```

Update `wrangler.toml`:

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

Configure production secrets interactively:

```bash
npx wrangler secret put INITIAL_PASSWORD
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
```

Apply migrations and deploy:

```bash
npm run db:remote
npm run typecheck
npm run deploy
```

Full instructions: [docs/deployment.md](docs/deployment.md).

## Mailgun receiving configuration

Create a Mailgun Receiving Route for your domain.

Expression:

```text
match_recipient(".*@example.com")
```

Recommended actions:

```text
store()
forward("https://YOUR-WORKER/api/webhooks/mailgun/inbound")
stop()
```

- `forward()` provides near-real-time delivery.
- `store()` enables independent polling if the webhook fails.
- The cron job checks Mailgun every five minutes and deduplicates messages.

## Multi-account behavior

The first successful login with `INITIAL_EMAIL` and `INITIAL_PASSWORD` creates the administrator account. Additional mailbox accounts are created in the **Mailbox Accounts** administration page.

Each account:

- logs in with its full email address;
- sees only messages assigned to its D1 user ID;
- downloads only its own attachments;
- sends only from its authenticated mailbox address;
- maintains an independent password and sessions.

Unknown recipient addresses are ignored until an administrator creates the matching mailbox account.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

Use test-only credentials in `.dev.vars`. The file is ignored by Git.

Test a scheduled handler locally:

```bash
npx wrangler dev --test-scheduled
curl http://localhost:8787/__scheduled
```

## Scripts

Reset any existing mailbox password without deleting messages:

```bash
./scripts/reset-password.sh user@example.com
```

The script prompts twice, hashes the password locally, updates remote D1, and invalidates the user’s old sessions.

## Cloudflare Email Service support

The project already exports a Cloudflare Email Routing `email()` handler and contains an optional Email Sending branch. Mailgun remains the default provider. See [docs/providers.md](docs/providers.md) for current status and planned provider abstraction.

## Known limitations

- HTML email rendering is not yet enabled; untrusted HTML needs sanitization and iframe isolation
- No folders, labels, spam folder, search, or pagination
- No UI yet for disabling/deleting accounts or administrator password resets
- Provider code is still concentrated in `src/index.ts` and should be split into modules
- Mailgun delivery/bounce events are not yet reconciled into sent-mail status

## Documentation

- [Deployment](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Mail providers](docs/providers.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Security

This repository must never contain production credentials or real email data. Review [SECURITY.md](SECURITY.md) before deployment or contribution.

## License

[MIT](LICENSE)
