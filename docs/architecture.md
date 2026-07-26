# Architecture

```text
Browser
  └─ Cloudflare Worker HTTP routes
       ├─ D1: users, sessions, messages, sync state, audit records
       ├─ R2: attachments and raw MIME objects
       └─ Mail provider adapters
            ├─ Mailgun Messages API (outbound)
            ├─ Mailgun Routes webhook (real-time inbound)
            ├─ Mailgun store() + Events API polling (inbound fallback)
            └─ Cloudflare Email Routing / Email Sending (partial support)
```

## Authentication

- Login identifier is the full mailbox email address.
- The initial administrator is bootstrapped from `INITIAL_EMAIL` and the `INITIAL_PASSWORD` Worker secret.
- Passwords are stored as salted PBKDF2-SHA256 hashes in D1.
- Session cookies are HttpOnly, Secure on HTTPS, and SameSite=Strict.
- Administrators create additional mailbox accounts in the UI.

## Multi-account isolation

Every message has an `owner_user_id`. Inbox, sent mail, message detail, and attachment queries require the current user ID. The sender address is always taken from the authenticated account, not from browser input.

## Inbound delivery

Recommended Mailgun Route actions:

```text
store()
forward("https://your-worker.example/api/webhooks/mailgun/inbound")
stop()
```

The webhook gives near-real-time delivery. The cron job polls Mailgun Events and retrieves stored messages every five minutes as a fallback. Both paths deduplicate by owner and provider message ID.

## Cloudflare-native email

The Worker exports an `email()` handler and contains an optional Email Sending branch. Full Cloudflare-native operation requires Email Routing configuration and an Email Sending binding. Provider extraction into separate modules is planned.
