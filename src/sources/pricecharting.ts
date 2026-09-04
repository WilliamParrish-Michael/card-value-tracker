/**
 * PriceCharting — the SEALED source (JustTCG stays the singles source; route by
 * products.kind). Implements the PriceSource shape, but sealed reality differs:
 *
 *   - Base https://www.pricecharting.com, token as the query param `t`.
 *   - HARD 1 request/second (sustained abuse revokes the account) — reuse the
 *     shared RateLimiter.
 *   - CURRENT VALUES ONLY: no history, nothing to backfill. hasHistory = false.
 *     The nightly snapshot into price_observations is the only sealed history that
 *     will ever exist, so it must start on day one.
 *   - Prices come back as integer PENNIES already — no float conversion.
 *   - Sealed products carry Genre "Sealed Product" and expose UPC, ePID (eBay),
 *     TCGplayer ID, and the PriceCharting ID.
 *
 * UNVERIFIED (per the addendum): the exact price field names are reused from the
 * video-game catalog. We only need `loose-price` and `new-price`; verify both
 * against a known product (scripts/verify-pricecharting.js) before a bulk sync.
 */
import { RateLimiter, SourceError, type PriceSource, type SourceCard, type SourceKey } from './adapter.js';

export interface PcProduct {
  id: string;
  name: string;
  consoleName: string;      // PriceCharting's category, e.g. "Pokemon Prismatic Evolutions"
  genre: string | null;     // "Sealed Product" for our targets
  releaseDate: string | null;
  upc: string | null;
  epid: string | null;      // eBay product id
  tcgplayerId: string | null;
  looseCents: number | null;
  newCents: number | null;
  raw: unknown;
}

const asCents = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  // PriceCharting values are already integer pennies; round defensively.
  return Number.isFinite(n) ? Math.round(n) : null;
};
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export interface PriceChartingOptions {
  token?: string;
  baseUrl?: string;
  requestsPerSecond?: number; // capped at 1 by the API; default 1
  commercialOk?: boolean;
}

export class PriceChartingSource implements PriceSource {
  readonly key: SourceKey = 'pricecharting';
  readonly games = ['pokemon', 'pokemon-japan', 'one-piece-card-game']; // sealed scope
  readonly hasHistory = false;
  readonly commercialOk: boolean;

  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;

  constructor(private readonly opts: PriceChartingOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://www.pricecharting.com';
    // Never exceed 1/sec regardless of the requested rate.
    const rps = Math.min(1, opts.requestsPerSecond ?? 1);
    this.limiter = new RateLimiter(Math.ceil(1000 / rps));
    this.commercialOk = opts.commercialOk ?? false;
  }

  get configured(): boolean { return Boolean(this.opts.token); }

  private request<T>(path: string): Promise<T> {
    return this.limiter.run(async () => {
      if (!this.opts.token) throw new SourceError(this.key, 503, 'PriceCharting not configured — set PRICECHARTING_TOKEN');
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(`${this.baseUrl}${path}${sep}t=${encodeURIComponent(this.opts.token)}`);
      if (res.status === 429) throw new SourceError(this.key, 429, 'rate limited (1 req/sec max)');
      if (!res.ok) throw new SourceError(this.key, res.status, await res.text().catch(() => ''));
      return (await res.json()) as T;
    });
  }

  private normalize(raw: Record<string, unknown>): PcProduct {
    return {
      id: String(raw['id'] ?? ''),
      name: String(raw['product-name'] ?? raw['name'] ?? ''),
      consoleName: String(raw['console-name'] ?? ''),
      genre: str(raw['genre']),
      releaseDate: str(raw['release-date']),
      upc: str(raw['upc']),
      epid: str(raw['epid'] ?? raw['ebay-epid']),
      tcgplayerId: str(raw['tcg-id'] ?? raw['tcgplayer-id'] ?? raw['tcgplayerId']),
      looseCents: asCents(raw['loose-price']),
      newCents: asCents(raw['new-price']),
      raw,
    };
  }

  /** One product by PriceCharting id. */
  async fetchProduct(id: string): Promise<PcProduct> {
    const raw = await this.request<Record<string, unknown>>(`/api/product?id=${encodeURIComponent(id)}`);
    return this.normalize(raw);
  }

  /** Search products (used by the sealed seed crawl). Handles {products:[…]} or a bare array. */
  async searchProducts(query: string): Promise<PcProduct[]> {
    const body = await this.request<{ products?: Record<string, unknown>[] } | Record<string, unknown>[]>(
      `/api/products?q=${encodeURIComponent(query)}`,
    );
    const list = Array.isArray(body) ? body : (body.products ?? []);
    return list.map((p) => this.normalize(p));
  }

  isSealed(p: PcProduct): boolean {
    return (p.genre ?? '').toLowerCase() === 'sealed product';
  }

  /** Sealed market value in cents: the factory-new price, falling back to loose. */
  sealedValueCents(p: PcProduct): number | null {
    return p.newCents ?? p.looseCents ?? null;
  }

  // --- PriceSource interface -------------------------------------------------
  // PriceCharting has no set index via the API; the seed crawls categories.
  async listSets(): Promise<Array<{ slug: string; name: string }>> { return []; }
  async fetchSet(): Promise<SourceCard[]> { return []; }

  /** Fetch current sealed values by PriceCharting id (used by the sealed price snapshot). */
  async fetchByIds(ids: string[]): Promise<SourceCard[]> {
    const out: SourceCard[] = [];
    for (const id of ids) {
      try {
        const p = await this.fetchProduct(id);
        const cents = this.sealedValueCents(p);
        if (cents == null) continue;
        out.push({
          externalUuid: p.id,
          game: p.consoleName,
          setName: p.consoleName,
          name: p.name,
          collectorNumber: 'N/A',
          quotes: [{
            externalUuid: p.id,
            variant: { condition: 'Sealed', printing: null, language: 'English', grader: null, grade: null },
            priceCents: cents,
            observedOn: new Date().toISOString().slice(0, 10),
            raw: p.raw,
          }],
        });
      } catch (err) {
        if (err instanceof SourceError && err.status === 429) throw err;
        console.warn(`[pricecharting] product ${id} failed`, (err as Error).message);
      }
    }
    return out;
  }
}

export function buildPriceCharting(env: NodeJS.ProcessEnv = process.env): PriceChartingSource {
  return new PriceChartingSource({
    token: env.PRICECHARTING_TOKEN?.trim(),
    commercialOk: env.PRICECHARTING_COMMERCIAL === 'true',
  });
}
