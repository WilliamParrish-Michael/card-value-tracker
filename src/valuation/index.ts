/**
 * The three numbers, in one place.
 *
 *   market  — blended from sources, outliers trimmed
 *   trade   — market x your banded rate (cash or credit)
 *   percent — spread vs raw, or change over your own history
 *
 * Only `market` touches an external API. The other two are yours.
 */

export interface SourcePrice {
  sourceKey: string;
  marketCents: number;
  medianCents?: number | null;
  salesVolume?: number | null;
  blendWeight: number;
}

export interface MarketValue {
  marketCents: number;
  sourceCount: number;
  /** How far apart the sources are, as % of the blend. High = distrust it. */
  spreadPct: number;
  confidence: number; // 0..1
}

/**
 * Weighted median, not mean. One source mispricing a card by 10x
 * should move the answer by nothing, and with a mean it moves it by
 * everything. Prefer each source's own median over its low: low is
 * where the damaged copies and the $0.01 junk listings live.
 */
export function blendMarket(prices: SourcePrice[]): MarketValue | null {
  const usable = prices.filter((p) => p.marketCents > 0);
  if (usable.length === 0) return null;

  const points = usable
    .map((p) => ({ cents: p.medianCents ?? p.marketCents, weight: p.blendWeight }))
    .sort((a, b) => a.cents - b.cents);

  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  let running = 0;
  let marketCents = points[points.length - 1].cents;
  for (const p of points) {
    running += p.weight;
    if (running >= totalWeight / 2) {
      marketCents = p.cents;
      break;
    }
  }

  const lo = points[0].cents;
  const hi = points[points.length - 1].cents;
  const spreadPct = marketCents > 0 ? ((hi - lo) / marketCents) * 100 : 0;

  // One source, or sources that disagree wildly, means a soft number.
  // Surface this — don't quietly present it as fact.
  let confidence = Math.min(1, usable.length / 3);
  if (spreadPct > 40) confidence *= 0.5;
  const volume = usable.reduce((s, p) => s + (p.salesVolume ?? 0), 0);
  if (volume > 0 && volume < 3) confidence *= 0.6;

  return {
    marketCents,
    sourceCount: usable.length,
    spreadPct: round2(spreadPct),
    confidence: round2(confidence),
  };
}

export interface TradeRule {
  minCents: number;
  maxCents: number | null;
  ratePct: number;
  floorCents: number;
  ceilingCents: number | null;
  minVolume30d: number | null;
  slowMoverPenaltyPct: number;
}

export interface TradeOffer {
  offerCents: number;
  effectiveRatePct: number;
  ruleApplied: TradeRule;
  penaltyApplied: boolean;
}

export function tradeValue(
  market: MarketValue,
  rules: TradeRule[],
  volume30d: number | null,
): TradeOffer | null {
  const rule = rules.find(
    (r) =>
      market.marketCents >= r.minCents &&
      (r.maxCents === null || market.marketCents < r.maxCents),
  );
  if (!rule) return null;

  const slow =
    rule.minVolume30d !== null &&
    volume30d !== null &&
    volume30d < rule.minVolume30d;

  const rate = slow ? rule.ratePct - rule.slowMoverPenaltyPct : rule.ratePct;

  let offer = Math.round(market.marketCents * (rate / 100));
  offer = Math.max(offer, rule.floorCents);
  if (rule.ceilingCents !== null) offer = Math.min(offer, rule.ceilingCents);

  return {
    offerCents: offer,
    effectiveRatePct: round2((offer / market.marketCents) * 100),
    ruleApplied: rule,
    penaltyApplied: slow,
  };
}

/** Percent premium of a graded copy over raw. Your headline metric. */
export function spreadPct(rawCents: number, gradedCents: number): number | null {
  if (rawCents <= 0) return null;
  return round2((gradedCents / rawCents - 1) * 100);
}

/**
 * Net ROI on submitting for grading, fees included. The spread alone
 * is misleading — fees moved twice in 2026, and a card with a 300%
 * spread on a $20 raw still loses money at a $79.99 tier.
 */
export function gradingRoi(
  rawCents: number,
  expectedGradedCents: number,
  feeCents: number,
): { netCents: number; roiPct: number } {
  const cost = rawCents + feeCents;
  const netCents = expectedGradedCents - cost;
  return { netCents, roiPct: round2((netCents / cost) * 100) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
