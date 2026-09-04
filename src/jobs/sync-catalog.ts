/**
 * Milestone 1 — catalog sync. Pulls games -> sets -> cards -> variants from
 * JustTCG into our tables. No prices here; that's sync-prices. No invented data;
 * if the source returns nothing, nothing is written.
 *
 * Idempotent by design (done-when: a second run adds zero rows, zero dupes):
 *   - variants upsert on justtcg_uuid (the authoritative content-addressed key)
 *   - products upsert on the natural key (set_id, collector_number, name_slug, rarity)
 *   - sets upsert on (category_id, slug)
 *
 * Set codes: JustTCG's /sets carries no code, but a single's collector number
 * does ('OP13-118' -> 'OP13'). We vote the most common prefix per set and stamp
 * it as set_code; sets with no coded numbers (some MTG) keep the slug as code.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../models/index.js';
import { buildRegistry } from '../sources/registry.js';
import type { JustTCGSource } from '../sources/adapter.js';
import type { SourceCard, SourceQuote } from '../sources/adapter.js';

const nameSlug = (name: string): string =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// JustTCG carries sealed product too (condition 'Sealed', collector number 'N/A'),
// so it's our sealed source — no paid PriceCharting subscription required. Classify
// the format from the product name for the trade balancer's pack-equivalence; leave
// it NULL (skip sealed_config) rather than guessing when nothing matches.
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
function classifyFormat(name: string, game: string): string | null {
  const list = game.includes('one-piece') ? ONE_PIECE_FORMATS : POKEMON_FORMATS;
  const hay = name.toLowerCase();
  const hits = list.filter((f) => hay.includes(f.toLowerCase())).sort((a, b) => b.length - a.length);
  return hits[0] ?? null;
}
async function upsertSealedConfig(productId: string, format: string, releasedOn: string | null): Promise<void> {
  await sequelize.query(
    `INSERT INTO sealed_config (product_id, format, released_on)
     VALUES ($pid, $fmt, $rel)
     ON CONFLICT (product_id) DO UPDATE SET format = EXCLUDED.format,
       released_on = COALESCE(sealed_config.released_on, EXCLUDED.released_on)`,
    { bind: { pid: productId, fmt: format, rel: releasedOn } },
  );
}

/** 'OP13-118' -> 'OP13'; 'PRB02-005' -> 'PRB02'; '125/197' or '042' -> null. */
const deriveSetCode = (collectorNumber?: string): string | null => {
  if (!collectorNumber) return null;
  const m = collectorNumber.match(/^([A-Za-z]+\d+|[A-Za-z]{2,})-/);
  return m ? m[1].toUpperCase() : null;
};

async function upsertSet(categoryId: number, slug: string, name: string, releasedOn: string | null): Promise<string> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO sets (category_id, set_code, slug, name, released_on)
     VALUES ($cat, $code, $slug, $name, $rel)
     ON CONFLICT (category_id, slug) DO UPDATE
       SET name = EXCLUDED.name, released_on = EXCLUDED.released_on
     RETURNING id`,
    // set_code starts as the slug (guaranteed unique + non-null); a real code is
    // stamped in after we've seen the set's cards.
    { bind: { cat: categoryId, code: slug, slug, name, rel: releasedOn }, type: QueryTypes.SELECT },
  );
  return rows[0].id;
}

async function upsertProduct(categoryId: number, setId: string, card: SourceCard): Promise<string> {
  const isSealed = !card.collectorNumber || card.collectorNumber === 'N/A';
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO products
       (category_id, set_id, kind, collector_number, name, name_slug, rarity, image_url, updated_at)
     VALUES ($cat, $set, $kind, $num, $name, $slug, $rarity, NULL, now())
     ON CONFLICT (set_id, collector_number, name_slug, rarity) DO UPDATE
       SET name = EXCLUDED.name, kind = EXCLUDED.kind, updated_at = now()
     RETURNING id`,
    {
      bind: {
        cat: categoryId, set: setId, kind: isSealed ? 'sealed' : 'single',
        num: card.collectorNumber || 'N/A', name: card.name, slug: nameSlug(card.name),
        // rarity is part of the natural key; store '' rather than NULL so the
        // ON CONFLICT target matches (Postgres treats NULL as distinct here).
        rarity: card.rarity ?? '',
      },
      type: QueryTypes.SELECT,
    },
  );
  return rows[0].id;
}

async function upsertVariant(productId: string, q: SourceQuote): Promise<void> {
  await sequelize.query(
    `INSERT INTO variants
       (product_id, condition, printing, language, grader, grade,
        justtcg_uuid, justtcg_slug, tcgplayer_sku_id, last_synced_at)
     VALUES ($pid, $cond, $print, $lang, $grader, $grade, $uuid, $slug, $sku, now())
     ON CONFLICT (justtcg_uuid) DO UPDATE
       SET product_id = EXCLUDED.product_id, condition = EXCLUDED.condition,
           printing = EXCLUDED.printing, language = EXCLUDED.language,
           grader = EXCLUDED.grader, grade = EXCLUDED.grade,
           justtcg_slug = EXCLUDED.justtcg_slug,
           tcgplayer_sku_id = EXCLUDED.tcgplayer_sku_id,
           last_synced_at = now()`,
    {
      bind: {
        pid: productId, cond: q.variant.condition ?? null, print: q.variant.printing ?? null,
        lang: q.variant.language || 'English', grader: q.variant.grader ?? null,
        grade: q.variant.grade ?? null, uuid: q.externalUuid ?? null,
        slug: q.externalSlug ?? null, sku: q.tcgplayerSkuId ?? null,
      },
    },
  );
}

async function stampSetCode(setId: string, categoryId: number, code: string): Promise<void> {
  // Only replace the slug-placeholder, and only if the real code is still free
  // within the game. A collision (two sets voting the same code) leaves the slug.
  try {
    await sequelize.query(
      `UPDATE sets SET set_code = $code
        WHERE id = $id AND set_code = slug
          AND NOT EXISTS (SELECT 1 FROM sets WHERE category_id = $cat AND set_code = $code)`,
      { bind: { code, id: setId, cat: categoryId } },
    );
  } catch (err) {
    console.warn(`[sync-catalog] set_code '${code}' not applied to set ${setId}:`, (err as Error).message);
  }
}

export async function syncCatalog(opts: { games?: string[]; maxPages?: number } = {}): Promise<{ games: number; sets: number; products: number; variants: number }> {
  const registry = buildRegistry();
  const src = registry.get('justtcg') as JustTCGSource | undefined;
  if (!src) {
    // Rule Zero: no source, no data — say so, write nothing.
    throw new Error('No catalog source configured — set JUSTTCG_API_KEY.');
  }

  // Optional game filter (by justtcg_game slug) — the free tier is 100 req/day,
  // so a demo run can target one game, e.g. `sync-catalog one-piece-card-game`.
  const filter = opts.games && opts.games.length ? opts.games : null;
  const categories = (await sequelize.query<{ id: number; justtcg_game: string }>(
    `SELECT id, justtcg_game FROM categories WHERE justtcg_game IS NOT NULL ORDER BY id`,
    { type: QueryTypes.SELECT },
  )).filter((c) => !filter || filter.includes(c.justtcg_game));

  const stats = { games: 0, sets: 0, products: 0, variants: 0 };
  const seenProducts = new Set<string>();
  const seenVariants = new Set<string>();

  for (const cat of categories) {
    const game = cat.justtcg_game;
    let setMeta: Map<string, { name: string; releasedOn: string | null }>;
    try {
      const list = await src.listSets(game);
      setMeta = new Map(list.map((s) => [s.slug, { name: s.name, releasedOn: s.releasedOn ?? null }]));
    } catch (err) {
      console.warn(`[sync-catalog] listSets failed for ${game}:`, (err as Error).message);
      continue;
    }
    stats.games += 1;

    const setIdCache = new Map<string, string>();
    const codeVotes = new Map<string, Map<string, number>>();

    for await (const page of src.pages(game, opts.maxPages)) {
      for (const card of page) {
        const slug = card.setSlug;
        if (!slug) continue;

        let setId = setIdCache.get(slug);
        if (!setId) {
          const meta = setMeta.get(slug) ?? { name: card.setName || slug, releasedOn: null };
          setId = await upsertSet(cat.id, slug, meta.name, meta.releasedOn);
          setIdCache.set(slug, setId);
          stats.sets += 1;
        }

        const productId = await upsertProduct(cat.id, setId, card);
        if (!seenProducts.has(productId)) { seenProducts.add(productId); stats.products += 1; }

        // Sealed product (collector number 'N/A'): classify its format for the
        // trade balancer. Skip (leave sealed_config absent) when nothing matches.
        if (!card.collectorNumber || card.collectorNumber === 'N/A') {
          const fmt = classifyFormat(card.name, game);
          if (fmt) await upsertSealedConfig(productId, fmt, setMeta.get(slug)?.releasedOn ?? null);
        }

        for (const q of card.quotes) {
          await upsertVariant(productId, q);
          const vk = q.externalUuid ?? `${productId}:${q.variant.condition}:${q.variant.printing}`;
          if (!seenVariants.has(vk)) { seenVariants.add(vk); stats.variants += 1; }
        }

        const code = deriveSetCode(card.collectorNumber);
        if (code) {
          const votes = codeVotes.get(slug) ?? new Map<string, number>();
          votes.set(code, (votes.get(code) ?? 0) + 1);
          codeVotes.set(slug, votes);
        }
      }
    }

    // Stamp the winning code per set.
    for (const [slug, votes] of codeVotes) {
      const setId = setIdCache.get(slug);
      if (!setId) continue;
      const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
      if (best) await stampSetCode(setId, cat.id, best[0]);
    }
  }

  return stats;
}

// Allow `tsx src/jobs/sync-catalog.ts` to run it directly.
const isMain = process.argv[1]?.endsWith('sync-catalog.ts') || process.argv[1]?.endsWith('sync-catalog.js');
if (isMain) {
  const games = process.argv.slice(2).filter(Boolean);
  syncCatalog(games.length ? { games } : {})
    .then((s) => { console.log('[sync-catalog] done', s); return sequelize.close(); })
    .catch((err) => { console.error('[sync-catalog] failed', err); process.exit(1); });
}
