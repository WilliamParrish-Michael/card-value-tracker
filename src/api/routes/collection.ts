/**
 * Collection: holdings with market value, cash + credit trade offers, blended
 * rate, and 7/30-day movement — plus CSV export (what makes it useful at a table).
 *
 * Offers come from trade_rules (active bands: effective_to IS NULL), applied to
 * the market value. A holding whose variant has no valuation shows market/offers
 * as null — an honest "unpriced", never a fabricated number.
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';

interface Band {
  currency: 'cash' | 'credit';
  category_id: number | null;
  kind: 'single' | 'sealed' | null;
  min_cents: number;
  max_cents: number | null;
  rate_pct: string;
  floor_cents: number;
  ceiling_cents: number | null;
}

async function loadBands(): Promise<Band[]> {
  return sequelize.query<Band>(
    `SELECT currency, category_id, kind, min_cents, max_cents, rate_pct, floor_cents, ceiling_cents
       FROM trade_rules
      WHERE effective_to IS NULL
      ORDER BY currency, min_cents`,
    { type: QueryTypes.SELECT },
  );
}

/** Most specific matching band wins: category+kind beat the NULL wildcards. */
function pickBand(bands: Band[], currency: 'cash' | 'credit', marketCents: number, categoryId: number, kind: string): Band | null {
  const matches = bands.filter(
    (b) => b.currency === currency
      && marketCents >= b.min_cents
      && (b.max_cents === null || marketCents < b.max_cents)
      && (b.category_id === null || b.category_id === categoryId)
      && (b.kind === null || b.kind === kind),
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (Number(b.category_id !== null) + Number(b.kind !== null)) - (Number(a.category_id !== null) + Number(a.kind !== null)));
  return matches[0];
}

function offer(bands: Band[], currency: 'cash' | 'credit', marketCents: number, categoryId: number, kind: string) {
  const band = pickBand(bands, currency, marketCents, categoryId, kind);
  if (!band) return null;
  let cents = Math.round(marketCents * (Number(band.rate_pct) / 100));
  cents = Math.max(cents, band.floor_cents);
  if (band.ceiling_cents !== null) cents = Math.min(cents, band.ceiling_cents);
  return { offerCents: cents, effectiveRatePct: Math.round((cents / marketCents) * 10000) / 100 };
}

interface HoldingRow {
  id: string; quantity: number; acquired_cents: number | null; acquired_on: string | null; notes: string | null;
  variant_id: string; condition: string | null; printing: string | null; language: string | null;
  grader: string | null; grade: string | null; name: string; collector_number: string; rarity: string | null;
  category_id: number; kind: string; game: string; set_code: string;
  market_cents: number | null; change_7d_pct: string | null; change_30d_pct: string | null; confidence: string | null;
}

async function loadHoldings(): Promise<HoldingRow[]> {
  return sequelize.query<HoldingRow>(
    `SELECT h.id::text, h.quantity, h.acquired_cents, h.acquired_on::text, h.notes,
            v.id::text AS variant_id, v.condition, v.printing, v.language, v.grader, v.grade::text,
            p.name, p.collector_number, p.rarity, p.category_id, p.kind,
            c.slug AS game, s.set_code,
            dv.market_cents, dv.change_7d_pct::text, dv.change_30d_pct::text, dv.confidence::text
       FROM holdings h
       JOIN variants v   ON v.id = h.variant_id
       JOIN products p   ON p.id = v.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN sets s       ON s.id = p.set_id
       LEFT JOIN LATERAL (
         SELECT market_cents, change_7d_pct, change_30d_pct, confidence
           FROM daily_valuations dv WHERE dv.variant_id = v.id
          ORDER BY valued_on DESC LIMIT 1
       ) dv ON true
      ORDER BY p.name, v.condition`,
    { type: QueryTypes.SELECT },
  );
}

function decorate(rows: HoldingRow[], bands: Band[]) {
  return rows.map((h) => {
    const m = h.market_cents;
    const cash = m != null ? offer(bands, 'cash', m, h.category_id, h.kind) : null;
    const credit = m != null ? offer(bands, 'credit', m, h.category_id, h.kind) : null;
    return {
      ...h,
      market_cents: m,
      cash_offer_cents: cash?.offerCents ?? null,
      cash_rate_pct: cash?.effectiveRatePct ?? null,
      credit_offer_cents: credit?.offerCents ?? null,
      credit_rate_pct: credit?.effectiveRatePct ?? null,
      unpriced: m == null,
    };
  });
}

export function collectionRouter(): Router {
  const r = Router();

  r.get('/', async (_req, res) => {
    try {
      const [rows, bands] = await Promise.all([loadHoldings(), loadBands()]);
      res.json({ data: decorate(rows, bands) });
    } catch (err) { res.status(500).json({ error: (err as Error).message, data: [] }); }
  });

  r.post('/', async (req, res) => {
    const b = req.body ?? {};
    if (!b.variant_id) return res.status(400).json({ error: 'variant_id is required' });
    try {
      const exists = await sequelize.query(`SELECT 1 FROM variants WHERE id = $id`, { bind: { id: b.variant_id }, type: QueryTypes.SELECT });
      if (!exists.length) return res.status(404).json({ error: 'variant not found' });
      const [row] = await sequelize.query<{ id: string }>(
        `INSERT INTO holdings (variant_id, quantity, acquired_cents, acquired_on, notes)
         VALUES ($vid, $qty, $ac, $on, $notes) RETURNING id::text`,
        {
          bind: {
            vid: b.variant_id, qty: Number(b.quantity) > 0 ? Number(b.quantity) : 1,
            ac: b.acquired_cents == null ? null : Number(b.acquired_cents),
            on: b.acquired_on || null, notes: b.notes || null,
          },
          type: QueryTypes.SELECT,
        },
      );
      res.status(201).json({ data: { id: row.id } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  r.patch('/:id', async (req, res) => {
    const b = req.body ?? {};
    try {
      await sequelize.query(
        `UPDATE holdings SET
           quantity = COALESCE($qty, quantity),
           acquired_cents = COALESCE($ac, acquired_cents),
           acquired_on = COALESCE($on, acquired_on),
           notes = COALESCE($notes, notes)
         WHERE id = $id`,
        {
          bind: {
            id: req.params.id,
            qty: b.quantity == null ? null : Number(b.quantity),
            ac: b.acquired_cents == null ? null : Number(b.acquired_cents),
            on: b.acquired_on ?? null, notes: b.notes ?? null,
          },
        },
      );
      res.json({ data: { id: req.params.id } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  r.delete('/:id', async (req, res) => {
    try {
      await sequelize.query(`DELETE FROM holdings WHERE id = $id`, { bind: { id: req.params.id } });
      res.json({ data: { id: req.params.id } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // CSV export — the thing that makes the collection useful away from the app.
  r.get('/export.csv', async (_req, res) => {
    try {
      const [rows, bands] = await Promise.all([loadHoldings(), loadBands()]);
      const data = decorate(rows, bands);
      const cols = [
        'game', 'set_code', 'collector_number', 'name', 'rarity', 'condition', 'printing',
        'language', 'grader', 'grade', 'quantity', 'acquired_cents', 'market_cents',
        'cash_offer_cents', 'credit_offer_cents', 'change_7d_pct', 'change_30d_pct', 'confidence', 'notes',
      ];
      const esc = (v: unknown) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [cols.join(','), ...data.map((row) => cols.map((c) => esc((row as Record<string, unknown>)[c])).join(','))].join('\n');
      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', 'attachment; filename="collection.csv"');
      res.send(csv);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return r;
}
