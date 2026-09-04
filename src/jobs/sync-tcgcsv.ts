/**
 * TCGCSV bulk sync — loads a game's catalog + current prices from tcgcsv.com
 * (free, keyless, no rate limit) in one pass. This is the quota-free path to
 * populating any game, including Pokemon.
 *
 * Per group (= set): upsert the set, its products, a variant per price subtype
 * (Normal / Holofoil / Reverse Holofoil …), and one price_observations row per
 * variant/day (ON CONFLICT DO NOTHING, so re-running the same day is a no-op).
 * No prices are invented: a product tcgcsv returns no price row for gets no
 * observation and stays unvalued.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { TcgCsvSource, toCents, ext, type TcgCsvProduct, type TcgCsvPrice } from '../sources/tcgcsv.js';

// Our category slug (justtcg_game) -> tcgcsv/TCGplayer categoryId.
const GAME_TO_CATEGORY: Record<string, number> = {
  'pokemon': 3,
  'pokemon-japan': 85,
  'magic-the-gathering': 1,
  'one-piece-card-game': 68,
};

const nameSlug = (name: string): string =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const today = () => new Date().toISOString().slice(0, 10);

async function ensureSource(): Promise<void> {
  // compute blends only sources that exist + are enabled; make sure ours does.
  await sequelize.query(
    `INSERT INTO sources (key, display_name, blend_weight, is_enabled, commercial_ok)
     VALUES ('tcgcsv', 'TCGplayer (via TCGCSV)', 1.0, true, false)
     ON CONFLICT (key) DO NOTHING`,
  );
}

async function upsertSet(categoryId: number, slug: string, code: string, name: string, releasedOn: string | null): Promise<string> {
  // sets has TWO unique keys: (category_id, slug) AND (category_id, set_code).
  // Abbreviations collide (many Pokemon promo sets are 'PR'), so seed set_code
  // with the slug (guaranteed unique per category) and adopt the readable
  // abbreviation only if it's still free — mirrors the catalog sync's stampSetCode.
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO sets (category_id, set_code, slug, name, released_on)
     VALUES ($cat, $slug, $slug, $name, $rel)
     ON CONFLICT (category_id, slug) DO UPDATE
       SET name = EXCLUDED.name, released_on = COALESCE(sets.released_on, EXCLUDED.released_on)
     RETURNING id`,
    { bind: { cat: categoryId, slug, name, rel: releasedOn }, type: QueryTypes.SELECT },
  );
  const setId = rows[0].id;
  if (code && code !== slug) {
    await sequelize.query(
      `UPDATE sets SET set_code = $code
        WHERE id = $id
          AND NOT EXISTS (SELECT 1 FROM sets WHERE category_id = $cat AND set_code = $code AND id <> $id)`,
      { bind: { code, id: setId, cat: categoryId } },
    );
  }
  return setId;
}

// A no-Number product is either sealed product or an accessory. Split them so
// the Type filter can offer Cards / Sealed / Accessories. Code cards (digital)
// and physical accessories (sleeves, playmats, binders, pouches, deck boxes…)
// count as accessories; everything else no-Number is sealed product.
const ACCESSORY_RE = /\b(sleeve|sleeves|playmat|play mat|deck box|binder|portfolio|pouch|toploader|top loader|card case|dice|counter|marker|storage|album|figure|pin|plush|deck shield|deck holder)\b|^code card|code card -/i;
function classifyKind(p: TcgCsvProduct): 'single' | 'sealed' | 'accessory' {
  if (ext(p, 'Number')) return 'single';
  return ACCESSORY_RE.test(p.name) ? 'accessory' : 'sealed';
}

async function upsertProduct(categoryId: number, setId: string, p: TcgCsvProduct): Promise<string> {
  const number = ext(p, 'Number');
  const kind = classifyKind(p);
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO products
       (category_id, set_id, kind, collector_number, name, name_slug, rarity, image_url, tcgplayer_id, updated_at)
     VALUES ($cat, $set, $kind, $num, $name, $slug, $rarity, $img, $tid, now())
     ON CONFLICT (set_id, collector_number, name_slug, rarity) DO UPDATE
       SET name = EXCLUDED.name, kind = EXCLUDED.kind,
           image_url = COALESCE(EXCLUDED.image_url, products.image_url),
           tcgplayer_id = EXCLUDED.tcgplayer_id, updated_at = now()
     RETURNING id`,
    {
      bind: {
        cat: categoryId, set: setId, kind,
        num: number || 'N/A', name: p.name, slug: nameSlug(p.name),
        rarity: ext(p, 'Rarity') ?? '', img: p.imageUrl ?? null, tid: String(p.productId),
      },
      type: QueryTypes.SELECT,
    },
  );
  return rows[0].id;
}

async function upsertVariant(productId: string, printing: string, language: string): Promise<string> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO variants (product_id, condition, printing, language, last_synced_at)
     VALUES ($pid, 'Near Mint', $print, $lang, now())
     ON CONFLICT (product_id, condition, printing, language, grader, grade) DO UPDATE
       SET last_synced_at = now()
     RETURNING id`,
    { bind: { pid: productId, print: printing, lang: language }, type: QueryTypes.SELECT },
  );
  return rows[0].id;
}

async function insertObservation(variantId: string, on: string, priceCents: number, raw: TcgCsvPrice): Promise<boolean> {
  const [res] = await sequelize.query<{ id: string }>(
    `INSERT INTO price_observations
       (variant_id, source_key, observed_on, price_cents,
        min_30d_cents, max_30d_cents, is_backfill, raw_payload)
     VALUES ($vid, 'tcgcsv', $on, $price, $min, $max, false, $raw::jsonb)
     ON CONFLICT (variant_id, source_key, observed_on) DO NOTHING
     RETURNING id`,
    {
      bind: {
        vid: variantId, on, price: priceCents,
        // low/high are current listing extremes, kept as a rough range only.
        min: toCents(raw.lowPrice), max: toCents(raw.highPrice),
        raw: JSON.stringify(raw),
      },
      type: QueryTypes.SELECT,
    },
  );
  return Boolean(res);
}

export async function syncTcgCsv(opts: { game: string; groupId?: number; maxGroups?: number } = { game: 'pokemon' }): Promise<{ groups: number; products: number; variants: number; observations: number }> {
  const game = opts.game;
  const categoryId = GAME_TO_CATEGORY[game];
  if (!categoryId) throw new Error(`No tcgcsv category mapping for game '${game}'.`);

  const catRow = await sequelize.query<{ id: number }>(
    `SELECT id FROM categories WHERE justtcg_game = $game`,
    { bind: { game }, type: QueryTypes.SELECT },
  );
  if (!catRow.length) throw new Error(`No category row for game '${game}'.`);
  const ourCategoryId = catRow[0].id;
  const language = game === 'pokemon-japan' ? 'Japanese' : 'English';

  await ensureSource();
  const src = new TcgCsvSource();

  let groups = await src.listGroups(categoryId);
  if (opts.groupId) {
    groups = groups.filter((g) => g.groupId === opts.groupId);
  } else {
    // Established sets only (skip future/preorder), most recently published first.
    const now = today();
    groups = groups
      .filter((g) => !g.publishedOn || g.publishedOn.slice(0, 10) <= now)
      .sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? ''))
      .slice(0, opts.maxGroups ?? 3);
  }

  const on = today();
  const stats = { groups: 0, products: 0, variants: 0, observations: 0 };

  for (const g of groups) {
    let products: TcgCsvProduct[];
    let prices: TcgCsvPrice[];
    try {
      [products, prices] = await Promise.all([
        src.fetchProducts(categoryId, g.groupId),
        src.fetchPrices(categoryId, g.groupId),
      ]);
    } catch (err) {
      console.warn(`[sync-tcgcsv] group ${g.groupId} (${g.name}) failed:`, (err as Error).message);
      continue;
    }

    const slug = nameSlug(g.name);
    const code = (g.abbreviation && g.abbreviation.trim()) || slug;
    const setId = await upsertSet(ourCategoryId, slug, code, g.name, g.publishedOn ? g.publishedOn.slice(0, 10) : null);
    stats.groups += 1;

    // Group price rows by product so we only upsert products that have a price.
    const pricesByProduct = new Map<number, TcgCsvPrice[]>();
    for (const pr of prices) {
      const list = pricesByProduct.get(pr.productId) ?? [];
      list.push(pr);
      pricesByProduct.set(pr.productId, list);
    }
    const productById = new Map(products.map((p) => [p.productId, p]));

    for (const [productId, rows] of pricesByProduct) {
      const product = productById.get(productId);
      if (!product) continue;
      const productDbId = await upsertProduct(ourCategoryId, setId, product);
      stats.products += 1;

      for (const pr of rows) {
        const cents = toCents(pr.marketPrice ?? pr.midPrice ?? pr.lowPrice);
        if (cents == null) continue;   // Rule Zero: no price, no observation.
        const variantId = await upsertVariant(productDbId, pr.subTypeName || 'Normal', language);
        stats.variants += 1;
        if (await insertObservation(variantId, on, cents, pr)) stats.observations += 1;
      }
    }
  }

  return stats;
}

const isMain = process.argv[1]?.endsWith('sync-tcgcsv.ts') || process.argv[1]?.endsWith('sync-tcgcsv.js');
if (isMain) {
  const game = process.argv[2] || 'pokemon';
  const maxGroups = process.argv[3] ? Number(process.argv[3]) : 3;
  syncTcgCsv({ game, maxGroups })
    .then((s) => { console.log('[sync-tcgcsv] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[sync-tcgcsv] failed', err); process.exit(1); });
}
