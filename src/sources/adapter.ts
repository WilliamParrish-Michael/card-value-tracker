/**
 * Source adapter layer (v2) — JustTCG primary.
 *
 * Built against the documented v1 surface:
 *   base    https://api.justtcg.com/v1
 *   auth    x-api-key header
 *   batch   POST /cards, max 200 per request
 *
 * Two things about JustTCG that shape this file:
 *
 * 1. Every variant carries a `uuid` (content-addressed, stable) and
 *    a `tcgplayerSkuId`. Store both. The UUID is your sync key; the
 *    SKU is how any second TCGplayer-derived source joins to your
 *    rows without a single string comparison.
 *
 * 2. Variants already include history — priceChange7d/30d/90d,
 *    avgPrice, min/max windows, all-time extremes, and a
 *    priceHistory array. Backfill it on first sight rather than
 *    waiting months to accumulate your own.
 */

export type SourceKey = 'justtcg' | 'tcgapi' | 'pricecharting';
export type Grader = 'PSA' | 'BGS' | 'CGC';

export interface VariantKey {
  condition?: string | null;
  printing?: string | null;
  language: string;
  grader?: Grader | null;
  grade?: number | null;
}

export interface SourceQuote {
  /** Stable external key. JustTCG variant uuid. */
  externalUuid?: string;
  /** Universal crosswalk to other TCGplayer-derived sources. */
  tcgplayerSkuId?: string | null;
  externalSlug?: string | null;

  variant: VariantKey;
  priceCents: number;
  observedOn: string;               // YYYY-MM-DD

  avg7dCents?: number | null;
  min30dCents?: number | null;
  max30dCents?: number | null;
  cov7d?: number | null;
  trendSlope30d?: number | null;
  priceChanges30d?: number | null;

  /** Historical points to backfill, oldest first. */
  history?: Array<{ observedOn: string; priceCents: number }>;
  raw: unknown;
}

export interface SourceCard {
  externalUuid: string;
  externalSlug?: string;
  game: string;
  setName: string;
  /** Set slug (JustTCG `set`), stable per set — use for sets.slug upsert. */
  setSlug?: string;
  /** Real set code like 'OP13'. JustTCG's /sets carries no code, so the sync
   *  job derives this from the collector-number prefix; the adapter leaves it unset. */
  setCode?: string;
  name: string;
  collectorNumber?: string;
  rarity?: string;
  quotes: SourceQuote[];
}

export interface PriceSource {
  readonly key: SourceKey;
  readonly games: string[];
  /** Does this source return its own history, or must you accumulate it? */
  readonly hasHistory: boolean;
  /** True only on a plan whose terms permit a public surface. */
  readonly commercialOk: boolean;

  listSets(game: string): Promise<Array<{ slug: string; name: string; releasedOn?: string | null; code?: string }>>;
  fetchSet(game: string, setSlug: string): Promise<SourceCard[]>;
  /** Batch price lookup by each variant's string id (our justtcg_slug). */
  fetchByVariantIds(variantIds: string[]): Promise<SourceCard[]>;
}

/* ------------------------------------------------------------------ */

export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly intervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    const gap = () => sleep(this.intervalMs);
    this.queue = result.then(gap, gap);
    return result;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SourceError extends Error {
  constructor(readonly source: SourceKey, readonly status: number, readonly detail: string) {
    super(`[${source}] ${status}: ${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* JustTCG                                                             */
/* ------------------------------------------------------------------ */

export interface JustTCGOptions {
  apiKey: string;
  baseUrl?: string;
  requestsPerSecond?: number;
  commercialOk?: boolean;
  /** 7 | 30 | 90 — how much history to ask for on each variant. */
  priceHistoryDays?: 7 | 30 | 90;
}

// JustTCG's free plan caps both the GET `limit` and the POST batch at 20
// ("Limit must be between 1 and 20 for your plan"). Default to 20 so it works out
// of the box; paid plans can raise it via JUSTTCG_PAGE_LIMIT (up to 200).
const PAGE_LIMIT = Math.min(Math.max(Number(process.env.JUSTTCG_PAGE_LIMIT ?? 20), 1), 200);
const BATCH_MAX = PAGE_LIMIT;

export class JustTCGSource implements PriceSource {
  readonly key: SourceKey = 'justtcg';
  readonly games = ['pokemon', 'pokemon-japan', 'magic-the-gathering', 'one-piece-card-game'];
  readonly hasHistory = true;
  readonly commercialOk: boolean;

  private readonly limiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly historyDays: number;

  constructor(private readonly opts: JustTCGOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.justtcg.com/v1';
    this.limiter = new RateLimiter(1000 / (opts.requestsPerSecond ?? 2));
    this.commercialOk = opts.commercialOk ?? false;
    this.historyDays = opts.priceHistoryDays ?? 30;
  }

  /**
   * fetch that retries a 429 with linear backoff (per-second limits are
   * transient). A 429 that survives every attempt is a real quota wall and is
   * left for the caller to surface. Runs inside the limiter slot, so the backoff
   * serializes with other requests rather than racing them.
   */
  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, init);
      if (res.status !== 429 || attempt >= maxAttempts) return res;
      await sleep(2000 * attempt); // 2s, 4s, 6s, 8s, 10s
    }
  }

  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return this.limiter.run(async () => {
      const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'x-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
      if (res.status === 429) {
        // Quota is daily as well as per-second. Back off and let the
        // caller decide whether to resume tomorrow.
        throw new SourceError(this.key, 429, 'rate limited');
      }
      if (!res.ok) {
        throw new SourceError(this.key, res.status, await res.text().catch(() => ''));
      }
      const body = (await res.json()) as { data: T; error?: string };
      if (body.error) throw new SourceError(this.key, 200, body.error);
      return body.data;
    });
  }

  async listSets(game: string) {
    const sets = await this.request<Array<{ id: string; name: string; release_date?: string }>>(
      `/sets?game=${encodeURIComponent(game)}`,
    );
    // Verified: /sets carries no set code — only a slug (`id`, e.g.
    // 'romance-dawn-one-piece-card-game') and a display `name`. The real code
    // (OP13, SV08) lives in the collector-number prefix and is derived during
    // card sync, so `code` is left unset here.
    return sets.map((s) => ({ slug: s.id, name: s.name, releasedOn: s.release_date ?? null }));
  }

  /**
   * Stream every card in a game, one page at a time. The catalog sync pages a
   * game once and groups by set slug — far cheaper than a per-set fetch while
   * the server `set` filter is unconfirmed.
   */
  async *pages(game: string, maxPages?: number): AsyncGenerator<SourceCard[]> {
    let offset = 0;
    let pageNo = 0;
    const limit = PAGE_LIMIT;
    for (;;) {
      const { cards, hasMore } = await this.getCardsPage(
        `/cards?game=${encodeURIComponent(game)}` +
          `&limit=${limit}&offset=${offset}` +
          `&priceHistoryDuration=${this.historyDays}d`,
      );
      yield cards.map((c) => this.toSourceCard(c));
      pageNo += 1;
      // maxPages caps a demo/bootstrap run so it stays inside the free tier's
      // daily quota (100 req/day) and finishes in one HTTP request.
      if (maxPages && pageNo >= maxPages) break;
      if (!hasMore || cards.length === 0) break;
      offset += limit;
    }
  }

  /** One page of /cards. Returns the data plus the envelope's `meta.hasMore`. */
  private getCardsPage(path: string): Promise<{ cards: JtCard[]; hasMore: boolean }> {
    return this.limiter.run(async () => {
      const res = await this.fetchWithRetry(`${this.baseUrl}${path}`, {
        headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json' },
      });
      if (res.status === 429) throw new SourceError(this.key, 429, 'rate limited');
      if (!res.ok) throw new SourceError(this.key, res.status, await res.text().catch(() => ''));
      const body = (await res.json()) as { data?: JtCard[]; meta?: { hasMore?: boolean } };
      return { cards: body.data ?? [], hasMore: !!body.meta?.hasMore };
    });
  }

  async fetchSet(game: string, setSlug: string): Promise<SourceCard[]> {
    // The server-side `set` filter param could NOT be confirmed on the free tier
    // (intermittent 400s under rate limiting). Rather than build on that guess,
    // page the confirmed game-wide listing and keep only cards whose `set` slug
    // matches — correct regardless of whether the server honors a `set` filter.
    // Swap to `&set=${setSlug}` once scripts/verify.js confirms it on a paid key;
    // that turns this from an O(game) scan into an O(set) fetch.
    const out: SourceCard[] = [];
    let offset = 0;
    const limit = 100;

    for (;;) {
      const { cards, hasMore } = await this.getCardsPage(
        `/cards?game=${encodeURIComponent(game)}` +
          `&limit=${limit}&offset=${offset}` +
          `&priceHistoryDuration=${this.historyDays}d`,
      );
      for (const c of cards) if (c.set === setSlug) out.push(this.toSourceCard(c));
      if (!hasMore || cards.length === 0) break;
      offset += limit;
    }
    return out;
  }

  /**
   * Batch refresh. This is the endpoint the nightly job lives on — a page of
   * variants per request instead of one request per variant.
   *
   * Verified shape: POST /cards takes a BARE TOP-LEVEL ARRAY of lookup objects
   * (`[{"variantId": "<variant.id>"}, ...]`) — NOT `{cards:[...]}` (that 400s
   * with "Batch request body must be an array of lookup objects"). The lookup
   * key is the variant's string `id` (our justtcg_slug), not its uuid
   * (`{uuid}`/`{cardId}` lookups return zero rows). priceHistoryDuration goes on
   * the query string. Each match returns the card carrying just that variant, so
   * the caller re-matches on externalSlug (v.id).
   */
  async fetchByVariantIds(variantIds: string[]): Promise<SourceCard[]> {
    const out: SourceCard[] = [];

    for (let i = 0; i < variantIds.length; i += BATCH_MAX) {
      const chunk = variantIds.slice(i, i + BATCH_MAX);
      try {
        const cards = await this.request<JtCard[]>(
          `/cards?priceHistoryDuration=${this.historyDays}d`,
          {
            method: 'POST',
            body: JSON.stringify(chunk.map((variantId) => ({ variantId }))),
          },
        );
        out.push(...cards.map((c) => this.toSourceCard(c)));
      } catch (err) {
        if (err instanceof SourceError && err.status === 429) throw err;
        // A bad chunk shouldn't sink the whole run.
        console.warn(`[justtcg] batch ${i}-${i + chunk.length} failed`, err);
      }
    }
    return out;
  }

  private toSourceCard(c: JtCard): SourceCard {
    const observedOn = today();
    return {
      externalUuid: c.uuid,
      externalSlug: c.id,
      game: c.game,
      // Verified shape: `set` is a slug ('romance-dawn-one-piece-card-game'),
      // `set_name` is the display name ('Romance Dawn'). The old code used
      // `c.set` as the display name — that was the slug.
      setSlug: c.set,
      setName: c.set_name ?? c.set,   // fall back to the slug if the display name is absent
      name: c.name,
      collectorNumber: c.number,   // 'OP13-118' for singles, 'N/A' for sealed
      rarity: c.rarity,
      quotes: (c.variants ?? []).map((v) => ({
        externalUuid: v.uuid,
        externalSlug: v.id,
        tcgplayerSkuId: v.tcgplayerSkuId ?? null,
        variant: {
          condition: v.condition ?? null,
          printing: v.printing ?? null,
          // Docs: language is only recorded for non-English printings,
          // so absent means English. Don't store NULL here — it would
          // break the NULLS NOT DISTINCT natural key on variants.
          language: v.language ?? 'English',
          grader: v.grader ?? null,
          grade: v.grade ?? null,
        },
        priceCents: toCents(v.price),
        observedOn,
        avg7dCents: toCentsOrNull(v.avgPrice),
        min30dCents: toCentsOrNull(v.minPrice30d),
        max30dCents: toCentsOrNull(v.maxPrice30d),
        cov7d: v.covPrice7d ?? null,
        trendSlope30d: v.trendSlope30d ?? null,
        priceChanges30d: v.priceChangesCount30d ?? null,
        // Verified point shape: { p: cents, t: unixSeconds }. Field is
        // `priceHistory` (populated when priceHistoryDuration is requested).
        history: (v.priceHistory ?? [])
          .map((pt) => ({
            observedOn: new Date(pt.t * 1000).toISOString().slice(0, 10),
            priceCents: toCents(pt.p),
          }))
          .sort((a, b) => a.observedOn.localeCompare(b.observedOn)),
        raw: v,
      })),
    };
  }
}

/* ------------------------------------------------------------------ */

interface JtPricePoint { p: number; t: number }  // p = cents, t = unix seconds

// Verified variant shape (subset of the ~45 fields JustTCG returns per variant).
interface JtVariant {
  uuid: string;
  id: string;
  condition?: string;
  printing?: string;
  language?: string;            // present and populated (e.g. 'English')
  grader?: Grader;              // JustTCG v2 exposes graded copies as variants
  grade?: number;
  tcgplayerSkuId?: string;
  price: number;                // ALREADY IN CENTS (float; may be fractional)
  lastUpdated: number;          // unix seconds
  avgPrice?: number | null;     // cents
  minPrice30d?: number | null;  // cents
  maxPrice30d?: number | null;  // cents
  covPrice7d?: number | null;
  trendSlope30d?: number | null;
  priceChangesCount30d?: number | null;
  priceHistory?: JtPricePoint[] | null;
}

// Verified card shape: `set` is a slug, `set_name` is the display name,
// `number` is the collector number ('OP13-118') or 'N/A' for sealed.
interface JtCard {
  uuid: string;
  id: string;
  game: string;
  set: string;
  set_name?: string;
  name: string;
  number?: string;
  rarity?: string;
  tcgplayerId?: string | number;
  details?: unknown;
  variants?: JtVariant[];
}

/**
 * JustTCG prices are ALREADY IN CENTS — verified against the live API with
 * scripts/verify.js (e.g. price 377.29 = $3.77, 49499 = $494.99, and a
 * priceHistory point p:13000 = $130.00). The published docs called `price`
 * a "USD float"; that is wrong, and multiplying by 100 made every number
 * 100x too high. Values can be fractional cents, so round to a whole cent.
 * Do NOT multiply by 100.
 */
const toCents = (cents: number): number => Math.round(cents);
const toCentsOrNull = (cents: number | null | undefined): number | null =>
  cents == null ? null : toCents(cents);

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export class SourceRegistry {
  private readonly sources = new Map<SourceKey, PriceSource>();

  register(source: PriceSource): this {
    this.sources.set(source.key, source);
    return this;
  }

  get(key: SourceKey): PriceSource | undefined {
    return this.sources.get(key);
  }

  forGame(game: string): PriceSource[] {
    return [...this.sources.values()].filter((s) => s.games.includes(game));
  }

  /** Use this to build anything user-facing and public. */
  commercialForGame(game: string): PriceSource[] {
    return this.forGame(game).filter((s) => s.commercialOk);
  }
}
