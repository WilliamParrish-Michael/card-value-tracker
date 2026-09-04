/**
 * Admin bootstrap — a one-time way to populate a freshly deployed instance
 * without shell access (Render's free plan has none). It runs the same jobs the
 * worker/CLI run (catalog -> prices -> valuation) in-process, using the server's
 * own env (DATABASE_URL + JUSTTCG_API_KEY), so no key ever leaves the backend.
 *
 * Safety:
 *   - Gated on an EMPTY catalog: once products exist it refuses (409), so it
 *     cannot be used to burn the free tier's daily quota by repeat calls.
 *   - `pages` is capped so a bootstrap stays inside the 100 req/day free tier
 *     and finishes inside one HTTP request.
 *   - Rule Zero holds: it only asks the real source for real data. If no source
 *     is configured it writes nothing and says so.
 *
 * This is a deploy convenience, not a production surface — on a paid plan the
 * cron worker (src/jobs/worker.ts) does this on a schedule instead.
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';
import { hasAnySource } from '../../sources/registry.js';
import { syncCatalog } from '../../jobs/sync-catalog.js';
import { syncPrices } from '../../jobs/sync-prices.js';
import { computeValuations } from '../../valuation/compute.js';

export function adminRouter(): Router {
  const router = Router();

  router.post('/bootstrap', async (req, res) => {
    if (!hasAnySource()) {
      return res.status(400).json({
        error: 'No price source configured — set JUSTTCG_API_KEY in the environment.',
        missing: 'JUSTTCG_API_KEY',
      });
    }

    const game = String(req.query.game ?? 'one-piece-card-game');

    // Refuse once THIS game already has products: bootstrap is first-run PER GAME,
    // so a new game (e.g. pokemon) can load alongside an existing one without
    // re-spending quota on a game that's already synced.
    const existing = await sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE c.justtcg_game = $game`,
      { bind: { game }, type: QueryTypes.SELECT },
    );
    if (Number(existing[0]?.n ?? '0') > 0) {
      return res.status(409).json({
        error: `Catalog for ${game} already populated — bootstrap is first-run per game.`,
        products: Number(existing[0].n),
      });
    }

    // Free plan pages are 20 cards each, so default 6 pages ~= 120 cards; the cap
    // (12 pages) plus price batches stays well inside the 100 req/day free tier.
    const pages = Math.min(Math.max(Number(req.query.pages ?? 6), 1), 12);
    const priceLimit = Math.min(Math.max(Number(req.query.priceLimit ?? 800), 1), 2000);

    try {
      const catalog = await syncCatalog({ games: [game], maxPages: pages });
      const prices = await syncPrices({ limit: priceLimit });
      const valuation = await computeValuations();
      return res.json({ ok: true, game, pages, catalog, prices, valuation });
    } catch (err) {
      return res.status(502).json({ error: 'bootstrap failed', detail: (err as Error).message });
    }
  });

  // Re-runnable price + valuation refresh for the already-loaded catalog. Unlike
  // bootstrap this is idempotent and safe to call repeatedly: it only refreshes
  // existing variants (price_observations upserts ON CONFLICT DO NOTHING per day)
  // and recomputes daily_valuations. `limit` bounds a run to stay inside quota.
  router.post('/refresh', async (req, res) => {
    if (!hasAnySource()) {
      return res.status(400).json({ error: 'No price source configured.', missing: 'JUSTTCG_API_KEY' });
    }
    const priceLimit = Math.min(Math.max(Number(req.query.priceLimit ?? 500), 1), 2000);
    // refetch=false recomputes valuations from observations already in the DB
    // without hitting the source at all — useful when prices are loaded but the
    // valuation pass didn't finish (and to avoid burning the daily API quota).
    const refetch = String(req.query.refetch ?? 'true') !== 'false';
    try {
      const prices = refetch ? await syncPrices({ limit: priceLimit }) : { observations: 0, variants: 0, skipped: true };
      const valuation = await computeValuations();
      return res.json({ ok: true, refetch, prices, valuation });
    } catch (err) {
      return res.status(502).json({ error: 'refresh failed', detail: (err as Error).message });
    }
  });

  return router;
}
