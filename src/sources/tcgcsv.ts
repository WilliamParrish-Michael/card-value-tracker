/**
 * TCGCSV source — https://tcgcsv.com
 *
 * A FREE, keyless, unmetered daily mirror of TCGplayer's catalog + prices for
 * every category (Pokemon, Pokemon Japan, One Piece, Magic, Lorcana, …). No API
 * key, no rate limit, no daily cap — the opposite of JustTCG's free tier — which
 * makes it the primary bulk source for this project.
 *
 * Verified live shape (2026-09):
 *   GET /tcgplayer/categories                       -> { results: Category[] }
 *   GET /tcgplayer/{cat}/groups                     -> { results: Group[] }   (a group = a set)
 *   GET /tcgplayer/{cat}/{group}/products           -> { results: Product[] }
 *   GET /tcgplayer/{cat}/{group}/prices             -> { results: Price[] }
 *
 * Prices are TCGplayer USD DOLLARS (float) — NOT cents (this is the reverse of
 * JustTCG). toCents multiplies by 100. It's a daily snapshot with no history, so
 * 7d/30d change accrues from our own stored observations over time.
 */

export interface TcgCsvGroup {
  groupId: number;
  name: string;
  abbreviation?: string | null;
  isSupplemental?: boolean;
  publishedOn?: string | null;   // ISO date, may be in the future (preorders)
  categoryId: number;
}

export interface TcgCsvProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string | null;
  categoryId: number;
  groupId: number;
  url?: string;
  extendedData?: Array<{ name: string; value: string }>;
}

export interface TcgCsvPrice {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
  subTypeName: string;           // 'Normal' | 'Holofoil' | 'Reverse Holofoil' | ...
}

/** Dollars (float) -> integer cents. Null-safe. */
export const toCents = (dollars: number | null | undefined): number | null =>
  dollars == null ? null : Math.round(dollars * 100);

/** Pull a named field out of a product's extendedData (e.g. 'Number', 'Rarity'). */
export const ext = (p: TcgCsvProduct, name: string): string | undefined =>
  p.extendedData?.find((e) => e.name === name)?.value;

export class TcgCsvSource {
  readonly key = 'tcgcsv' as const;
  private readonly baseUrl: string;

  constructor(opts: { baseUrl?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://tcgcsv.com';
  }

  private async get<T>(path: string): Promise<T[]> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`[tcgcsv] ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
    const body = (await res.json()) as { results?: T[] } | T[];
    return Array.isArray(body) ? body : (body.results ?? []);
  }

  listGroups(categoryId: number): Promise<TcgCsvGroup[]> {
    return this.get<TcgCsvGroup>(`/tcgplayer/${categoryId}/groups`);
  }

  fetchProducts(categoryId: number, groupId: number): Promise<TcgCsvProduct[]> {
    return this.get<TcgCsvProduct>(`/tcgplayer/${categoryId}/${groupId}/products`);
  }

  fetchPrices(categoryId: number, groupId: number): Promise<TcgCsvPrice[]> {
    return this.get<TcgCsvPrice>(`/tcgplayer/${categoryId}/${groupId}/prices`);
  }
}
