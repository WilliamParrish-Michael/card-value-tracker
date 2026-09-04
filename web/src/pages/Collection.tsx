import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtCents, fmtPct, type HoldingRow } from '../lib/api';

function variantLabel(row: HoldingRow): string {
  if (row.grader && row.grade) return `${row.grader} ${row.grade}`;
  const parts = [row.condition, row.printing].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

function pctClass(v: string | null): string {
  if (v == null) return '';
  const n = Number(v);
  if (Number.isNaN(n)) return '';
  return n > 0 ? 'pos' : n < 0 ? 'neg' : '';
}

export default function Collection() {
  const [rows, setRows] = useState<HoldingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.collection();
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load collection');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let market = 0;
    let paid = 0;
    let unpricedCount = 0;
    for (const r of rows) {
      if (r.market_cents != null) market += r.market_cents * r.quantity;
      else unpricedCount += 1;
      if (r.acquired_cents != null) paid += r.acquired_cents * r.quantity;
    }
    return { market, paid, pnl: market - paid, unpricedCount };
  }, [rows]);

  const onDelete = useCallback(async (id: string) => {
    try {
      await api.deleteHolding(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete holding');
    }
  }, [load]);

  const onQuantity = useCallback(async (id: string, raw: string) => {
    const q = Math.trunc(Number(raw));
    if (!Number.isFinite(q) || q < 1) return;
    const prev = rows.find((r) => r.id === id);
    if (prev && prev.quantity === q) return;
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, quantity: q } : r)));
    try {
      await api.patchHolding(id, { quantity: q });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update quantity');
      await load();
    }
  }, [rows, load]);

  if (loading) return <div className="panel">Loading…</div>;
  if (error) return <div className="banner error">{error}</div>;

  return (
    <div className="panel">
      <h1>Collection</h1>

      <div className="row">
        <div className="grow">
          <span>Total market: </span>
          <strong className="num">{fmtCents(totals.market)}</strong>
          <span className="muted"> · Paid: </span>
          <span className="num">{fmtCents(totals.paid)}</span>
          <span className="muted"> · P&amp;L: </span>
          <strong className={`num ${totals.pnl > 0 ? 'pos' : totals.pnl < 0 ? 'neg' : ''}`}>
            {fmtCents(totals.pnl)}
          </strong>
          {totals.unpricedCount > 0 && (
            <div className="muted">
              {totals.unpricedCount} unpriced row{totals.unpricedCount === 1 ? '' : 's'} excluded from totals
            </div>
          )}
        </div>
        <a className="button secondary" href={api.collectionCsvUrl}>Export CSV</a>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>Your collection is empty</strong>
          Add cards from the Search tab to start tracking value.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Qty</th>
                <th>Paid</th>
                <th>Market</th>
                <th>Cash</th>
                <th>Credit</th>
                <th>7d</th>
                <th>30d</th>
                <th>Flags</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const lowConf = r.confidence != null && Number(r.confidence) <= 0.34;
                return (
                  <tr key={r.id}>
                    <td>
                      <div>{r.name}</div>
                      <div className="muted">{r.set_code} · #{r.collector_number}</div>
                      <div className="muted">{variantLabel(r)}</div>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        defaultValue={r.quantity}
                        style={{ width: '4rem' }}
                        onBlur={(e) => void onQuantity(r.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </td>
                    <td className="num">{fmtCents(r.acquired_cents)}</td>
                    <td className="num">{fmtCents(r.market_cents)}</td>
                    <td className="num">
                      {fmtCents(r.cash_offer_cents)}
                      {r.cash_rate_pct != null && (
                        <span className="muted"> ({r.cash_rate_pct}%)</span>
                      )}
                    </td>
                    <td className="num">
                      {fmtCents(r.credit_offer_cents)}
                      {r.credit_rate_pct != null && (
                        <span className="muted"> ({r.credit_rate_pct}%)</span>
                      )}
                    </td>
                    <td className={pctClass(r.change_7d_pct)}>{fmtPct(r.change_7d_pct)}</td>
                    <td className={pctClass(r.change_30d_pct)}>{fmtPct(r.change_30d_pct)}</td>
                    <td>
                      {r.unpriced && <span className="pill bad">unpriced</span>}
                      {lowConf && <span className="pill warn">low confidence</span>}
                    </td>
                    <td>
                      <button className="ghost" onClick={() => void onDelete(r.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
