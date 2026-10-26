<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project context

- This is DexDNA Pro, the trading terminal intended for DexDNA's pro subdomain.
- Use this workspace as the primary source for ongoing development.
- The main trading interface is `public/routeforge.html`, embedded by `app/page.tsx`.
- Trading UI actions live in `public/trading.js`; server adapters and fee policy
  live in `lib/trading/` and `app/api/`. Keep provider credentials and operator fee
  settings server-side; `.env.example` documents them. Never publish `.env.local`.
- Relay triggers are local, page-open monitoring with wallet-confirmed execution.
  Do not describe them as unattended execution or published Relay limit orders.
- Branding follows `myevm-dev/dexterdna` (header and theme), with the original DNA
  logo at `public/datadnalogo.png`. Use DexDNA Pro in the interface and metadata.
- Preserve the patched Next.js version and the clean development startup command.
