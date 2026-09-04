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
  showAdd?: boolean;   // the search/add box (hidden on the review step)
  showSolve?: boolean; // the "solve for this" radios (shown only on review)
}

function SidePanel({ title, lines, onAdd, onQuantity, onMarkUnknown, onRemove, showAdd = true, showSolve = true }: SidePanelProps) {
  return (
    <div className="panel grow">
      <h2>{title}</h2>
      {showAdd && <AddPanel onAdd={onAdd} />}

      {lines.length === 0 ? (
        <div className="muted">No items yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                {showSolve && <th>Solve</th>}
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
                  {showSolve && (
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
                  )}
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

// --- Wizard step header ------------------------------------------------------

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['What you’re trading', 'What you’re trading for', 'Review & balance'];
  return (
    <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const state = n === step ? 'sealed' : n < step ? 'card' : '';
        return (
          <span key={n} className={`pill ${state}`}>
            {n}. {label}{n < step ? ' ✓' : ''}
          </span>
        );
      })}
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
  const [step, setStep] = useState<1 | 2 | 3>(1);
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

  function goToReview() {
    // Default the unknown to the last item on their side if nothing is marked yet.
    if (unknownCount === 0 && side2.length > 0) markUnknown(side2[side2.length - 1].key);
    setStep(3);
  }

  return (
    <div>
      <h1>Trade balancer</h1>
      <p className="muted">
        One step at a time: pick what you’re trading, then what you’re trading for, then solve for the odd item.
      </p>

      <Steps step={step} />

      {step === 1 && (
        <>
          <SidePanel
            title="What you’re trading (your side)"
            lines={side1}
            onAdd={(pid, v, name) => addLine(1, pid, v, name)}
            onQuantity={(key, qty) => setQuantity(1, key, qty)}
            onMarkUnknown={markUnknown}
            onRemove={(key) => removeLine(1, key)}
            showSolve={false}
          />
          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button type="button" className="button" onClick={() => setStep(2)} disabled={side1.length < 1}>
              Next: what you’re trading for →
            </button>
          </div>
          {side1.length < 1 && <p className="muted">Add at least one item to continue.</p>}
        </>
      )}

      {step === 2 && (
        <>
          <SidePanel
            title="What you’re trading for (their side)"
            lines={side2}
            onAdd={(pid, v, name) => addLine(2, pid, v, name)}
            onQuantity={(key, qty) => setQuantity(2, key, qty)}
            onMarkUnknown={markUnknown}
            onRemove={(key) => removeLine(2, key)}
            showSolve={false}
          />
          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <button type="button" className="button ghost" onClick={() => setStep(1)}>← Back</button>
            <button type="button" className="button" onClick={goToReview} disabled={side2.length < 1}>
              Next: review & balance →
            </button>
          </div>
          {side2.length < 1 && <p className="muted">Add at least one item to continue.</p>}
        </>
      )}

      {step === 3 && (
        <>
          <SidePanel
            title="You give"
            lines={side1}
            onAdd={(pid, v, name) => addLine(1, pid, v, name)}
            onQuantity={(key, qty) => setQuantity(1, key, qty)}
            onMarkUnknown={markUnknown}
            onRemove={(key) => removeLine(1, key)}
            showAdd={false}
          />
          <div style={{ height: 12 }} />
          <SidePanel
            title="They give"
            lines={side2}
            onAdd={(pid, v, name) => addLine(2, pid, v, name)}
            onQuantity={(key, qty) => setQuantity(2, key, qty)}
            onMarkUnknown={markUnknown}
            onRemove={(key) => removeLine(2, key)}
            showAdd={false}
          />

          <div className="panel">
            <div className="row">
              <button type="button" className="button ghost" onClick={() => setStep(2)}>← Back</button>
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
                <span className="muted">Mark exactly one line as “solve for this”.</span>
              )}
            </div>
          </div>

          {error && <div className="banner error">{error}</div>}
          {result != null && <ResultView result={result} />}
        </>
      )}
    </div>
  );
}
