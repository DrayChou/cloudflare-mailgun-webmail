# Deployment

## Requirements

- Node.js 20 or later
- npm
- Cloudflare account with Workers, D1, and R2 access
- Wrangler 4.x authentication
- Mailgun domain with sending and receiving configured
- A domain managed by Cloudflare is optional for a custom web UI hostname

## 1. Install and authenticate

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

## 2. Create resources

```bash
npx wrangler d1 create cloudflare-mailgun-webmail
npx wrangler r2 bucket create cloudflare-mailgun-webmail
```

Copy the returned D1 `database_id` into `wrangler.toml`. Change `INITIAL_EMAIL` to the initial administrator mailbox. If the Mailgun domain uses the EU region, set:

```toml
MAILGUN_API_BASE = "https://api.eu.mailgun.net"
```

## 3. Configure secrets

```bash
npx wrangler secret put INITIAL_PASSWORD
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
```

Use the Mailgun private API key for sending/querying and the HTTP webhook signing key for webhook verification.

## 4. Apply migrations

```bash
npm run db:remote
```

## 5. Validate and deploy

```bash
npm run typecheck
npx wrangler deploy --dry-run
npm run deploy
```

## 6. Configure Mailgun Receiving Route

For one domain, use a catch-all expression such as:

```text
match_recipient(".*@example.com")
```

Recommended actions:

```text
store()
forward("https://YOUR-WORKER/api/webhooks/mailgun/inbound")
stop()
```

`store()` is required for independent polling. The webhook is optional but recommended for real-time delivery.

## 7. Optional custom domain

Add to `wrangler.toml`:

```toml
routes = [
  { pattern = "inbox.example.com", custom_domain = true }
]
```

Deploy again. Updating the Mailgun webhook URL to the custom domain is optional while `workers_dev = true` remains enabled.

## 8. First login

Open `/login` and use `INITIAL_EMAIL` with the `INITIAL_PASSWORD` secret. After bootstrap, the password is stored in D1; changing the Worker secret does not overwrite an existing user.

## Operations

Reset a user password:

```bash
./scripts/reset-password.sh user@example.com
```

Inspect migrations:

```bash
npx wrangler d1 migrations list MAIL_DB --remote
```

View live logs:

```bash
npx wrangler tail
```

Export a D1 backup:

```bash
npx wrangler d1 export MAIL_DB --remote --output backup.sql
```

Do not commit the backup.
