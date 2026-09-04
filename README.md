# Card Value Tracker

Price and trade-value tracking for **Pokémon (English + Japanese)**, **Magic: The Gathering**, and the **One Piece Card Game** — singles and sealed, with graded slabs as a secondary path.

Built for a working collector who prices cards daily. The guiding rule is below.

## Rule zero: no invented data

The database is never seeded with placeholder prices, sample cards, or generated history. If a source is unreachable or a key is missing, the UI shows an **empty state that names what is missing**. An empty screen is correct; a plausible wrong number is not — the first user will trust a number that looks right.

Fixtures live in `__fixtures__/`, are captured from real API responses, are used **only in tests**, and are never imported by application code.

Things that fail *loudly* rather than degrade into a plausible number:

- A variant with no observation in 48 hours reads as **stale**, never as its last price presented as current.
- A single-source valuation is **labeled** as such.
- A cert PSA doesn't recognize **says so**; it never falls through to a name-based guess.
- A card matched below the confidence threshold is **never priced automatically**.

## Stack

- **Backend** — Node 20+, TypeScript, Express, PostgreSQL **15+** (the schema uses `NULLS NOT DISTINCT`, which does not exist before 15), Sequelize
- **Frontend** — React + TypeScript, Vite
- **Jobs** — a plain worker with `node-cron`; no queue service yet
- **Testing** — Vitest, one integration test per adapter against recorded fixtures

## Secrets

Never commit an API key. `.env.example` ships with empty values; `.env` is gitignored from the first commit. **All external calls go through the Express layer — the browser never sees a key** (both JustTCG and PSA require this).

```
DATABASE_URL=postgres://localhost:5432/cardtracker
JUSTTCG_API_KEY=
PSA_USERNAME=
PSA_PASSWORD=
PORT=3000
```

## Data sources

| Source | Role | Notes |
| --- | --- | --- |
| **JustTCG** | prices + catalog | `https://api.justtcg.com/v1`, `x-api-key` header. All 4 game slugs; batch `POST /cards` max 200. Every variant carries a stable `uuid` (primary key) and a `tcgplayerSkuId` (crosswalk). Prices are USD floats → integer cents at the adapter boundary. Commercial use gated on `sources.commercial_ok`. |
| **PSA** | cert lookup only | `https://api.psacard.com/publicapi`, **pre-issued bearer token** you generate on the PSA site (`authorization: bearer <token>`) — set `PSA_ACCESS_TOKEN`. Cert number in → description + grade out. A 200 carries `{ IsValidRequest, ServerMessage }`; `403` means the account isn't approved for API access yet. **No** population, price-guide, or submission endpoints exist. Cert images only for Oct 2021 onward. |

**Not available — do not attempt:** TCGplayer API (closed to new devs), eBay sold comps (Marketplace Insights is partner-gated), BGS/CGC cert APIs (website lookup only).

## Verified state (from `scripts/verify.js` against the live API)

Run it yourself any time — read-only, dependency-free:

```bash
JUSTTCG_API_KEY=tcg_xxx node scripts/verify.js
```

What the live API actually does (the adapter is corrected to match — the docs were wrong in two places):

- ✅ Auth (`x-api-key`) and all four game slugs — `pokemon`, `pokemon-japan`, `magic-the-gathering`, `one-piece-card-game` — are correct.
- ⚠️ **Money: `price` is already in CENTS**, as a possibly-fractional float (`377.29` = $3.77, `49499` = $494.99). The docs called it a "USD float"; multiplying by 100 made every number 100× too high. The adapter now does `Math.round(price)` — **not** `× 100`. `priceHistory` points are `{ p: cents, t: unixSeconds }`.
- ⚠️ **Sets carry no `code`** — only a slug (`id`) and `name`. The real set code (`OP13`) lives in the collector-number prefix; derive it during card sync.
- ⚠️ **Card shape**: `set` is a slug, `set_name` is the display name, `number` is the collector number (`OP13-118`) or `N/A` for sealed. Envelope is `{ data, meta: { total, limit, offset, hasMore } }`.
- ❓ **Unconfirmed — the server-side `set` filter on `/cards`.** It returned intermittent `400`s under the free tier's rate limit, so it could not be pinned down. `fetchSet` therefore filters client-side over the confirmed game-wide listing; switch it to a server `set=<slug>` filter once you can confirm it on a paid key.
- 📉 **Free tier limits: 100 requests/day, 10/sec** (reported in the response `_metadata`). A full catalog sync of the larger games is a Pro/Business-tier operation.

A recorded response lives at `__fixtures__/justtcg-cards-one-piece.json` and drives `src/sources/adapter.test.ts`. It is used only in tests, never imported by application code.

## Getting started

```bash
cp .env.example .env          # DATABASE_URL, JUSTTCG_API_KEY, PSA_ACCESS_TOKEN
createdb cardtracker          # PostgreSQL 15+

# backend
npm install
npx sequelize-cli db:migrate  # applies db/schema.sql + the holdings table
npm run verify                # confirm the JustTCG adapter assumptions (read-only)

# load data (needs JUSTTCG_API_KEY; free tier is 100 req/day)
npx tsx src/jobs/sync-catalog.ts     # games -> sets -> cards -> variants
npx tsx src/jobs/sync-prices.ts      # today's prices -> price_observations
npx tsx src/jobs/backfill-history.ts # source history -> price_observations (is_backfill)
npx tsx src/valuation/compute.ts     # -> daily_valuations
```

## Running it

Two processes. The browser only talks to the API (keys stay server-side); Vite
proxies `/api` to the Express server in dev.

```bash
# terminal 1 — API (http://localhost:3000)
npm run dev

# terminal 2 — web app (http://localhost:5173)
cd web && npm install && npm run dev
```

Open http://localhost:5173. With no data yet, every screen shows an empty state
that names what's missing (set the key, run the sync) — never a fake number.
`npm run worker` runs the scheduled jobs (prices, valuations, backfill, catalog).

**Implemented:** M1 schema + catalog sync · M2 prices, history backfill, valuation
blend · M3 search, collection (+ CSV, versioned trade bands) · M4 cert/UPC scan
(camera + manual, PSA cert chain, low-confidence picker). PSA cert lookup needs
your account approved for API access (see below).

## Layout

```
db/          schema.sql, migrations (generated from it), seeds (catalog only — never prices)
scripts/     verify.js — pre-flight check of the JustTCG adapter
src/
  sources/   adapter.ts (PriceSource + JustTCG), psa.ts (cert only), registry.ts
  valuation/ index.ts (blend, trade bands, metrics), compute.ts (nightly writer)
  jobs/      sync-catalog, sync-prices, backfill-history
  api/       Express routes + server
  models/    Sequelize models
web/         React + Vite front end (Search, Collection, Scan, Settings)
__fixtures__ recorded API responses, tests only
```

## Milestones

1. **Schema + catalog sync** — done when a full sync of all four games re-runs with zero new rows and zero duplicates.
2. **Prices + valuation** — one `price_observations` row per variant/source/day; `daily_valuations` traceable back to the observations that produced it.
3. **Search + collection** — full-text + exact `collector_number`/`set_code` (searching `OP09-093` returns a hit); collection with market / cash / credit / movement and CSV export; versioned trade bands.
4. **Camera + barcode scan** — a slab barcode carries only the cert number; the chain is decode → PSA lookup → match our product (picker when confidence is low) → variant → value. BGS/CGC are manual-entry only. Sealed UPCs route to a separate `products.kind = 'sealed'` path.

## Addendum: sealed product, sourcing friction, trade balancer

Additive layer (Pokémon + One Piece sealed only; Magic sealed out; singles unchanged).

- **Sealed source = PriceCharting** (`src/sources/pricecharting.ts`) — token as `?t=`,
  **1 req/sec**, current values only (integer pennies, no history/backfill), Genre
  "Sealed Product". Singles stay on JustTCG; routing is by `products.kind`.
  Verify the two price fields first: `PRICECHARTING_TOKEN=xxx npm run verify:pc`
  (the `loose-price`/`new-price` mapping is unverified until you run it).
- **Seed identities, never prices:** `npm run seed:sealed` crawls PriceCharting,
  upserts sealed products/variants + `sealed_config` (format classified from the
  name; NULL when unmatched), and writes **zero** price rows. `npm run sync:sealed`
  takes the daily snapshot; `compute.ts` values sealed like singles.
- **Sourcing friction** (`sourcing_friction`): replacement cost ≠ market. Operator
  sets `manual_score` / `purchase_limit` / `is_allocated` / `premium_pct` (always
  wins). `npm run friction` computes an `auto_score` from release recency —
  honestly, the `listings_ratio` input has no sealed feed, so it's recorded as
  unavailable in `auto_inputs` rather than fabricated. **Premium applies to the
  trade side only; market value never changes**, and the UI shows both.
- **Trade balancer** (`POST /api/trades/balance`, Trades tab): "how many of these
  for one of those." Returns a whole number + dollar remainder + brackets,
  friction shown separately from market, a one-sentence liquidity lean, pack-
  equivalence when formats differ, and a loud staleness banner for new/48h-old
  lines. Sessions persist with the full computation in `result_json` so a past
  trade stays explainable.
- **UPC scan path**: 12–13 digits route to sealed products by `upc`; a miss is
  normal (partial coverage) — the operator binds the UPC once and stock becomes
  self-describing.

## Money

Integer cents everywhere. JustTCG returns USD *cents already* (`Math.round`, not ×100 — see Verified state); PriceCharting returns integer pennies; no float passes the adapter boundary.
