# Contributing

1. Fork and clone the repository.
2. Install dependencies with `npm ci`.
3. Copy `.dev.vars.example` to `.dev.vars` and use test credentials only.
4. Apply local migrations with `npm run db:local`.
5. Run the Worker with `npm run dev`.
6. Before opening a pull request, run:

```bash
npm run typecheck
npx wrangler deploy --dry-run
npm audit
```

Do not include real email messages, credentials, D1 exports, R2 objects, or `.wrangler` state in issues or pull requests.
