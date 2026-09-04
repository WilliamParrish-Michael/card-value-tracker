/**
 * Trade balancer API (section 7) + sourcing-friction management.
 *
 * POST /api/trades/balance  -> closest whole quantity + brackets + per-line market
 *   and friction-adjusted values + liquidity lean + staleness warnings, persisted
 *   to trade_sessions/trade_lines with the full computation frozen in result_json
 *   (a trade agreed today stays explainable next month).
 * GET  /api/trades/:id      -> a saved session's frozen result.
 * GET/PUT /api/trades/friction/:productId -> operator friction (overrides auto).
 */
import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models/index.js';
import { balanceTrade, type LoadedLine } from '../../valuation/balance.js';

const STALE_HOURS = 48;
const NEW_SET_DAYS = 30;

interface LineReq { variantId: string | number; quantity?: number }

async function loadLine(side: 1 | 2, req: LineReq): Promise<LoadedLine> {
  const [row] = await sequelize.query<{
    variant_id: string; name: string; collector_number: string; kind: string; set_code: string;
    condition: string | null; printing: string | null; grader: string | null; grade: string | null;
    market_cents: number | null; format: string | null; packs_included: number | null;
    premium_pct: string | null; released_on: string | null; latest_obs: string | null;
  }>(
    `SELECT v.id::text AS variant_id, p.name, p.collector_number, p.kind, s.set_code,
            v.condition, v.printing, v.grader, v.grade::text,
            dv.market_cents, sc.format, sc.packs_included,
            sf.premium_pct::text,
            COALESCE(sc.released_on, s.released_on)::text AS released_on,
            (SELECT max(observed_on)::text FROM price_observations po
              WHERE po.variant_id = v.id AND po.is_backfill = false) AS latest_obs
       FROM variants v
       JOIN products p ON p.id = v.product_id
       JOIN sets s ON s.id = p.set_id
       LEFT JOIN sealed_config sc ON sc.product_id = p.id
       LEFT JOIN sourcing_friction sf ON sf.product_id = p.id
       LEFT JOIN LATERAL (SELECT market_cents FROM daily_valuations dv
                          WHERE dv.variant_id = v.id ORDER BY valued_on DESC LIMIT 1) dv ON true
      WHERE v.id = $id`,
    { bind: { id: String(req.variantId) }, type: QueryTypes.SELECT },
  );
  if (!row) throw new Error(`variant ${req.variantId} not found`);

  const gradeLabel = row.grader ? `${row.grader} ${row.grade}` : (row.format ?? [row.condition, row.printing].filter(Boolean).join(' · '));
  const label = `${row.name}${gradeLabel ? ` (${gradeLabel})` : ''}`;

  const staleReasons: string[] = [];
  if (!row.latest_obs) staleReasons.push('no live price yet');
  else if ((Date.now() - Date.parse(row.latest_obs)) / 3_600_000 > STALE_HOURS) staleReasons.push('last price over 48h old');
  if (row.released_on && (Date.now() - Date.parse(row.released_on)) / 86_400_000 < NEW_SET_DAYS) {
    staleReasons.push('released in the last 30 days — no settled price');
  }

  return {
    side,
    variantId: row.variant_id,
    quantity: req.quantity == null ? null : Number(req.quantity),
    unitMarketCents: row.market_cents ?? null,
    frictionPct: row.premium_pct == null ? 0 : Number(row.premium_pct),
    label,
    format: row.format,
    packsIncluded: row.packs_included ?? null,
    stale: staleReasons.length > 0,
    staleReasons,
  };
}

export function tradesRouter(): Router {
  const r = Router();

  r.post('/balance', async (req, res) => {
    const body = req.body ?? {};
    const sideA: LineReq[] = Array.isArray(body.sideA) ? body.sideA : [];
    const sideB: LineReq[] = Array.isArray(body.sideB) ? body.sideB : [];
    const applyFriction = body.applyFriction !== false; // default true
    if (!sideA.length || !sideB.length) {
      return res.status(400).json({ error: 'Both sideA and sideB must have at least one line.' });
    }
    const unknowns = [...sideA, ...sideB].filter((l) => l.quantity == null).length;
    if (unknowns !== 1) {
      return res.status(400).json({ error: 'Exactly one line (across both sides) must omit quantity — that is the unknown being solved.' });
    }

    try {
      const lines: LoadedLine[] = [
        ...(await Promise.all(sideA.map((l) => loadLine(1, l)))),
        ...(await Promise.all(sideB.map((l) => loadLine(2, l)))),
      ];
      const result = balanceTrade(lines, applyFriction);

      // Persist a frozen snapshot.
      const [session] = await sequelize.query<{ id: string }>(
        `INSERT INTO trade_sessions (label, result_json) VALUES ($label, $json::jsonb) RETURNING id::text`,
        { bind: { label: body.label ?? null, json: JSON.stringify(result) }, type: QueryTypes.SELECT },
      );
      for (const l of result.lines) {
        if (l.unitMarketCents == null) continue; // don't persist a fake unit price
        await sequelize.query(
          `INSERT INTO trade_lines (session_id, side, variant_id, quantity, unit_cents, friction_pct)
           VALUES ($sid, $side, $vid, $qty, $unit, $fric)`,
          { bind: { sid: session.id, side: l.side, vid: l.variantId, qty: l.quantity, unit: l.unitMarketCents, fric: l.frictionPct } },
        );
      }

      res.json({ data: { sessionId: session.id, ...result } });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.get('/:id', async (req, res) => {
    try {
      const [row] = await sequelize.query<{ id: string; label: string | null; valued_on: string; result_json: unknown }>(
        `SELECT id::text, label, valued_on::text, result_json FROM trade_sessions WHERE id = $id`,
        { bind: { id: req.params.id }, type: QueryTypes.SELECT },
      );
      if (!row) return res.status(404).json({ error: 'trade session not found' });
      res.json({ data: row });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  r.get('/friction/:productId', async (req, res) => {
    try {
      const [row] = await sequelize.query(
        `SELECT product_id::text, manual_score, purchase_limit, is_allocated, notes,
                auto_score, auto_inputs, auto_computed_at, premium_pct::text
           FROM sourcing_friction WHERE product_id = $id`,
        { bind: { id: req.params.productId }, type: QueryTypes.SELECT },
      );
      res.json({ data: row ?? null });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  // Operator friction — always wins over auto_score. Never touches market value.
  r.put('/friction/:productId', async (req, res) => {
    const b = req.body ?? {};
    try {
      await sequelize.query(
        `INSERT INTO sourcing_friction (product_id, manual_score, purchase_limit, is_allocated, notes, premium_pct)
         VALUES ($pid, $ms, $pl, $alloc, $notes, $prem)
         ON CONFLICT (product_id) DO UPDATE
           SET manual_score = COALESCE($ms, sourcing_friction.manual_score),
               purchase_limit = COALESCE($pl, sourcing_friction.purchase_limit),
               is_allocated = COALESCE($alloc, sourcing_friction.is_allocated),
               notes = COALESCE($notes, sourcing_friction.notes),
               premium_pct = COALESCE($prem, sourcing_friction.premium_pct)`,
        {
          bind: {
            pid: req.params.productId,
            ms: b.manual_score == null ? null : Number(b.manual_score),
            pl: b.purchase_limit == null ? null : Number(b.purchase_limit),
            alloc: b.is_allocated == null ? null : Boolean(b.is_allocated),
            notes: b.notes ?? null,
            prem: b.premium_pct == null ? null : Number(b.premium_pct),
          },
        },
      );
      res.json({ data: { product_id: req.params.productId } });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return r;
}
