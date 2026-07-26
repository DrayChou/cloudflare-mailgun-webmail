# Mail providers

## Mailgun

Mailgun is currently the primary provider.

- Outbound: Messages API
- Real-time inbound: Routes HTTP POST webhook
- Reliable inbound fallback: `store()` plus Events/Stored Message polling
- Authentication: private API key and HTTP webhook signing key

## Cloudflare Email Service

Partial support already exists:

- The Worker exports an `email(message, env)` handler compatible with Cloudflare Email Routing.
- The sending path can use an optional `EMAIL` binding when `MAIL_PROVIDER=cloudflare`.

To complete Cloudflare-native support, the project still needs:

- documented Email Routing rules for each zone;
- a committed `send_email` binding example;
- provider-specific delivery status handling;
- tests for raw MIME, attachments, multiple recipients, and bounce events;
- clear pricing and migration guidance.

A future provider interface should normalize Mailgun and Cloudflare input into a common `InboundMessage` model and expose a common outbound `send()` operation.
