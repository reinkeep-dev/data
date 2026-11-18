# Reinkeep data

Open data collector for [Reinkeep](https://reinkeep.xyz), the pre-trade gate for AI agents on
Robinhood Chain (chain 4663). It finds new tokens and pools, reads what each token contract can do, and re-checks
pools a day later to see if they still trade. The gate, Odds, Board and Radar all read this data.

Reviewed by our team. The code is public so anyone can see where the gate's token facts come from.

## What one run does

1. **New pools** from GeckoTerminal (`/networks/robinhood/new_pools`): name, liquidity, swaps, DEX, base token.
2. **New launches** straight from the chain (`eth_getLogs` on the launcher's event), so tokens the market feed missed
   are still found.
3. **Contract facts** over JSON-RPC, one batched request per token: code present, owner, supply, proxy slot, and
   whether the bytecode carries mint, pause, blacklist or upgrade functions. See `collector/DATA-MODEL.md` 8b for
   what this scan cannot see.
4. **A day later**, each pool is re-read once: still trading, liquidity pulled, faded, or never lived.

Everything goes into a Cloudflare D1 (SQLite) database through its REST API. Schema: `collector/schema.sql`.
Design notes: `collector/DATA-MODEL.md`.

## Schedule

`.github/workflows/collector.yml` asks for a run every 5 minutes. GitHub starts scheduled runs late, in practice about
once an hour; the chain cursor catches up, so late runs do not skip launches.

Repository secrets it needs:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the database |
| `D1_DATABASE_ID` | The D1 database id |
| `CLOUDFLARE_API_TOKEN` | API token with **D1 Edit** on that account, nothing else |
| `RPC_URL` | Robinhood Chain JSON-RPC endpoint for contract reads |
| `LOGS_RPC_URL` | Optional, a second endpoint used only for `eth_getLogs` |

## Run it yourself

Node 24 or newer.

```bash
npm ci
npm test            # 144 tests, recorded real chain and market data, no network
npm run typecheck
```

`node collector/run-local.ts` runs one collection into a local SQLite file under `collector/data/`.
