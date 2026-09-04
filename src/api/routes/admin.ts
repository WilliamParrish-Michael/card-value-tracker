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

    // Refuse once real data exists: bootstrap is first-run only.
    const existing = await sequelize.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM products`,
      { type: QueryTypes.SELECT },
    );
    if (Number(existing[0]?.n ?? '0') > 0) {
      return res.status(409).json({
        error: 'Catalog already populated — bootstrap is first-run only.',
        products: Number(existing[0].n),
      });
    }

    const game = String(req.query.game ?? 'one-piece-card-game');
    const pages = Math.min(Math.max(Number(req.query.pages ?? 3), 1), 5);
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

  return router;
}
