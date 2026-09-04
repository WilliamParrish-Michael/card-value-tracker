/**
 * GET /api/valuation/:variantId
 *
 * The valuation AND the observations that produced it — so any number in the UI
 * traces back to its inputs (Milestone 2 done-when). A variant with no valuation
 * returns valuation:null and staleness info; the UI says "no valuation yet" or
 * "stale", never presents a last-known price as current.
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';

const STALE_HOURS = 48;

export function valuationRouter(): Router {
  const r = Router();

  r.get('/:variantId', async (req, res) => {
    const id = req.params.variantId;
    try {
      const [variant] = await sequelize.query(
        `SELECT v.id::text, v.condition, v.printing, v.language, v.grader, v.grade::text,
                p.name, p.collector_number, p.rarity, c.slug AS game, s.set_code
           FROM variants v
           JOIN products p ON p.id = v.product_id
           JOIN categories c ON c.id = p.category_id
           JOIN sets s ON s.id = p.set_id
          WHERE v.id = $id`,
        { bind: { id }, type: QueryTypes.SELECT },
      );
      if (!variant) return res.status(404).json({ error: 'variant not found' });

      const [valuation] = await sequelize.query<{ valued_on: string; computed_at: string }>(
        `SELECT valued_on::text, market_cents, source_count, spread_pct::text, confidence::text,
                change_7d_pct::text, change_30d_pct::text, change_90d_pct::text,
                pos_in_90d_range::text, computed_at
           FROM daily_valuations WHERE variant_id = $id ORDER BY valued_on DESC LIMIT 1`,
        { bind: { id }, type: QueryTypes.SELECT },
      );

      const observations = await sequelize.query(
        `SELECT source_key, observed_on::text, price_cents, avg_7d_cents,
                min_30d_cents, max_30d_cents, cov_7d::text, is_backfill
           FROM price_observations WHERE variant_id = $id
          ORDER BY observed_on DESC LIMIT 120`,
        { bind: { id }, type: QueryTypes.SELECT },
      );

      // Staleness: latest live (non-backfill) observation older than 48h is stale.
      const [fresh] = await sequelize.query<{ latest: string | null }>(
        `SELECT max(observed_on)::text AS latest FROM price_observations
          WHERE variant_id = $id AND is_backfill = false`,
        { bind: { id }, type: QueryTypes.SELECT },
      );
      let stale = true;
      if (fresh?.latest) {
        const ageHours = (Date.now() - Date.parse(fresh.latest)) / 3_600_000;
        stale = ageHours > STALE_HOURS;
      }

      res.json({
        data: {
          variant,
          valuation: valuation ?? null,
          singleSource: valuation ? Number((valuation as { source_count?: number }).source_count) <= 1 : null,
          stale,
          latestObservedOn: fresh?.latest ?? null,
          observations,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
