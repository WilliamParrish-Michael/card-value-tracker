/**
 * Trade-rule bands, editable from Settings and VERSIONED — editing a band never
 * mutates history. An edit closes the current row (effective_to = today) and
 * inserts a new active row (effective_from = today, effective_to NULL), so a past
 * offer stays explainable by the band that was live when it was made.
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';

export function tradeRulesRouter(): Router {
  const r = Router();

  // Active bands only (effective_to IS NULL).
  r.get('/', async (_req, res) => {
    try {
      const rows = await sequelize.query(
        `SELECT id, category_id, kind, currency, min_cents, max_cents, rate_pct::text,
                floor_cents, ceiling_cents, max_cov_7d::text, volatility_penalty_pct::text,
                effective_from::text, notes
           FROM trade_rules WHERE effective_to IS NULL
          ORDER BY currency, min_cents`,
        { type: QueryTypes.SELECT },
      );
      res.json({ data: rows });
    } catch (err) { res.status(500).json({ error: (err as Error).message, data: [] }); }
  });

  // Versioned edit: close the old row today, insert a new active row carrying the
  // edited fields (and the old values for anything not sent).
  r.put('/:id', async (req, res) => {
    const b = req.body ?? {};
    try {
      const [current] = await sequelize.query<Record<string, unknown>>(
        `SELECT * FROM trade_rules WHERE id = $id AND effective_to IS NULL`,
        { bind: { id: req.params.id }, type: QueryTypes.SELECT },
      );
      if (!current) return res.status(404).json({ error: 'active rule not found' });

      const merged = {
        category_id: b.category_id ?? current.category_id,
        kind: b.kind ?? current.kind,
        currency: b.currency ?? current.currency,
        min_cents: b.min_cents ?? current.min_cents,
        max_cents: b.max_cents === undefined ? current.max_cents : b.max_cents,
        rate_pct: b.rate_pct ?? current.rate_pct,
        floor_cents: b.floor_cents ?? current.floor_cents,
        ceiling_cents: b.ceiling_cents === undefined ? current.ceiling_cents : b.ceiling_cents,
        max_cov_7d: b.max_cov_7d === undefined ? current.max_cov_7d : b.max_cov_7d,
        volatility_penalty_pct: b.volatility_penalty_pct ?? current.volatility_penalty_pct,
        notes: b.notes === undefined ? current.notes : b.notes,
      };

      await sequelize.transaction(async (t) => {
        await sequelize.query(
          `UPDATE trade_rules SET effective_to = CURRENT_DATE WHERE id = $id`,
          { bind: { id: req.params.id }, transaction: t },
        );
        await sequelize.query(
          `INSERT INTO trade_rules
             (category_id, kind, currency, min_cents, max_cents, rate_pct, floor_cents,
              ceiling_cents, max_cov_7d, volatility_penalty_pct, effective_from, notes)
           VALUES ($category_id, $kind, $currency, $min_cents, $max_cents, $rate_pct, $floor_cents,
                   $ceiling_cents, $max_cov_7d, $volatility_penalty_pct, CURRENT_DATE, $notes)`,
          { bind: merged as Record<string, unknown>, transaction: t },
        );
      });

      res.json({ data: { ok: true } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return r;
}
