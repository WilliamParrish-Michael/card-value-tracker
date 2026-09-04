/**
 * Trade balancer — build two sides of a trade, mark exactly one line as the
 * unknown to solve for, and get a whole-number quantity plus the dollar
 * remainder (the bracket) from the server.
 *
 * This screen refuses to look confident when the data isn't: stale valuations
 * and warnings are surfaced loudly, and the sourcing-friction premium is always
 * shown next to the raw market value — never hidden, never faked as $0.00.
 */

import { useState } from 'react';
import {
  api,
  tradesApi,
  fmtCents,
  fmtPct,
  GAMES,
  type SearchHit,
  type VariantRow,
  type BalanceResult,
  type BracketOption,
} from '../lib/api';

type SideId = 1 | 2;

interface TradeLine {
  key: string;
  productId: string;
  variantId: string;
  label: string;
  quantity: number;
  isUnknown: boolean;
}

let LINE_SEQ = 0;
const nextKey = (): string => `line-${++LINE_SEQ}`;

function variantDescriptor(v: VariantRow): string {
  if (v.grader && v.grade) return `${v.grader} ${v.grade}`;
  const parts = [v.condition, v.printing, v.language && v.language !== 'English' ? v.language : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Variant';
}

function lineLabel(name: string, v: VariantRow): string {
  return `${name} — ${variantDescriptor(v)}`;
}

const sideName = (side: SideId | 'even'): string =>
  side === 1 ? 'You' : side === 2 ? 'They' : 'even';

// --- Add-item widget for one side -------------------------------------------

interface AddPanelProps {
  onAdd: (productId: string, variant: VariantRow, name: string) => void;
}

interface PendingVariants {
  name: string;
  productId: string;
  variants: VariantRow[];
}

function AddPanel({ onAdd }: AddPanelProps) {
  const [q, setQ] = useState('');
  const [game, setGame] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingVariants | null>(null);
  const [pickLoading, setPickLoading] = useState<string | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    setError(null);
    setPending(null);
    try {
      setHits(await api.search(term, game || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  async function chooseHit(hit: SearchHit) {
    setError(null);
    setPickLoading(hit.product_id);
    try {
      const { product, variants } = await api.productVariants(hit.product_id);
      if (variants.length === 0) {
        setError('This product has no priced variants yet.');
        return;
      }
      if (variants.length === 1) {
        onAdd(product.id, variants[0], product.name);
        setPending(null);
        return;
      }
      setPending({ name: product.name, productId: product.id, variants });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load variants.');
    } finally {
      setPickLoading(null);
    }
  }

  function pickVariant(v: VariantRow) {
    if (!pending) return;
    onAdd(pending.productId, v, pending.name);
    setPending(null);
  }

  return (
    <div>
      <form onSubmit={runSearch} className="row">
        <input
          className="grow"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or collector number…"
          aria-label="Search for a card to add"
        />
        <select value={game} onChange={(e) => setGame(e.target.value)} aria-label="Game">
          {GAMES.map((g) => (
            <option key={g.slug} value={g.slug}>{g.label}</option>
          ))}
        </select>
        <button type="submit" className="button secondary" disabled={loading}>
          {loading ? 'Finding…' : 'Find'}
        </button>
      </form>

      {error && <div className="banner error">{error}</div>}

      {pending && (
        <div className="table-wrap">
          <div className="muted">Pick a variant of {pending.name}:</div>
          <table>
            <tbody>
              {pending.variants.map((v) => (
                <tr key={v.id}>
                  <td>{variantDescriptor(v)}</td>
                  <td className="num">{fmtCents(v.market_cents)}</td>
                  <td>
                    <button type="button" className="button" onClick={() => pickVariant(v)}>Add</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!pending && hits != null && hits.length === 0 && (
        <div className="muted">No matches.</div>
      )}

      {!pending && hits != null && hits.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {hits.map((h) => (
                <tr key={h.product_id}>
                  <td>
                    <div>{h.name}</div>
                    <div className="muted">{h.set_code} · #{h.collector_number}</div>
                  </td>
                  <td className="num">{fmtCents(h.market_cents)}</td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      onClick={() => chooseHit(h)}
                      disabled={pickLoading === h.product_id}
                    >
                      {pickLoading === h.product_id ? 'Adding…' : 'Add'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- One side panel ----------------------------------------------------------

interface SidePanelProps {
  title: string;
  lines: TradeLine[];
  onAdd: (productId: string, variant: VariantRow, name: string) => void;
  onQuantity: (key: string, quantity: number) => void;
  onMarkUnknown: (key: string) => void;
  onRemove: (key: string) => void;
}

function SidePanel({ title, lines, onAdd, onQuantity, onMarkUnknown, onRemove }: SidePanelProps) {
  return (
    <div className="panel grow">
      <h2>{title}</h2>
      <AddPanel onAdd={onAdd} />

      {lines.length === 0 ? (
        <div className="muted">No items yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th>Solve</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((ln) => (
                <tr key={ln.key}>
                  <td>{ln.label}</td>
                  <td className="num">
                    {ln.isUnknown ? (
                      <span aria-label="unknown quantity">?</span>
                    ) : (
                      <input
                        type="number"
                        min={1}
                        value={ln.quantity}
                        onChange={(e) => onQuantity(ln.key, Math.max(1, Number(e.target.value) || 1))}
                        aria-label={`Quantity for ${ln.label}`}
                        style={{ width: '4rem' }}
                      />
                    )}
                  </td>
                  <td>
                    <label>
                      <input
                        type="radio"
                        name="trade-unknown"
                        checked={ln.isUnknown}
                        onChange={() => onMarkUnknown(ln.key)}
                        aria-label={`Solve for ${ln.label}`}
                      />{' '}
                      solve for this
                    </label>
                  </td>
                  <td>
                    <button type="button" className="button ghost" onClick={() => onRemove(ln.key)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Result rendering --------------------------------------------------------

function BracketTable({ bracket, closest }: { bracket: BracketOption[]; closest: BracketOption | null }) {
  if (bracket.length === 0) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="num">Qty</th>
            <th>Remainder</th>
          </tr>
        </thead>
        <tbody>
          {bracket.map((b) => {
            const isClosest = closest != null && b.quantity === closest.quantity;
            return (
              <tr key={b.quantity} className={isClosest ? 'pill' : undefined}>
                <td className="num">
                  {b.quantity}{isClosest && <span className="pill"> closest</span>}
                </td>
                <td>
                  {b.aheadSide === 'even'
                    ? 'even'
                    : `${fmtCents(b.diffCents)} ahead for ${sideName(b.aheadSide)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ResultView({ result }: { result: BalanceResult }) {
  const unknownLine = result.unknown
    ? result.lines.find((l) => l.side === result.unknown!.side && l.variantId === result.unknown!.variantId)
    : null;
  const packsBoth = result.packsBySide[1] != null && result.packsBySide[2] != null;

  return (
    <div className="panel">
      {(result.stale || result.warnings.length > 0) && (
        <div className={`banner ${result.stale ? 'error' : 'warn'}`}>
          <strong>{result.stale ? 'Stale valuations in this trade' : 'Heads up'}</strong>
          <ul>
            {result.stale && result.warnings.length === 0 && (
              <li>One or more valuations are stale — treat these numbers with caution.</li>
            )}
            {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {result.unknown && (
        <h2>
          {result.unknown.solvedQuantity} × {unknownLine ? unknownLine.label : result.unknown.variantId}
          {' '}— closest whole quantity
        </h2>
      )}

      <BracketTable bracket={result.bracket} closest={result.closest} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Side</th>
              <th>Item</th>
              <th className="num">Qty</th>
              <th className="num">Unit market</th>
              <th className="num">Friction</th>
              <th className="num">Unit adjusted</th>
              <th className="num">Line adjusted</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((ln, i) => (
              <tr key={`${ln.side}-${ln.variantId}-${i}`}>
                <td>{sideName(ln.side)}</td>
                <td>
                  {ln.label}
                  {ln.unpriced && <span className="pill warn"> unpriced</span>}
                  {ln.stale && !ln.unpriced && <span className="pill warn"> stale</span>}
                </td>
                <td className="num">{ln.quantity}</td>
                <td className="num">{fmtCents(ln.unitMarketCents)}</td>
                <td className="num">
                  {ln.frictionPct > 0 ? (
                    <span className="pill warn">+{fmtPct(ln.frictionPct).replace('+', '')} allocation</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num">{fmtCents(ln.unitAdjustedCents)}</td>
                <td className="num">{fmtCents(ln.lineAdjustedCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>You give — total</td>
              <td className="num" colSpan={2}>market {fmtCents(result.sideTotals[1].marketCents)}</td>
              <td className="num" colSpan={2}>adjusted {fmtCents(result.sideTotals[1].adjustedCents)}</td>
            </tr>
            <tr>
              <td colSpan={3}>They give — total</td>
              <td className="num" colSpan={2}>market {fmtCents(result.sideTotals[2].marketCents)}</td>
              <td className="num" colSpan={2}>adjusted {fmtCents(result.sideTotals[2].adjustedCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {packsBoth && (
        <div className="muted">
          Packs — You: {result.packsBySide[1]} ({fmtCents(
            result.packsBySide[1] ? Math.round(result.sideTotals[1].adjustedCents / result.packsBySide[1]) : null,
          )}/pack) · They: {result.packsBySide[2]} ({fmtCents(
            result.packsBySide[2] ? Math.round(result.sideTotals[2].adjustedCents / result.packsBySide[2]) : null,
          )}/pack)
        </div>
      )}

      {result.liquidityLean && <p className="muted">{result.liquidityLean}</p>}
    </div>
  );
}

// --- Page --------------------------------------------------------------------

export default function Trades() {
  const [side1, setSide1] = useState<TradeLine[]>([]);
  const [side2, setSide2] = useState<TradeLine[]>([]);
  const [applyFriction, setApplyFriction] = useState(true);
  const [result, setResult] = useState<BalanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balancing, setBalancing] = useState(false);

  const setters: Record<SideId, React.Dispatch<React.SetStateAction<TradeLine[]>>> = {
    1: setSide1,
    2: setSide2,
  };

  function addLine(side: SideId, productId: string, variant: VariantRow, name: string) {
    setters[side]((prev) => [
      ...prev,
      { key: nextKey(), productId, variantId: variant.id, label: lineLabel(name, variant), quantity: 1, isUnknown: false },
    ]);
  }

  function setQuantity(side: SideId, key: string, quantity: number) {
    setters[side]((prev) => prev.map((l) => (l.key === key ? { ...l, quantity } : l)));
  }

  function removeLine(side: SideId, key: string) {
    setters[side]((prev) => prev.filter((l) => l.key !== key));
  }

  // Only one unknown allowed across BOTH sides.
  function markUnknown(key: string) {
    setSide1((prev) => prev.map((l) => ({ ...l, isUnknown: l.key === key })));
    setSide2((prev) => prev.map((l) => ({ ...l, isUnknown: l.key === key })));
  }

  const allLines = [...side1, ...side2];
  const unknownCount = allLines.filter((l) => l.isUnknown).length;
  const canBalance = side1.length >= 1 && side2.length >= 1 && unknownCount === 1;

  function toPayload(lines: TradeLine[]) {
    return lines.map((l) => (l.isUnknown ? { variantId: l.variantId } : { variantId: l.variantId, quantity: l.quantity }));
  }

  async function handleBalance() {
    if (!canBalance) return;
    setBalancing(true);
    setError(null);
    try {
      const res = await tradesApi.balance({
        sideA: toPayload(side1),
        sideB: toPayload(side2),
        applyFriction,
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Balance failed.');
      setResult(null);
    } finally {
      setBalancing(false);
    }
  }

  return (
    <div>
      <h1>Trade balancer</h1>
      <p className="muted">
        Add items to each side, mark one line "solve for this", and get a whole-number answer with the dollar remainder.
      </p>

      <div className="row">
        <SidePanel
          title="You give"
          lines={side1}
          onAdd={(pid, v, name) => addLine(1, pid, v, name)}
          onQuantity={(key, qty) => setQuantity(1, key, qty)}
          onMarkUnknown={markUnknown}
          onRemove={(key) => removeLine(1, key)}
        />
        <SidePanel
          title="They give"
          lines={side2}
          onAdd={(pid, v, name) => addLine(2, pid, v, name)}
          onQuantity={(key, qty) => setQuantity(2, key, qty)}
          onMarkUnknown={markUnknown}
          onRemove={(key) => removeLine(2, key)}
        />
      </div>

      <div className="panel">
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={applyFriction}
              onChange={(e) => setApplyFriction(e.target.checked)}
            />{' '}
            Apply sourcing friction
          </label>
          <button type="button" className="button" onClick={handleBalance} disabled={!canBalance || balancing}>
            {balancing ? 'Balancing…' : 'Balance'}
          </button>
          {!canBalance && (
            <span className="muted">
              Add at least one item to each side and mark exactly one line to solve for.
            </span>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {!error && result == null && (
        <div className="empty">
          <strong>Build a trade</strong>
          Add items to both sides and mark one line to solve for.
        </div>
      )}

      {result != null && <ResultView result={result} />}
    </div>
  );
}
