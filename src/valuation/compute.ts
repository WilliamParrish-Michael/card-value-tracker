/**
 * Milestone 2 — nightly daily_valuations writer.
 *
 * For each variant with an observation on the run date, blend that day's sources
 * (weighted median via blendMarket) and compute change/range metrics from OUR
 * own price_observations series (backfilled + live). Everything is traceable:
 * the number in daily_valuations comes only from rows in price_observations.
 *
 * Confidence is surfaced, never hidden: blendMarket already lowers it for a
 * single source, wide spread, or thin volume; here we shade it further when the
 * source reports a high coefficient of variation (a thin/noisy market).
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { blendMarket, type SourcePrice } from './index.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

interface ObsRow { variant_id: string; source_key: string; price_cents: number; cov_7d: number | null; blend_weight: string; }
interface HistRow { variant_id: string; observed_on: string; price_cents: number; }

/** Nearest observation strictly before `on`, closest to (on - days). Null if none. */
function priceDaysAgo(series: HistRow[], on: string, days: number): number | null {
  const target = new Date(Date.parse(on) - days * 86_400_000).toISOString().slice(0, 10);
  let best: HistRow | null = null;
  let bestDist = Infinity;
  for (const h of series) {
    if (h.observed_on >= on) continue;               // must be in the past
    const dist = Math.abs(daysBetween(h.observed_on, target));
    if (dist < bestDist) { bestDist = dist; best = h; }
  }
  return best ? best.price_cents : null;
}

export async function computeValuations(valuedOn?: string): Promise<{ valued: number; on: string }> {
  const on = valuedOn ?? new Date().toISOString().slice(0, 10);

  // Today's live observations + each source's blend weight.
  const todays = await sequelize.query<ObsRow>(
    `SELECT po.variant_id, po.source_key, po.price_cents, po.cov_7d, s.blend_weight
       FROM price_observations po
       JOIN sources s ON s.key = po.source_key
      WHERE po.observed_on = $on AND po.is_backfill = false AND s.is_enabled = true`,
    { bind: { on }, type: QueryTypes.SELECT },
  );
  if (todays.length === 0) return { valued: 0, on };

  const variantIds = [...new Set(todays.map((r) => r.variant_id))];

  // 90-day series (any source) for change + range, for just those variants.
  const hist = await sequelize.query<HistRow>(
    `SELECT variant_id, observed_on::text AS observed_on, price_cents
       FROM price_observations
      WHERE variant_id IN (:ids)
        AND observed_on >= ($on::date - INTERVAL '90 days')
      ORDER BY variant_id, observed_on`,
    { replacements: { ids: variantIds }, bind: { on }, type: QueryTypes.SELECT },
  );

  const byVariantToday = new Map<string, ObsRow[]>();
  for (const r of todays) (byVariantToday.get(r.variant_id) ?? byVariantToday.set(r.variant_id, []).get(r.variant_id)!).push(r);
  const byVariantHist = new Map<string, HistRow[]>();
  for (const r of hist) (byVariantHist.get(r.variant_id) ?? byVariantHist.set(r.variant_id, []).get(r.variant_id)!).push(r);

  let valued = 0;
  for (const vid of variantIds) {
    const rows = byVariantToday.get(vid)!;
    const prices: SourcePrice[] = rows.map((r) => ({
      sourceKey: r.source_key,
      marketCents: r.price_cents,
      medianCents: null,
      salesVolume: null,
      blendWeight: Number(r.blend_weight),
    }));
    const market = blendMarket(prices);
    if (!market) continue;

    // Shade confidence for a thin/noisy market (high coefficient of variation).
    const maxCov = Math.max(0, ...rows.map((r) => (r.cov_7d == null ? 0 : Number(r.cov_7d))));
    let confidence = market.confidence;
    if (maxCov > 0.5) confidence = round2(confidence * 0.7);

    const series = byVariantHist.get(vid) ?? [];
    const p7 = priceDaysAgo(series, on, 7);
    const p30 = priceDaysAgo(series, on, 30);
    const p90 = priceDaysAgo(series, on, 90);
    const pct = (past: number | null) =>
      past == null || past <= 0 ? null : round2(((market.marketCents - past) / past) * 100);

    // Position in the 90-day range (0 = at the low, 1 = at the high).
    const range = series.filter((h) => h.observed_on <= on);
    let pos: number | null = null;
    if (range.length) {
      const lo = Math.min(...range.map((h) => h.price_cents));
      const hi = Math.max(...range.map((h) => h.price_cents));
      pos = hi > lo ? round3(Math.min(1, Math.max(0, (market.marketCents - lo) / (hi - lo)))) : null;
    }

    await sequelize.query(
      `INSERT INTO daily_valuations
         (variant_id, valued_on, market_cents, source_count, spread_pct, confidence,
          change_7d_pct, change_30d_pct, change_90d_pct, pos_in_90d_range, computed_at)
       VALUES ($vid, $on, $market, $sc, $spread, $conf, $c7, $c30, $c90, $pos, now())
       ON CONFLICT (variant_id, valued_on) DO UPDATE
         SET market_cents = EXCLUDED.market_cents, source_count = EXCLUDED.source_count,
             spread_pct = EXCLUDED.spread_pct, confidence = EXCLUDED.confidence,
             change_7d_pct = EXCLUDED.change_7d_pct, change_30d_pct = EXCLUDED.change_30d_pct,
             change_90d_pct = EXCLUDED.change_90d_pct, pos_in_90d_range = EXCLUDED.pos_in_90d_range,
             computed_at = now()`,
      {
        bind: {
          vid, on, market: market.marketCents, sc: market.sourceCount, spread: market.spreadPct,
          conf: confidence, c7: pct(p7), c30: pct(p30), c90: pct(p90), pos,
        },
      },
    );
    valued += 1;
  }

  return { valued, on };
}

const isMain = process.argv[1]?.endsWith('compute.ts');
if (isMain) {
  computeValuations()
    .then((s) => { console.log('[compute] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[compute] failed', err); process.exit(1); });
}
