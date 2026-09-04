/**
 * Seed the SEALED catalog from PriceCharting — Pokémon + One Piece only.
 *
 * Seeds IDENTITIES, never prices: this writes products / variants / sealed_config
 * and must never touch price_observations or daily_valuations (Rule Zero). Prices
 * arrive later via sync-sealed-prices.
 *
 * Set lists are NOT hardcoded (they go stale and guessing them is invented data).
 * We crawl PriceCharting's search per GAME, keep only Genre "Sealed Product", map
 * each by its console-name to our category, upsert on pricecharting_id, and
 * classify the format from the product name — leaving it NULL when nothing matches
 * rather than guessing. packs_included / cards_per_pack come from the manufacturer
 * and are left NULL here unless already known.
 *
 * Coverage note: the public API exposes search, not a full category listing, so a
 * single run captures what search returns. Pass extra query terms as CLI args to
 * widen the crawl (e.g. `tsx seed-sealed.ts "prismatic evolutions" "OP-17"`).
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { buildRegistry } from '../sources/registry.js';
import type { PriceChartingSource, PcProduct } from '../sources/pricecharting.js';

const POKEMON_FORMATS = [
  'Booster Bundle', 'Booster Box', 'Elite Trainer Box', 'Ultra Premium Collection',
  'Super Premium Collection', 'Premium Collection', 'Binder Collection', 'Build & Battle Box',
  'Build & Battle Stadium', 'Checklane Blister', '3-Pack Blister', 'Surprise Box', 'Mini Tin',
  'Poster Collection', 'Booster Pack', 'Tin', 'Case',
];
const ONE_PIECE_FORMATS = [
  'Booster Box', 'Starter Deck', 'Double Pack Set', 'Premium Booster', 'Ultra Deck',
  'Gift Collection', 'Tournament Pack', 'Booster Pack', 'Case',
];

/** Longest matching format wins ("Super Premium Collection" beats "Premium Collection"). */
function classifyFormat(name: string, game: string): string | null {
  const list = game === 'one-piece' ? ONE_PIECE_FORMATS : POKEMON_FORMATS;
  const hay = name.toLowerCase();
  const hits = list.filter((f) => hay.includes(f.toLowerCase())).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}

/** Category slug from PriceCharting console-name. Pokémon (JP) vs Pokémon vs One Piece. */
function categoryFor(consoleName: string): string | null {
  const c = consoleName.toLowerCase();
  if (c.includes('one piece')) return 'one-piece';
  if (c.includes('pokemon') && c.includes('japan')) return 'pokemon-jp';
  if (c.includes('pokemon')) return 'pokemon';
  return null;
}

const nameSlug = (name: string) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function categoryIds(): Promise<Map<string, number>> {
  const rows = await sequelize.query<{ id: number; slug: string }>(
    `SELECT id, slug FROM categories`, { type: QueryTypes.SELECT });
  return new Map(rows.map((r) => [r.slug, r.id]));
}

async function upsertSealedSet(categoryId: number, consoleName: string): Promise<string> {
  const slug = nameSlug(consoleName) || 'sealed';
  const [row] = await sequelize.query<{ id: string }>(
    `INSERT INTO sets (category_id, set_code, slug, name)
     VALUES ($cat, $code, $slug, $name)
     ON CONFLICT (category_id, slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    { bind: { cat: categoryId, code: slug, slug, name: consoleName }, type: QueryTypes.SELECT },
  );
  return row.id;
}

async function upsertSealedProduct(categoryId: number, setId: string, p: PcProduct): Promise<string | null> {
  try {
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO products
         (category_id, set_id, kind, collector_number, name, name_slug, rarity,
          upc, pricecharting_id, ebay_epid, tcgplayer_id, updated_at)
       VALUES ($cat, $set, 'sealed', 'N/A', $name, $slug, '', $upc, $pc, $epid, $tcg, now())
       ON CONFLICT (pricecharting_id) WHERE pricecharting_id IS NOT NULL DO UPDATE
         SET name = EXCLUDED.name, upc = EXCLUDED.upc, ebay_epid = EXCLUDED.ebay_epid,
             tcgplayer_id = EXCLUDED.tcgplayer_id, updated_at = now()
       RETURNING id`,
      {
        bind: {
          cat: categoryId, set: setId, name: p.name, slug: nameSlug(p.name),
          upc: p.upc, pc: p.id, epid: p.epid, tcg: p.tcgplayerId,
        },
        type: QueryTypes.SELECT,
      },
    );
    return row.id;
  } catch (err) {
    console.warn(`[seed-sealed] product "${p.name}" (${p.id}) failed:`, (err as Error).message);
    return null;
  }
}

async function ensureSealedVariant(productId: string): Promise<void> {
  const existing = await sequelize.query(
    `SELECT 1 FROM variants WHERE product_id = $pid AND condition = 'Sealed' LIMIT 1`,
    { bind: { pid: productId }, type: QueryTypes.SELECT });
  if (existing.length) return;
  await sequelize.query(
    `INSERT INTO variants (product_id, condition, printing, language, grader, grade)
     VALUES ($pid, 'Sealed', NULL, 'English', NULL, NULL)`,
    { bind: { pid: productId } });
}

async function upsertSealedConfig(productId: string, format: string | null, releasedOn: string | null): Promise<void> {
  // format is NOT NULL in the table; skip config rather than store a guessed format.
  if (!format) return;
  await sequelize.query(
    `INSERT INTO sealed_config (product_id, format, released_on)
     VALUES ($pid, $fmt, $rel)
     ON CONFLICT (product_id) DO UPDATE SET format = EXCLUDED.format, released_on = EXCLUDED.released_on`,
    { bind: { pid: productId, fmt: format, rel: releasedOn } });
}

export async function seedSealed(queries?: string[]): Promise<{ products: number; configs: number; searched: number }> {
  const src = buildRegistry().get('pricecharting') as PriceChartingSource | undefined;
  if (!src) throw new Error('PriceCharting not configured — set PRICECHARTING_TOKEN.');

  const cats = await categoryIds();
  // Default crawl terms = the game names (never a hardcoded set list). Operator
  // can widen via CLI args.
  const terms = queries && queries.length ? queries
    : ['Pokemon', 'Pokemon Japanese', 'One Piece Card Game'];

  const setCache = new Map<string, string>();
  const stats = { products: 0, configs: 0, searched: 0 };
  const seen = new Set<string>();

  for (const term of terms) {
    let results: PcProduct[] = [];
    try { results = await src.searchProducts(term); } catch (err) {
      console.warn(`[seed-sealed] search "${term}" failed:`, (err as Error).message); continue;
    }
    stats.searched += results.length;

    for (const p of results) {
      if (!src.isSealed(p) || !p.id || seen.has(p.id)) continue;
      const catSlug = categoryFor(p.consoleName);
      if (!catSlug) continue;             // not one of our games — skip, don't guess
      const categoryId = cats.get(catSlug);
      if (!categoryId) continue;

      const setKey = `${categoryId}:${p.consoleName}`;
      let setId = setCache.get(setKey);
      if (!setId) { setId = await upsertSealedSet(categoryId, p.consoleName); setCache.set(setKey, setId); }

      const productId = await upsertSealedProduct(categoryId, setId, p);
      if (!productId) continue;
      seen.add(p.id);
      stats.products += 1;

      await ensureSealedVariant(productId);
      const format = classifyFormat(p.name, catSlug);
      if (format) { await upsertSealedConfig(productId, format, p.releaseDate); stats.configs += 1; }
    }
  }

  return stats;
}

const isMain = process.argv[1]?.endsWith('seed-sealed.ts');
if (isMain) {
  const args = process.argv.slice(2);
  seedSealed(args.length ? args : undefined)
    .then((s) => { console.log('[seed-sealed] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[seed-sealed] failed', err); process.exit(1); });
}
