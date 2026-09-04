import { useEffect, useMemo, useState } from 'react'
import { api, fmtCents, tradeRulesApi, type TradeRuleRow, type Health } from '../lib/api'

/**
 * Settings page: configuration status pills + editable trade rate bands.
 * Money is integer cents end to end; dollar-denominated inputs convert on save.
 */

interface RowDraft {
  rate_pct: string
  floor_dollars: string
  ceiling_dollars: string
  volatility_penalty_pct: string
}

const centsToDollars = (c: number | null): string => (c == null ? '' : (c / 100).toFixed(2))
const dollarsToCents = (d: string): number | null => {
  const t = d.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isNaN(n) ? null : Math.round(n * 100)
}

const bandLabel = (min_cents: number, max_cents: number | null): string =>
  max_cents == null ? `${fmtCents(min_cents)}+` : `${fmtCents(min_cents)} – ${fmtCents(max_cents)}`

function draftFromRow(r: TradeRuleRow): RowDraft {
  return {
    rate_pct: String(Number(r.rate_pct)),
    floor_dollars: centsToDollars(r.floor_cents),
    ceiling_dollars: centsToDollars(r.ceiling_cents),
    volatility_penalty_pct: String(Number(r.volatility_penalty_pct)),
  }
}

export default function Settings() {
  const [health, setHealth] = useState<Health | null>(null)
  const [rules, setRules] = useState<TradeRuleRow[]>([])
  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({})
  const [saving, setSaving] = useState<Record<number, boolean>>({})
  const [saved, setSaved] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [h, list] = await Promise.all([api.health(), tradeRulesApi.list()])
        if (!alive) return
        setHealth(h)
        setRules(list)
        const d: Record<number, RowDraft> = {}
        for (const r of list) d[r.id] = draftFromRow(r)
        setDrafts(d)
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : 'Failed to load settings')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const setField = (id: number, field: keyof RowDraft, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
    setSaved((prev) => (prev[id] ? { ...prev, [id]: false } : prev))
  }

  const saveRow = async (r: TradeRuleRow) => {
    const d = drafts[r.id]
    if (!d) return
    setSaving((prev) => ({ ...prev, [r.id]: true }))
    setError(null)
    try {
      await tradeRulesApi.update(r.id, {
        rate_pct: Number(d.rate_pct),
        floor_cents: dollarsToCents(d.floor_dollars) ?? 0,
        ceiling_cents: dollarsToCents(d.ceiling_dollars),
        volatility_penalty_pct: Number(d.volatility_penalty_pct),
      })
      setSaved((prev) => ({ ...prev, [r.id]: true }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save band')
    } finally {
      setSaving((prev) => ({ ...prev, [r.id]: false }))
    }
  }

  const cash = useMemo(() => rules.filter((r) => r.currency === 'cash'), [rules])
  const credit = useMemo(() => rules.filter((r) => r.currency === 'credit'), [rules])

  const renderTable = (title: string, rows: TradeRuleRow[]) => (
    <div className="panel">
      <h3>{title}</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Band</th>
              <th className="num">Rate %</th>
              <th className="num">Floor</th>
              <th className="num">Ceiling</th>
              <th>Effective from</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = drafts[r.id]
              if (!d) return null
              return (
                <tr key={r.id}>
                  <td>{bandLabel(r.min_cents, r.max_cents)}</td>
                  <td className="num">
                    <input
                      className="num"
                      type="number"
                      step="0.1"
                      value={d.rate_pct}
                      onChange={(e) => setField(r.id, 'rate_pct', e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="num"
                      type="number"
                      step="0.01"
                      value={d.floor_dollars}
                      onChange={(e) => setField(r.id, 'floor_dollars', e.target.value)}
                    />
                  </td>
                  <td className="num">
                    <input
                      className="num"
                      type="number"
                      step="0.01"
                      placeholder="none"
                      value={d.ceiling_dollars}
                      onChange={(e) => setField(r.id, 'ceiling_dollars', e.target.value)}
                    />
                  </td>
                  <td className="muted">{r.effective_from}</td>
                  <td>
                    <div className="row">
                      <button
                        className="button"
                        disabled={saving[r.id]}
                        onClick={() => saveRow(r)}
                      >
                        {saving[r.id] ? 'Saving…' : 'Save'}
                      </button>
                      {saved[r.id] && <span className="muted">Saved ✓ (new version)</span>}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div>
      <h1>Settings</h1>

      {error && <div className="banner error">{error}</div>}

      <section>
        <h2>Configuration status</h2>
        {loading && !health ? (
          <div className="muted">Loading…</div>
        ) : health ? (
          <div className="row grow">
            {health.priceSource ? (
              <span className="pill">Price source configured</span>
            ) : (
              <span className="pill warn">set JUSTTCG_API_KEY</span>
            )}
            {health.psa ? (
              <span className="pill">PSA token configured</span>
            ) : (
              <span className="pill warn">set PSA_ACCESS_TOKEN</span>
            )}
            {health.db ? (
              <span className="pill">DB connected</span>
            ) : (
              <span className="pill bad">DB not connected</span>
            )}
          </div>
        ) : null}
      </section>

      <section>
        <h2>Trade rate bands</h2>
        <p className="muted">
          Editing a band creates a new version effective today; past offers stay explained by the
          band that was live then.
        </p>
        {loading ? (
          <div className="muted">Loading…</div>
        ) : rules.length === 0 ? (
          <div className="empty">
            <strong>No trade rules</strong>
            Run the database migrations to load the default bands.
          </div>
        ) : (
          <>
            {renderTable('Cash', cash)}
            {renderTable('Credit', credit)}
          </>
        )}
      </section>
    </div>
  )
}
