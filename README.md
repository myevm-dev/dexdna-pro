# DexDNA Pro

The trading terminal for DexDNA's planned `pro` subdomain. Development now lives
in this local workspace. Branding follows `myevm-dev/dexterdna`: its DNA logo,
Geist typography, lavender canvas, and magenta–purple–cyan gradient. The logo is
served locally from `public/datadnalogo.png` and is also used for browser icons.

The Next.js entry point is `app/page.tsx`; it embeds the trading terminal in
`public/routeforge.html`. Page metadata lives in `app/layout.tsx`.

## Run locally

Use Node.js 20.9 or newer and pnpm, then run:

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Development startup clears this project's generated `.next` directory before
starting Next.js. Stop any existing development server before running it.

Use Node.js 22.18 or newer to run `pnpm test` (the tests use Node's TypeScript
support). `pnpm test` uses mocked providers; it never submits live orders.

## Server configuration

Set these values in `.env.local` during development and in your hosting provider's
server environment for production. Restart the server after changing them. Never
add `NEXT_PUBLIC_` to a provider key or signing secret. `.env.local` is ignored by Git.

| Variable | Purpose |
| --- | --- |
| `APP_FEE_RECIPIENT` | Developer EVM wallet. Required for trading. Relay credits its app balance for this address; Kyber uses the configured on-chain fee recipient. |
| `APP_FEE_BPS` | Required fee from 1–1000 basis points; 25 means 0.25%. No default fee is chosen. |
| `ORDER_SIGNING_SECRET` | Required random secret of at least 32 characters for short-lived server authorization tickets. Use the same value on every server instance. This is not a wallet private key. |
| `RELAY_API_KEY` | Enables Relay market swaps and wallet-confirmed triggers. |
| `KYBER_SWAP_API_KEY` | Enables the Kyber market swap gateway. Separate from Kyber limit partner settings. |
| `APP_ORIGIN` | App origin, such as `http://localhost:3000` locally or `https://pro.dexdna.app` in production. Also sent to Kyber limit APIs. |
| `RELAY_REFERRER` | Relay integration identifier; defaults to `dexdna-pro`. |
| `KYBER_CLIENT_ID` | Kyber integration identifier; defaults to `dexdna-pro`. Use the ID agreed with Kyber for limit fees. |
| `KYBER_REFERRAL` | Kyber limit partner referral agreed with Kyber. |
| `KYBER_LIMIT_ENABLED` | Defaults to `false`. Set to `true` after Kyber configures your partner fee recipient and rate. Every order is still checked against `APP_FEE_*`. |

Generate the server ticket secret with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The settings dialog displays the public fee policy and provider availability.
It does not accept API keys or let a trader change the developer fee. Existing
keys saved by the old interface are removed from browser storage on load.
Slippage remains a trader-controlled preference on the ticket.

## Trading behavior

- **Market:** choose Relay or KyberSwap. The backend builds provider requests
  with the operator's fee and connected wallet recipient. Relay routes without
  an app fee are refused; Kyber route fees must match the server policy.
- **Kyber limits:** prepare, approve and sign an expiring order, view active
  orders, or request cancellation. Native coins need wrapped equivalents such as
  WETH. Published maker orders may fill while the maker is offline. Cancellation
  is a signed API request; existing operator authorizations may still fill for
  up to five minutes.
- **Take orders:** recheck current liquidity, contract and fee configuration,
  obtain a short-lived operator authorization, then approve and fill through the
  connected wallet. Orders paying a different fee recipient or rate are read-only.
- **Relay triggers:** save a minimum output amount and expiry in this browser.
  While this page is open and the matching wallet is connected, it checks quotes
  about every 30 seconds. Once the minimum output after fees and slippage meets
  the target, the trader reviews a fresh quote and confirms in their wallet.
  These are local conditional trades, not published resting Relay orders.
  Closing the page stops monitoring. There is no unattended worker, delegated
  wallet authorization, or persistent trigger database.

The app never holds a wallet private key. Approval and execution remain wallet
actions. Trading stays disabled until the relevant server configuration exists.
Provider support and liquidity can vary by chain and token; provider rejection
is surfaced to the trader.

## Backend structure and deployment

`public/trading.js` controls the trading UI. `/api/trading/config` exposes only
public availability and fee information; `/api/trading/quote` dispatches through
the provider registry in `lib/trading/market.ts`; `/api/trading/limit` handles
Kyber order actions. `/api/relay/*` allows only the read/search/status operations
and quote-bound permit submissions used by the interface.

The server validates amounts, tokens and networks, limits request bodies, rejects
cross-origin browser calls, redacts configured secrets from errors and signs
short-lived preparation tickets. The included request limiter is per process;
use hosting-level limits if deploying across multiple instances. Public routes
are not authenticated operator administration endpoints.

Deploy as a Next.js server application with Node support. A static file host
cannot run the new API routes. Set the environment variables on the server;
shipping just `routeforge.html` is no longer sufficient. Live provider credentials,
partner fee enrollment and wallet settlement must be verified before production
trading; the automated suite mocks external providers.

Provider references: [Relay app fees](https://docs.relay.link/features/app-fees),
[Relay quote API](https://docs.relay.link/references/api/get-quote-v2), and
[Kyber developer documentation](https://docs.kyberswap.com/).

## Recover the v0 preview after a framework upgrade

The failing preview's server logs referenced Next.js 16.4.0 paths even though
the installed dependency was upgraded to 16.4.3. They also reported
`routeModule.ensureInstrumentation is not a function`. These indicate an old
server process or generated output mixed with the new framework installation.

Stop the old preview server, then run `pnpm dev` to clear its output and launch
the installed framework. Refresh the preview after the server is ready. A browser
refresh alone does not restart the server. Keep Next.js 16.4.3 installed.

For production verification, stop the development server and run:

```sh
pnpm build
pnpm start
```

`pnpm clean` clears the generated build output without starting a server.
