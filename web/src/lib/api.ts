/**
 * Typed client for our own API. The browser only ever calls /api/* on our
 * origin — never JustTCG or PSA directly (keys stay server-side).
 *
 * Money is integer cents end to end. fmtCents renders null/undefined as "—"
 * (unpriced), never as $0.00 — a missing price must look missing (Rule Zero).
 */

export const fmtCents = (c: number | null | undefined): string =>
  c == null ? '—' : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtPct = (p: number | string | null | undefined): string => {
  if (p == null) return '—';
  const n = typeof p === 'string' ? Number(p) : p;
  if (Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
};

export interface Health { ok: boolean; db: boolean; priceSource: boolean; psa: boolean; }

export interface SearchHit {
  product_id: string; game: string; set_code: string; collector_number: string;
  name: string; rarity: string | null; kind: string; image_url: string | null;
  market_cents: number | null; confidence: string | null;
}

export interface HoldingRow {
  id: string; quantity: number; acquired_cents: number | null; acquired_on: string | null; notes: string | null;
  variant_id: string; condition: string | null; printing: string | null; language: string | null;
  grader: string | null; grade: string | null; name: string; collector_number: string; rarity: string | null;
  game: string; set_code: string; kind: string;
  market_cents: number | null; change_7d_pct: string | null; change_30d_pct: string | null; confidence: string | null;
  cash_offer_cents: number | null; cash_rate_pct: number | null;
  credit_offer_cents: number | null; credit_rate_pct: number | null; unpriced: boolean;
}

export interface ProductInfo {
  id: string; name: string; collector_number: string; rarity: string | null;
  kind: string; image_url: string | null; game: string; set_code: string;
}
export interface VariantRow {
  id: string; condition: string | null; printing: string | null; language: string | null;
  grader: string | null; grade: string | null;
  market_cents: number | null; change_7d_pct: string | null; confidence: string | null; valued_on: string | null;
}

export interface Observation {
  source_key: string; observed_on: string; price_cents: number;
  avg_7d_cents: number | null; min_30d_cents: number | null; max_30d_cents: number | null;
  cov_7d: string | null; is_backfill: boolean;
}
export interface ValuationDetail {
  variant: Record<string, unknown>;
  valuation: Record<string, unknown> | null;
  singleSource: boolean | null;
  stale: boolean;
  latestObservedOn: string | null;
  observations: Observation[];
}

export interface ScanCandidate {
  product_id: string; game: string; set_code: string; collector_number: string;
  name: string; rarity: string | null; score: number;
}
export interface ScanResult {
  resolved: boolean;
  variant?: Record<string, unknown>;
  cert?: { certNumber: string; year?: string; brand?: string; subject?: string; cardNumber?: string; grade?: string; imageUrl?: string | null };
  grade?: number | null;
  match?: ScanCandidate | null;
  candidates?: ScanCandidate[];
  threshold?: number;
}

export interface ApiError { error: string; reason?: string; }

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, reason: body.reason });
  return body as T;
}

export const api = {
  async health(): Promise<Health> {
    return jsonOrThrow<Health>(await fetch('/api/health'));
  },
  async search(q: string, game?: string): Promise<SearchHit[]> {
    const u = new URL('/api/search', location.origin);
    u.searchParams.set('q', q);
    if (game) u.searchParams.set('game', game);
    return (await jsonOrThrow<{ data: SearchHit[] }>(await fetch(u))).data;
  },
  async productVariants(productId: string): Promise<{ product: ProductInfo; variants: VariantRow[] }> {
    return (await jsonOrThrow<{ data: { product: ProductInfo; variants: VariantRow[] } }>(await fetch(`/api/search/product/${productId}`))).data;
  },
  async collection(): Promise<HoldingRow[]> {
    return (await jsonOrThrow<{ data: HoldingRow[] }>(await fetch('/api/collection'))).data;
  },
  async addHolding(input: { variant_id: string; quantity?: number; acquired_cents?: number | null; acquired_on?: string | null; notes?: string | null }): Promise<{ id: string }> {
    return (await jsonOrThrow<{ data: { id: string } }>(await fetch('/api/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }))).data;
  },
  async patchHolding(id: string, patch: Partial<{ quantity: number; acquired_cents: number | null; acquired_on: string | null; notes: string | null }>): Promise<void> {
    await jsonOrThrow(await fetch(`/api/collection/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }));
  },
  async deleteHolding(id: string): Promise<void> {
    await jsonOrThrow(await fetch(`/api/collection/${id}`, { method: 'DELETE' }));
  },
  collectionCsvUrl: '/api/collection/export.csv',
  async valuation(variantId: string): Promise<ValuationDetail> {
    return (await jsonOrThrow<{ data: ValuationDetail }>(await fetch(`/api/valuation/${variantId}`))).data;
  },
  async scanCert(cert: string): Promise<ScanResult> {
    return (await jsonOrThrow<{ data: ScanResult }>(await fetch('/api/scan/cert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cert }),
    }))).data;
  },
  async scanConfirm(input: { cert: string; product_id: string; grade: number; grader?: string }): Promise<{ variant_id: string }> {
    return (await jsonOrThrow<{ data: { variant_id: string } }>(await fetch('/api/scan/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }))).data;
  },
  async scanUpc(upc: string): Promise<{ matches: Array<{ product_id: string; game: string; set_code: string; name: string }>; needsAssociation: boolean }> {
    return (await jsonOrThrow<{ data: { matches: Array<{ product_id: string; game: string; set_code: string; name: string }>; needsAssociation: boolean } }>(await fetch('/api/scan/upc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc }),
    }))).data;
  },
};

export interface TradeRuleRow {
  id: number; category_id: number | null; kind: string | null; currency: 'cash' | 'credit';
  min_cents: number; max_cents: number | null; rate_pct: string; floor_cents: number;
  ceiling_cents: number | null; max_cov_7d: string | null; volatility_penalty_pct: string;
  effective_from: string; notes: string | null;
}

export const tradeRulesApi = {
  async list(): Promise<TradeRuleRow[]> {
    return (await jsonOrThrow<{ data: TradeRuleRow[] }>(await fetch('/api/trade-rules'))).data;
  },
  async update(id: number, patch: Partial<{ rate_pct: number; floor_cents: number; ceiling_cents: number | null; volatility_penalty_pct: number; notes: string }>): Promise<void> {
    await jsonOrThrow(await fetch(`/api/trade-rules/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }));
  },
};

// --- Trade balancer ---
export interface BracketOption { quantity: number; diffCents: number; aheadSide: 1 | 2 | 'even'; }
export interface BalancedLine {
  side: 1 | 2; variantId: string; label: string; format: string | null; quantity: number;
  unitMarketCents: number | null; frictionPct: number; unitAdjustedCents: number | null;
  lineMarketCents: number | null; lineAdjustedCents: number | null; packs: number | null;
  stale: boolean; staleReasons: string[]; unpriced: boolean;
}
export interface BalanceResult {
  sessionId?: string;
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
export interface FrictionRow {
  product_id: string; manual_score: number | null; purchase_limit: number | null;
  is_allocated: boolean; notes: string | null; auto_score: number | null;
  auto_inputs: unknown; auto_computed_at: string | null; premium_pct: string;
}

export const tradesApi = {
  async balance(input: { sideA: Array<{ variantId: string; quantity?: number }>; sideB: Array<{ variantId: string; quantity?: number }>; applyFriction?: boolean; label?: string }): Promise<BalanceResult> {
    return (await jsonOrThrow<{ data: BalanceResult }>(await fetch('/api/trades/balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }))).data;
  },
  async friction(productId: string): Promise<FrictionRow | null> {
    return (await jsonOrThrow<{ data: FrictionRow | null }>(await fetch(`/api/trades/friction/${productId}`))).data;
  },
  async setFriction(productId: string, patch: Partial<{ manual_score: number; purchase_limit: number; is_allocated: boolean; notes: string; premium_pct: number }>): Promise<void> {
    await jsonOrThrow(await fetch(`/api/trades/friction/${productId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    }));
  },
};

export const GAMES: Array<{ slug: string; label: string }> = [
  { slug: '', label: 'All games' },
  { slug: 'pokemon', label: 'Pokémon' },
  { slug: 'pokemon-jp', label: 'Pokémon (JP)' },
  { slug: 'mtg', label: 'Magic' },
  { slug: 'one-piece', label: 'One Piece' },
];
