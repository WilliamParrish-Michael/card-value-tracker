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

export type SourceKey = 'justtcg' | 'tcgapi';
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

  listSets(game: string): Promise<Array<{ code?: string; name: string }>>;
  fetchSet(game: string, setName: string): Promise<SourceCard[]>;
  fetchByIds(uuids: string[]): Promise<SourceCard[]>;
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

const BATCH_MAX = 200;

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

  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return this.limiter.run(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
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
    const sets = await this.request<Array<{ id: string; name: string; code?: string }>>(
      `/sets?game=${encodeURIComponent(game)}`,
    );
    return sets.map((s) => ({ code: s.code, name: s.name }));
  }

  async fetchSet(game: string, setName: string): Promise<SourceCard[]> {
    const cards: JtCard[] = [];
    let offset = 0;
    const limit = 100;

    // Paginate to exhaustion. A large Pokemon set runs several pages.
    for (;;) {
      const page = await this.request<JtCard[]>(
        `/cards?game=${encodeURIComponent(game)}` +
          `&set=${encodeURIComponent(setName)}` +
          `&limit=${limit}&offset=${offset}` +
          `&priceHistoryDuration=${this.historyDays}d`,
      );
      cards.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }
    return cards.map((c) => this.toSourceCard(c));
  }

  /**
   * Batch refresh. This is the endpoint your nightly job should live
   * on — 200 cards per request instead of 200 requests.
   */
  async fetchByIds(uuids: string[]): Promise<SourceCard[]> {
    const out: SourceCard[] = [];

    for (let i = 0; i < uuids.length; i += BATCH_MAX) {
      const chunk = uuids.slice(i, i + BATCH_MAX);
      try {
        const cards = await this.request<JtCard[]>('/cards', {
          method: 'POST',
          body: JSON.stringify({
            cards: chunk.map((uuid) => ({ uuid })),
            priceHistoryDuration: `${this.historyDays}d`,
          }),
        });
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
      setName: c.set,
      name: c.name,
      collectorNumber: c.number,
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
        history: (v.priceHistory30d ?? v.priceHistory ?? [])
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

interface JtPricePoint { p: number; t: number }

interface JtVariant {
  uuid: string;
  id: string;
  condition?: string;
  printing?: string;
  language?: string;
  grader?: Grader;
  grade?: number;
  tcgplayerSkuId?: string;
  price: number;                 // USD, float
  lastUpdated: number;
  avgPrice?: number | null;
  minPrice30d?: number | null;
  maxPrice30d?: number | null;
  covPrice7d?: number | null;
  trendSlope30d?: number | null;
  priceChangesCount30d?: number | null;
  priceHistory?: JtPricePoint[] | null;
  priceHistory30d?: JtPricePoint[] | null;
}

interface JtCard {
  uuid: string;
  id: string;
  game: string;
  set: string;
  name: string;
  number?: string;
  rarity?: string;
  variants?: JtVariant[];
}

/**
 * USD float -> integer cents. `4.99 * 100` is 498.99999999999994 in
 * IEEE754, so the rounding is not optional.
 */
const toCents = (usd: number): number => Math.round(usd * 100);
const toCentsOrNull = (usd: number | null | undefined): number | null =>
  usd == null ? null : toCents(usd);

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
