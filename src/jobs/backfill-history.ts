/**
 * Milestone 2 — history backfill. Runs once per variant: writes the source's own
 * priceHistory points as price_observations with is_backfill = true, so charts
 * and change/range metrics work on day one instead of waiting months to
 * accumulate our own series.
 *
 * Idempotent: ON CONFLICT (variant_id, source_key, observed_on) DO NOTHING, and
 * variants that already have a backfilled row are skipped so re-runs are cheap
 * and don't re-spend API calls.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { buildRegistry } from '../sources/registry.js';
import type { JustTCGSource } from '../sources/adapter.js';

const BATCH = 200;

export async function backfillHistory(opts: { limit?: number } = {}): Promise<{ points: number; variants: number }> {
  const registry = buildRegistry();
  const src = registry.get('justtcg') as JustTCGSource | undefined;
  if (!src) throw new Error('No source configured — set JUSTTCG_API_KEY.');

  const limit = opts.limit ?? 2000;
  // Variants with a UUID that have no backfilled observation yet.
  const due = await sequelize.query<{ id: string; justtcg_uuid: string }>(
    `SELECT v.id, v.justtcg_uuid FROM variants v
      WHERE v.justtcg_uuid IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM price_observations po
           WHERE po.variant_id = v.id AND po.source_key = 'justtcg' AND po.is_backfill = true)
      ORDER BY v.first_seen_at
      LIMIT $limit`,
    { bind: { limit }, type: QueryTypes.SELECT },
  );
  if (due.length === 0) return { points: 0, variants: 0 };

  const idByUuid = new Map(due.map((r) => [r.justtcg_uuid, r.id]));
  let points = 0;
  const variants = new Set<string>();

  for (let i = 0; i < due.length; i += BATCH) {
    const chunk = due.slice(i, i + BATCH).map((r) => r.justtcg_uuid);
    const cards = await src.fetchByIds(chunk);

    for (const card of cards) {
      for (const q of card.quotes) {
        const variantId = q.externalUuid ? idByUuid.get(q.externalUuid) : undefined;
        if (!variantId || !q.history?.length) continue;

        for (const pt of q.history) {
          const [res] = await sequelize.query<{ id: string }>(
            `INSERT INTO price_observations
               (variant_id, source_key, observed_on, price_cents, is_backfill)
             VALUES ($vid, 'justtcg', $on, $price, true)
             ON CONFLICT (variant_id, source_key, observed_on) DO NOTHING
             RETURNING id`,
            { bind: { vid: variantId, on: pt.observedOn, price: pt.priceCents }, type: QueryTypes.SELECT },
          );
          if (res) points += 1;
        }
        variants.add(variantId);
      }
    }
  }

  return { points, variants: variants.size };
}

const isMain = process.argv[1]?.endsWith('backfill-history.ts');
if (isMain) {
  backfillHistory()
    .then((s) => { console.log('[backfill-history] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[backfill-history] failed', err); process.exit(1); });
}
