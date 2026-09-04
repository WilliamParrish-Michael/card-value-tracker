/**
 * Trade balancer (section 7). Answers "how many of these for one of those" as a
 * WHOLE number plus an explicit dollar remainder — never a ratio.
 *
 * Principles enforced here:
 *   - Quantize: return the closest whole quantity and the brackets around it.
 *   - Friction is asymmetric and VISIBLE: the side supplying a constrained item
 *     gets its premium_pct added to that line; market and adjusted are both shown.
 *   - Liquidity lean is a one-sentence judgement, kept OUT of the arithmetic.
 *   - Staleness is loud: any new-set or >48h-old line flags the whole result.
 *   - Unpriced inputs never get faked: an unpriced unknown can't be solved (error);
 *     an unpriced fixed line is excluded from totals and called out.
 */

export interface LoadedLine {
  side: 1 | 2;
  variantId: string;
  quantity: number | null;      // null on exactly one line = the unknown
  unitMarketCents: number | null;
  frictionPct: number;          // premium for the item this line supplies
  label: string;
  format: string | null;
  packsIncluded: number | null;
  stale: boolean;
  staleReasons: string[];
}

export interface BalancedLine {
  side: 1 | 2;
  variantId: string;
  label: string;
  format: string | null;
  quantity: number;
  unitMarketCents: number | null;
  frictionPct: number;
  unitAdjustedCents: number | null;
  lineMarketCents: number | null;
  lineAdjustedCents: number | null;
  packs: number | null;
  stale: boolean;
  staleReasons: string[];
  unpriced: boolean;
}

export interface BracketOption { quantity: number; diffCents: number; aheadSide: 1 | 2 | 'even'; }

export interface BalanceResult {
  unknown: { side: 1 | 2; variantId: string; solvedQuantity: number } | null;
  closest: BracketOption | null;
  bracket: BracketOption[];
  lines: BalancedLine[];
  sideTotals: { 1: { marketCents: number; adjustedCents: number }; 2: { marketCents: number; adjustedCents: number } };
  packsBySide: { 1: number | null; 2: number | null };
  liquidityLean: string;
  warnings: string[];
  stale: boolean;
}

const adjUnit = (unit: number, frictionPct: number, apply: boolean) =>
  Math.round(unit * (1 + (apply ? frictionPct / 100 : 0)));

/** Signed diff -> which side is ahead (received more value). */
function ahead(unknownSideTotal: number, fixedTotal: number, unknownSide: 1 | 2): BracketOption['aheadSide'] {
  const other = unknownSide === 1 ? 2 : 1;
  if (unknownSideTotal === fixedTotal) return 'even';
  // If the unknown side puts up MORE value, the OTHER side is ahead.
  return unknownSideTotal > fixedTotal ? other : unknownSide;
}

export function balanceTrade(lines: LoadedLine[], applyFriction: boolean): BalanceResult {
  const unknowns = lines.filter((l) => l.quantity == null);
  if (unknowns.length !== 1) {
    throw new Error('Exactly one line must omit quantity (the unknown being solved).');
  }
  const unknown = unknowns[0];
  if (unknown.unitMarketCents == null) {
    throw new Error(`The unknown line "${unknown.label}" is unpriced — cannot solve a quantity against an unknown value.`);
  }

  const warnings: string[] = [];
  const fixed = lines.filter((l) => l.quantity != null);

  // Fixed-side running totals (market + friction-adjusted), excluding unpriced.
  const totals = { 1: { marketCents: 0, adjustedCents: 0 }, 2: { marketCents: 0, adjustedCents: 0 } };
  for (const l of fixed) {
    if (l.unitMarketCents == null) {
      warnings.push(`"${l.label}" is unpriced and was excluded from the totals.`);
      continue;
    }
    const q = l.quantity as number;
    totals[l.side].marketCents += l.unitMarketCents * q;
    totals[l.side].adjustedCents += adjUnit(l.unitMarketCents, l.frictionPct, applyFriction) * q;
  }

  const unknownSide = unknown.side;
  const fixedOtherSide = unknownSide === 1 ? 2 : 1;
  const unknownUnitAdj = adjUnit(unknown.unitMarketCents, unknown.frictionPct, applyFriction);
  const targetForUnknownSide = totals[fixedOtherSide].adjustedCents - totals[unknownSide].adjustedCents;
  const idealQ = targetForUnknownSide / unknownUnitAdj;
  const closestQ = Math.max(0, Math.round(idealQ));

  const optionFor = (q: number): BracketOption => {
    const unknownSideTotal = totals[unknownSide].adjustedCents + q * unknownUnitAdj;
    const fixedTotal = totals[fixedOtherSide].adjustedCents;
    // diffCents from the perspective of "how far off balance": + means the side
    // that is ahead is ahead by this much.
    const diff = Math.abs(unknownSideTotal - fixedTotal);
    return { quantity: q, diffCents: diff, aheadSide: ahead(unknownSideTotal, fixedTotal, unknownSide) };
  };

  const bracket = [closestQ - 1, closestQ, closestQ + 1].filter((q) => q >= 1).map(optionFor);
  const closest = bracket.find((b) => b.quantity === closestQ) ?? optionFor(Math.max(1, closestQ));

  // Freeze the solved unknown quantity into the line set for display + persistence.
  const solvedLines: BalancedLine[] = lines.map((l) => {
    const q = l.quantity == null ? Math.max(1, closestQ) : l.quantity;
    const priced = l.unitMarketCents != null;
    const unitAdj = priced ? adjUnit(l.unitMarketCents as number, l.frictionPct, applyFriction) : null;
    return {
      side: l.side, variantId: l.variantId, label: l.label, format: l.format, quantity: q,
      unitMarketCents: l.unitMarketCents, frictionPct: l.frictionPct, unitAdjustedCents: unitAdj,
      lineMarketCents: priced ? (l.unitMarketCents as number) * q : null,
      lineAdjustedCents: unitAdj != null ? unitAdj * q : null,
      packs: l.packsIncluded != null ? l.packsIncluded * q : null,
      stale: l.stale, staleReasons: l.staleReasons, unpriced: !priced,
    };
  });

  // Pack-equivalence per side (sum of packs where known).
  const packsBySide: BalanceResult['packsBySide'] = { 1: null, 2: null };
  for (const side of [1, 2] as const) {
    const sideLines = solvedLines.filter((l) => l.side === side);
    if (sideLines.length && sideLines.every((l) => l.packs != null)) {
      packsBySide[side] = sideLines.reduce((s, l) => s + (l.packs as number), 0);
    }
  }

  // Liquidity lean — judgement, not arithmetic.
  const units = (side: 1 | 2) => solvedLines.filter((l) => l.side === side).reduce((s, l) => s + l.quantity, 0);
  const uA = units(1); const uB = units(2);
  let liquidityLean: string;
  if (uA >= 2 * uB && uB > 0) {
    liquidityLean = `Side 2 receives many small items (easier to move); Side 1 takes the fewer, larger items (harder resale).`;
  } else if (uB >= 2 * uA && uA > 0) {
    liquidityLean = `Side 1 receives many small items (easier to move); Side 2 takes the fewer, larger items (harder resale).`;
  } else {
    liquidityLean = 'Liquidity is roughly balanced between the two sides.';
  }

  // Staleness — loud.
  const staleLines = solvedLines.filter((l) => l.stale);
  const stale = staleLines.length > 0;
  if (stale) {
    warnings.push(`Unsettled/stale pricing on: ${staleLines.map((l) => l.label).join(', ')}. Treat this balance as indicative, not firm.`);
  }

  return {
    unknown: { side: unknownSide, variantId: unknown.variantId, solvedQuantity: Math.max(1, closestQ) },
    closest, bracket, lines: solvedLines, sideTotals: totals, packsBySide, liquidityLean, warnings, stale,
  };
}
