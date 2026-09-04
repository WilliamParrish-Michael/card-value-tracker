/**
 * Search page — find a card in the catalog by name, collector number, or set
 * code, inspect its variants, and add a variant to the collection.
 *
 * Prices are integer cents; fmtCents renders a missing price as "—", never
 * $0.00 (Rule Zero: name what's missing, don't fake it).
 */

import { Fragment, useState } from 'react';
import { api, fmtCents, fmtPct, GAMES, type SearchHit, type VariantRow, type ProductInfo } from '../lib/api';

interface VariantsPanel {
  product: ProductInfo;
  variants: VariantRow[];
}

function variantLabel(v: VariantRow): string {
  if (v.grader && v.grade) return `${v.grader} ${v.grade}`;
  const parts = [v.condition, v.printing].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Variant';
}

function pctClass(p: string | null): string {
  if (p == null) return '';
  const n = Number(p);
  if (Number.isNaN(n) || n === 0) return '';
  return n > 0 ? 'pos' : 'neg';
}

export default function Search() {
  const [q, setQ] = useState('');
  const [game, setGame] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchedTerm, setSearchedTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Variants panel state, keyed to the product it belongs to.
  const [openProductId, setOpenProductId] = useState<string | null>(null);
  const [panel, setPanel] = useState<VariantsPanel | null>(null);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantsError, setVariantsError] = useState<string | null>(null);

  // variant_id -> "added" once addHolding succeeds.
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [addingId, setAddingId] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    setError(null);
    setOpenProductId(null);
    setPanel(null);
    try {
      const results = await api.search(term, game || undefined);
      setHits(results);
      setSearchedTerm(term);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  async function toggleVariants(productId: string) {
    if (openProductId === productId) {
      setOpenProductId(null);
      setPanel(null);
      setVariantsError(null);
      return;
    }
    setOpenProductId(productId);
    setPanel(null);
    setVariantsError(null);
    setVariantsLoading(true);
    try {
      const data = await api.productVariants(productId);
      setPanel(data);
    } catch (err) {
      setVariantsError(err instanceof Error ? err.message : 'Failed to load variants.');
    } finally {
      setVariantsLoading(false);
    }
  }

  async function handleAdd(variantId: string) {
    setAddingId(variantId);
    setVariantsError(null);
    try {
      await api.addHolding({ variant_id: variantId });
      setAdded((prev) => ({ ...prev, [variantId]: true }));
    } catch (err) {
      setVariantsError(err instanceof Error ? err.message : 'Failed to add holding.');
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div>
      <h1>Search</h1>

      <form onSubmit={handleSearch} className="panel">
        <div className="row">
          <input
            className="grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, or OP09-093, or set code…"
            aria-label="Search query"
          />
          <select value={game} onChange={(e) => setGame(e.target.value)} aria-label="Game">
            {GAMES.map((g) => (
              <option key={g.slug} value={g.slug}>{g.label}</option>
            ))}
          </select>
          <button type="submit" className="button" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <div className="banner error">{error}</div>}

      {hits == null && !error && (
        <div className="empty">
          <strong>Search your catalog</strong>
          Find a card by name, collector number (e.g. OP09-093), or set code.
        </div>
      )}

      {hits != null && hits.length === 0 && (
        <div className="empty">
          <strong>No matches for "{searchedTerm}"</strong>
          If the catalog hasn't been synced yet, results will be empty until JUSTTCG_API_KEY is set and the catalog sync has run.
        </div>
      )}

      {hits != null && hits.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Card</th>
                <th>Game</th>
                <th className="num">Market</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <Fragment key={h.product_id}>
                  <tr>
                    <td>
                      <div>{h.name}</div>
                      <div className="muted">{h.set_code} · #{h.collector_number}</div>
                      {h.rarity && <span className="pill">{h.rarity}</span>}
                    </td>
                    <td>{h.game}</td>
                    <td className="num">{fmtCents(h.market_cents)}</td>
                    <td>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => toggleVariants(h.product_id)}
                      >
                        Variants
                      </button>
                    </td>
                  </tr>
                  {openProductId === h.product_id && (
                    <tr>
                      <td colSpan={4}>
                        {variantsLoading && <div className="muted">Loading variants…</div>}
                        {variantsError && <div className="banner error">{variantsError}</div>}
                        {panel && !variantsLoading && (
                          panel.variants.length === 0 ? (
                            <div className="empty">
                              <strong>No variants</strong>
                              This product has no priced variants yet.
                            </div>
                          ) : (
                            <div className="table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>Variant</th>
                                    <th className="num">Market</th>
                                    <th className="num">7d</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {panel.variants.map((v) => (
                                    <tr key={v.id}>
                                      <td>
                                        <div>{variantLabel(v)}</div>
                                        {v.language && v.language !== 'English' && (
                                          <div className="muted">{v.language}</div>
                                        )}
                                      </td>
                                      <td className="num">{fmtCents(v.market_cents)}</td>
                                      <td className={`num ${pctClass(v.change_7d_pct)}`}>
                                        {fmtPct(v.change_7d_pct)}
                                      </td>
                                      <td>
                                        {added[v.id] ? (
                                          <span className="muted">Added ✓</span>
                                        ) : (
                                          <button
                                            type="button"
                                            className="button"
                                            onClick={() => handleAdd(v.id)}
                                            disabled={addingId === v.id}
                                          >
                                            {addingId === v.id ? 'Adding…' : 'Add'}
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
