# Contributing

Thanks for helping improve Savepoint. Please keep changes focused and explain the user impact in your pull request.

## Development setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Apply the local schema with `npx wrangler d1 execute savepoint-db --local --file=schema.sql`.
4. Start the local Worker with `npx wrangler dev --local --port 8787 --var MAX_FILES:12 --var RATE_LIMIT_PER_MIN:100000`.
5. In a second terminal, run `SMOKE_MAXFILES=12 npm run smoke`.

In PowerShell, set the environment variable first with `$env:SMOKE_MAXFILES = "12"`.

For changes to expiry or scheduled cleanup, also run the cron smoke described in `scripts/smoke-cron.mjs`. Run `npx tsc --noEmit` before opening a pull request.

## Pull requests

- Describe the problem and the change.
- Include relevant test results and any deployment/configuration steps.
- Do not include credentials, project codes, download tokens, private deployment reports, or real Cloudflare identifiers.
- Keep dependencies minimal and compatible with the free-tier deployment goal.
- Update public documentation when behavior or setup changes.

## Code style

Follow the existing TypeScript structure and small-module style. Validate paths, file sizes, versions, and project limits at the tool boundary. Avoid logging credentials or project codes.
