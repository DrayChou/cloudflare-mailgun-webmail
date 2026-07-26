# Security Policy

## Reporting a vulnerability

Please do not open a public issue containing credentials, private email data, or exploit details. Use GitHub private vulnerability reporting when enabled, or contact the repository owner privately.

## Secret handling

Never commit:

- `.dev.vars`
- Mailgun private API keys
- Mailgun HTTP webhook signing keys
- initial or user passwords
- Cloudflare API/OAuth tokens
- D1 exports containing users or messages
- R2 email objects or attachments

Production secrets must be configured with `wrangler secret put`.

## Production notes

- Use a long, unique initial administrator password.
- Rotate any credential that has appeared in Git history or logs.
- Keep the Mailgun webhook signature check enabled.
- Keep the application behind HTTPS.
- Back up D1 and R2 according to your retention requirements.
- Review HTML email rendering before enabling rich HTML display; untrusted HTML must be sanitized and isolated in a sandboxed iframe.
