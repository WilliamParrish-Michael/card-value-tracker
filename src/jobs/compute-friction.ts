/**
 * Nightly sourcing-friction auto_score (section 5).
 *
 * The spec's primary input is listings_ratio = listing_count / sales_volume_30d.
 * Neither PriceCharting (current values only) nor JustTCG (singles) exposes sealed
 * listing counts or sales volume, so that ratio is UNAVAILABLE — and we do not
 * fabricate it. What we can compute honestly is the recency component: product
 * released in the last 60 days carries real-but-temporary launch scarcity, decayed
 * to zero at 60 days. auto_inputs records exactly what went in, so the score is
 * explainable (an unexplainable score gets ignored by its user).
 *
 * Operator inputs (manual_score, purchase_limit, is_allocated, premium_pct) always
 * win and are never touched here — this job only writes the auto_* columns.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';

const LAUNCH_WINDOW_DAYS = 60;

export async function computeFriction(): Promise<{ scored: number; skipped: number }> {
  // Sealed products with a known release date (from sealed_config).
  const rows = await sequelize.query<{ product_id: string; released_on: string | null }>(
    `SELECT p.id AS product_id, sc.released_on::text AS released_on
       FROM products p
       LEFT JOIN sealed_config sc ON sc.product_id = p.id
      WHERE p.kind = 'sealed'`,
    { type: QueryTypes.SELECT },
  );

  const today = Date.now();
  let scored = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r.released_on) {
      // No release date -> no honest recency signal, and no listings feed either.
      // Leave auto_score NULL so the UI relies on the operator's manual score.
      skipped += 1;
      continue;
    }
    const daysSince = Math.floor((today - Date.parse(r.released_on)) / 86_400_000);
    const recency = daysSince < 0
      ? 100                                   // not yet released -> maximal launch scarcity
      : Math.round(100 * Math.max(0, (LAUNCH_WINDOW_DAYS - daysSince) / LAUNCH_WINDOW_DAYS));

    const autoInputs = {
      recency_component: recency,
      days_since_release: daysSince,
      launch_window_days: LAUNCH_WINDOW_DAYS,
      listings_ratio: null,
      note: 'listings_ratio unavailable — no sealed listing/sales feed; auto_score is the recency component only',
    };

    await sequelize.query(
      `INSERT INTO sourcing_friction (product_id, auto_score, auto_inputs, auto_computed_at)
       VALUES ($pid, $score, $inputs::jsonb, now())
       ON CONFLICT (product_id) DO UPDATE
         SET auto_score = EXCLUDED.auto_score, auto_inputs = EXCLUDED.auto_inputs,
             auto_computed_at = now()`,
      { bind: { pid: r.product_id, score: recency, inputs: JSON.stringify(autoInputs) } },
    );
    scored += 1;
  }

  return { scored, skipped };
}

const isMain = process.argv[1]?.endsWith('compute-friction.ts');
if (isMain) {
  computeFriction()
    .then((s) => { console.log('[compute-friction] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[compute-friction] failed', err); process.exit(1); });
}
