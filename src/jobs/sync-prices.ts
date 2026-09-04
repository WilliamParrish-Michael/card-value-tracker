/**
 * Milestone 2 — price sync. Refreshes prices for the variants that have gone
 * longest without a refresh (last_synced_at NULLS FIRST), in batches of 200 via
 * POST /cards. Writes ONE price_observations row per variant/source/day,
 * ON CONFLICT DO NOTHING so the job is safely re-runnable within a day.
 *
 * Note the free tier is 100 requests/day (200 variants/request), so `limit`
 * bounds how much a single run attempts. No prices are invented: a variant the
 * source doesn't return simply gets no row and stays stale.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { buildRegistry } from '../sources/registry.js';
import type { JustTCGSource } from '../sources/adapter.js';

const BATCH = 200;

export async function syncPrices(opts: { limit?: number } = {}): Promise<{ observations: number; variants: number }> {
  const registry = buildRegistry();
  const src = registry.get('justtcg') as JustTCGSource | undefined;
  if (!src) throw new Error('No price source configured — set JUSTTCG_API_KEY.');

  const limit = opts.limit ?? 2000;
  const due = await sequelize.query<{ id: string; justtcg_uuid: string }>(
    `SELECT id, justtcg_uuid FROM variants
      WHERE justtcg_uuid IS NOT NULL
      ORDER BY last_synced_at NULLS FIRST
      LIMIT $limit`,
    { bind: { limit }, type: QueryTypes.SELECT },
  );
  if (due.length === 0) return { observations: 0, variants: 0 };

  const idByUuid = new Map(due.map((r) => [r.justtcg_uuid, r.id]));
  let observations = 0;
  const touched = new Set<string>();

  for (let i = 0; i < due.length; i += BATCH) {
    const chunk = due.slice(i, i + BATCH).map((r) => r.justtcg_uuid);
    const cards = await src.fetchByIds(chunk);

    for (const card of cards) {
      for (const q of card.quotes) {
        const variantId = q.externalUuid ? idByUuid.get(q.externalUuid) : undefined;
        if (!variantId) continue;

        const [res] = await sequelize.query<{ id: string }>(
          `INSERT INTO price_observations
             (variant_id, source_key, observed_on, price_cents,
              avg_7d_cents, min_30d_cents, max_30d_cents,
              cov_7d, trend_slope_30d, price_changes_30d, is_backfill, raw_payload)
           VALUES ($vid, 'justtcg', $on, $price, $avg, $min, $max, $cov, $slope, $chg, false, $raw::jsonb)
           ON CONFLICT (variant_id, source_key, observed_on) DO NOTHING
           RETURNING id`,
          {
            bind: {
              vid: variantId, on: q.observedOn, price: q.priceCents,
              avg: q.avg7dCents ?? null, min: q.min30dCents ?? null, max: q.max30dCents ?? null,
              cov: q.cov7d ?? null, slope: q.trendSlope30d ?? null, chg: q.priceChanges30d ?? null,
              raw: JSON.stringify(q.raw ?? null),
            },
            type: QueryTypes.SELECT,
          },
        );
        if (res) observations += 1;
        touched.add(variantId);
      }
    }
  }

  // Mark everything we attempted as synced so the NULLS-FIRST ordering advances,
  // even variants the source didn't return (so we don't hammer the same dead ids).
  const ids = due.map((r) => r.id);
  await sequelize.query(
    `UPDATE variants SET last_synced_at = now() WHERE id IN (:ids)`,
    { replacements: { ids } },
  );

  return { observations, variants: touched.size };
}

const isMain = process.argv[1]?.endsWith('sync-prices.ts');
if (isMain) {
  syncPrices()
    .then((s) => { console.log('[sync-prices] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[sync-prices] failed', err); process.exit(1); });
}
