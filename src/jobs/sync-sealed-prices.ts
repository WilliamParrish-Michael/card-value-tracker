/**
 * Nightly sealed price snapshot from PriceCharting into price_observations
 * (source 'pricecharting'). PriceCharting has NO history, so this daily snapshot
 * is the only sealed series we'll ever have — it must run every day from day one.
 *
 * One row per sealed variant per day, ON CONFLICT DO NOTHING. The 1 req/sec limit
 * is enforced by the source; `limit` bounds a run. compute.ts then values sealed
 * variants the same way it values singles (single-source -> lower confidence,
 * surfaced not hidden).
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { buildRegistry } from '../sources/registry.js';
import type { PriceChartingSource } from '../sources/pricecharting.js';

export async function syncSealedPrices(opts: { limit?: number } = {}): Promise<{ observations: number; variants: number }> {
  const src = buildRegistry().get('pricecharting') as PriceChartingSource | undefined;
  if (!src) throw new Error('PriceCharting not configured — set PRICECHARTING_TOKEN.');

  const limit = opts.limit ?? 1000;
  const due = await sequelize.query<{ variant_id: string; pricecharting_id: string }>(
    `SELECT v.id AS variant_id, p.pricecharting_id
       FROM variants v
       JOIN products p ON p.id = v.product_id
      WHERE p.kind = 'sealed' AND p.pricecharting_id IS NOT NULL AND v.condition = 'Sealed'
      ORDER BY v.last_synced_at NULLS FIRST
      LIMIT $limit`,
    { bind: { limit }, type: QueryTypes.SELECT },
  );
  if (due.length === 0) return { observations: 0, variants: 0 };

  const on = new Date().toISOString().slice(0, 10);
  let observations = 0;
  const touched: string[] = [];

  for (const row of due) {
    try {
      const p = await src.fetchProduct(row.pricecharting_id);
      const cents = src.sealedValueCents(p);
      touched.push(row.variant_id);
      if (cents == null) continue;    // no value -> no row, stays unpriced (never faked)

      const [res] = await sequelize.query<{ id: string }>(
        `INSERT INTO price_observations
           (variant_id, source_key, observed_on, price_cents, is_backfill, raw_payload)
         VALUES ($vid, 'pricecharting', $on, $price, false, $raw::jsonb)
         ON CONFLICT (variant_id, source_key, observed_on) DO NOTHING
         RETURNING id`,
        { bind: { vid: row.variant_id, on, price: cents, raw: JSON.stringify(p.raw ?? null) }, type: QueryTypes.SELECT },
      );
      if (res) observations += 1;
    } catch (err) {
      console.warn(`[sync-sealed-prices] ${row.pricecharting_id} failed:`, (err as Error).message);
    }
  }

  if (touched.length) {
    await sequelize.query(`UPDATE variants SET last_synced_at = now() WHERE id IN (:ids)`,
      { replacements: { ids: touched } });
  }
  return { observations, variants: touched.length };
}

const isMain = process.argv[1]?.endsWith('sync-sealed-prices.ts');
if (isMain) {
  syncSealedPrices()
    .then((s) => { console.log('[sync-sealed-prices] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[sync-sealed-prices] failed', err); process.exit(1); });
}
