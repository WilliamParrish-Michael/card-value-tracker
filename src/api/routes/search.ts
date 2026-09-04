/**
 * GET /api/search?q=&game=
 *
 * Postgres full-text over product names, PLUS a substring match on
 * collector_number and set_code so "OP09-093" and "OP09" both return hits.
 * Returns products with their set/game and, when available, the current market
 * value of the base (Near Mint / Normal) variant — null when we have no
 * valuation for it (never a guess).
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';

export function searchRouter(): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const game = req.query.game ? String(req.query.game) : null;
    // Optional product-kind filter: 'single' (cards) or 'sealed' (unopened).
    const kindRaw = req.query.kind ? String(req.query.kind) : null;
    const kind = kindRaw === 'single' || kindRaw === 'sealed' ? kindRaw : null;
    // An empty query browses the catalog (most valuable priced items first)
    // rather than showing a dead-end blank page.
    const browse = q === '';

    try {
      const rows = await sequelize.query(
        `SELECT p.id::text AS product_id,
                c.slug        AS game,
                s.set_code,
                p.collector_number,
                p.name,
                p.rarity,
                p.kind,
                p.image_url,
                dv.market_cents,        -- representative variant market, or NULL
                dv.confidence
           FROM products p
           JOIN sets s        ON s.id = p.set_id
           JOIN categories c  ON c.id = p.category_id
           LEFT JOIN LATERAL (
             -- Representative value for the list row: prefer the Near Mint /
             -- Normal variant, but fall back to the best available printing
             -- (many One Piece / MTG singles are Foil-only, so a hard Normal
             -- filter would blank their price in the list). Only variants that
             -- actually have a valuation are considered.
             SELECT dv.market_cents, dv.confidence
               FROM variants v
               JOIN daily_valuations dv ON dv.variant_id = v.id
              WHERE v.product_id = p.id
              ORDER BY (coalesce(v.condition, 'Near Mint') = 'Near Mint') DESC,
                       (coalesce(v.printing, 'Normal') = 'Normal') DESC,
                       dv.valued_on DESC
              LIMIT 1
           ) dv ON true
          WHERE ($game::text IS NULL OR c.slug = $game)
            AND ($kind::text IS NULL OR p.kind = $kind::product_kind)
            AND (
              $browse
              -- Name match is substring (ILIKE) as well as full-text, so partial
              -- names like "luffy" hit "Monkey.D.Luffy" — plainto_tsquery alone
              -- won't split a dotted token.
              OR p.name ILIKE '%' || $q || '%'
              OR p.collector_number ILIKE '%' || $q || '%'
              OR s.set_code ILIKE '%' || $q || '%'
              OR to_tsvector('english', p.name) @@ plainto_tsquery('english', $q)
            )
          ORDER BY
            (NOT $browse AND p.collector_number ILIKE $q) DESC,  -- exact number first when searching
            ($browse AND dv.market_cents IS NOT NULL) DESC,      -- priced items first when browsing
            (CASE WHEN $browse THEN dv.market_cents END) DESC NULLS LAST,
            p.name
          LIMIT 50`,
        { bind: { q, game, browse, kind }, type: QueryTypes.SELECT },
      );
      res.json({ data: rows, query: q, browse, kind });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, data: [] });
    }
  });

  // A product's variants + each one's latest market value — powers the
  // "add this exact variant to my collection" flow. Missing valuations are null.
  r.get('/product/:id', async (req, res) => {
    try {
      const [product] = await sequelize.query(
        `SELECT p.id::text, p.name, p.collector_number, p.rarity, p.kind, p.image_url,
                c.slug AS game, s.set_code
           FROM products p JOIN sets s ON s.id = p.set_id JOIN categories c ON c.id = p.category_id
          WHERE p.id = $id`,
        { bind: { id: req.params.id }, type: QueryTypes.SELECT },
      );
      if (!product) return res.status(404).json({ error: 'product not found' });

      const variants = await sequelize.query(
        `SELECT v.id::text, v.condition, v.printing, v.language, v.grader, v.grade::text,
                dv.market_cents, dv.change_7d_pct::text, dv.confidence::text, dv.valued_on::text
           FROM variants v
           LEFT JOIN LATERAL (
             SELECT market_cents, change_7d_pct, confidence, valued_on
               FROM daily_valuations dv WHERE dv.variant_id = v.id
              ORDER BY valued_on DESC LIMIT 1
           ) dv ON true
          WHERE v.product_id = $id
          ORDER BY v.grader NULLS FIRST, v.grade, v.printing, v.condition`,
        { bind: { id: req.params.id }, type: QueryTypes.SELECT },
      );
      res.json({ data: { product, variants } });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
