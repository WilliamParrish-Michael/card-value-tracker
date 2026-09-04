/**
 * Scan page — cert / UPC lookup by camera or (first-class) manual entry.
 *
 * Rule Zero: we say what's wrong and never guess a card. Low-confidence cert
 * matches always route through an explicit picker; a missing/failed lookup
 * surfaces the real reason instead of silently resolving to something.
 */

import { useEffect, useRef, useState } from 'react'
import { api, fmtCents, type Health, type ScanResult, type ScanCandidate } from '../lib/api'
import { BrowserMultiFormatReader } from '@zxing/browser'

type Mode = 'idle' | 'cert' | 'upc'
type UpcResult = { matches: Array<{ product_id: string; game: string; set_code: string; name: string }>; needsAssociation: boolean }

const DIGITS = /\D+/g
const isCert = (d: string) => d.length >= 8 && d.length <= 10
const isUpc = (d: string) => d.length >= 12 && d.length <= 13

export default function Scan({ health }: { health: Health | null }) {
  const [entry, setEntry] = useState('')
  const [mode, setMode] = useState<Mode>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  // The cert number that produced the current cert result (needed to confirm).
  const [certNumber, setCertNumber] = useState('')
  const [certResult, setCertResult] = useState<ScanResult | null>(null)
  const [upcResult, setUpcResult] = useState<UpcResult | null>(null)

  // Manual grade entry when the cert result has no grade.
  const [manualGrade, setManualGrade] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Camera.
  const [cameraOn, setCameraOn] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const resetResults = () => {
    setCertResult(null)
    setUpcResult(null)
    setConfirmed(false)
    setManualGrade('')
    setError(null)
    setHint(null)
  }

  const runLookup = async (raw: string) => {
    const digits = raw.replace(DIGITS, '')
    resetResults()

    if (!isCert(digits) && !isUpc(digits)) {
      setMode('idle')
      setHint('Enter an 8–10 digit PSA cert or a 12–13 digit UPC.')
      return
    }

    setBusy(true)
    try {
      if (isCert(digits)) {
        setMode('cert')
        setCertNumber(digits)
        const res = await api.scanCert(digits)
        setCertResult(res)
      } else {
        setMode('upc')
        const res = await api.scanUpc(digits)
        setUpcResult(res)
      }
    } catch (err) {
      const e = err as Error & { status?: number; reason?: string }
      if (e.reason === 'cert_not_found') {
        setError(`PSA doesn't recognize cert ${digits}.`)
      } else if (e.reason === 'psa_unavailable' || e.status === 403) {
        setError("PSA API access isn't approved for this account yet — request access (collectors-apis@collectors.com).")
      } else if (e.reason === 'invalid_format') {
        setHint('Enter an 8–10 digit PSA cert or a 12–13 digit UPC.')
      } else {
        setError(e.message || 'Lookup failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  const onManualSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!entry.trim() || busy) return
    void runLookup(entry)
  }

  // ---- Camera lifecycle ---------------------------------------------------

  const stopCamera = () => {
    try {
      const anyReader = BrowserMultiFormatReader as unknown as { releaseAllStreams?: () => void }
      anyReader.releaseAllStreams?.()
    } catch { /* ignore */ }
    readerRef.current = null
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraOn(false)
  }

  const startCamera = async () => {
    setError(null)
    setHint(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      setCameraOn(true)
    } catch {
      setError('Camera unavailable — HTTPS is required, or use manual entry.')
      setCameraOn(false)
    }
  }

  // Wire the live stream + zxing decoder once the <video> is mounted.
  useEffect(() => {
    if (!cameraOn) return
    const videoEl = videoRef.current
    const stream = streamRef.current
    if (!videoEl || !stream) return

    videoEl.srcObject = stream
    videoEl.play().catch(() => { /* autoplay may be deferred; ignore */ })

    const reader = new BrowserMultiFormatReader()
    readerRef.current = reader
    let cancelled = false

    reader.decodeFromVideoDevice(undefined, videoEl, (result) => {
      if (cancelled || !result) return
      const text = result.getText()
      // eslint-disable-next-line no-console
      console.log('[scan] decoded:', text)
      const digits = text.replace(DIGITS, '')
      if (isCert(digits) || isUpc(digits)) {
        cancelled = true
        stopCamera()
        void runLookup(digits)
      }
    }).catch(() => {
      if (!cancelled) setError('Camera unavailable — HTTPS is required, or use manual entry.')
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn])

  // Release everything on unmount.
  useEffect(() => {
    return () => stopCamera()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Confirm a cert match/candidate ------------------------------------

  const confirmCandidate = async (candidate: ScanCandidate) => {
    if (!certResult) return
    let grade = certResult.grade ?? null
    if (grade == null) {
      const parsed = Number(manualGrade)
      if (!manualGrade.trim() || Number.isNaN(parsed)) {
        setError('Enter the grade before confirming.')
        return
      }
      grade = parsed
    }
    setConfirming(true)
    setError(null)
    try {
      await api.scanConfirm({ cert: certNumber, product_id: candidate.product_id, grade, grader: 'PSA' })
      setConfirmed(true)
    } catch (err) {
      setError((err as Error).message || 'Confirm failed.')
    } finally {
      setConfirming(false)
    }
  }

  // ---- Rendering helpers --------------------------------------------------

  const needsGrade = certResult != null && certResult.grade == null

  const renderCandidate = (c: ScanCandidate, label: string) => (
    <div className="row" key={c.product_id}>
      <div className="grow">
        <strong>{c.name}</strong>
        <div className="muted">
          {c.set_code} · #{c.collector_number}
          {c.rarity ? ` · ${c.rarity}` : ''}
          {' '}
          <span className="pill">match {Math.round(c.score * 100)}%</span>
        </div>
      </div>
      <button className="button" disabled={confirming} onClick={() => void confirmCandidate(c)}>{label}</button>
    </div>
  )

  const variant = certResult?.variant
  const variantName = variant && typeof variant.name === 'string' ? variant.name : null
  const variantSet = variant && typeof variant.set_code === 'string' ? variant.set_code : null
  const variantCents = variant && variant.market_cents != null ? Number(variant.market_cents) : null

  return (
    <div>
      <h1>Scan</h1>

      {health && !health.psa && (
        <div className="banner warn">
          PSA token not set — cert lookups will fail until PSA_ACCESS_TOKEN is configured.
        </div>
      )}

      {/* Manual entry — first-class, always visible */}
      <div className="panel">
        <form className="row" onSubmit={onManualSubmit}>
          <input
            className="grow"
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="PSA cert (8–10 digits) or UPC (12–13 digits)"
            inputMode="numeric"
            autoComplete="off"
          />
          <button className="button" type="submit" disabled={busy || !entry.trim()}>Look up</button>
        </form>
        {hint && <div className="muted">{hint}</div>}
        <div className="muted">
          BGS and CGC slabs have no cert API — enter those by hand (manual entry above); a barcode only carries the cert number, not the grader.
        </div>
      </div>

      {/* Camera */}
      <div className="panel">
        <div className="row">
          {cameraOn
            ? <button className="button secondary" onClick={stopCamera}>Stop camera</button>
            : <button className="button secondary" onClick={() => void startCamera()}>Start camera</button>}
        </div>
        {cameraOn && (
          <video
            ref={videoRef}
            muted
            autoPlay
            playsInline
            style={{ width: '100%', maxWidth: 480, borderRadius: 8, marginTop: 8 }}
          />
        )}
        <div className="muted">
          Newer PSA labels also carry a QR code — the reader accepts multiple barcode formats.
        </div>
      </div>

      {busy && <div className="muted">Looking up…</div>}
      {error && <div className="banner error">{error}</div>}

      {/* CERT RESULT */}
      {mode === 'cert' && certResult && (
        <div className="panel">
          {certResult.resolved ? (
            <div>
              <h2>Resolved</h2>
              <div className="row">
                <div className="grow">
                  <strong>{variantName ?? 'Known card'}</strong>
                  {variantSet && <span className="muted"> · {variantSet}</span>}
                </div>
                <span className="num">{fmtCents(variantCents)}</span>
              </div>
            </div>
          ) : (
            <div>
              <h2>PSA cert facts</h2>
              {certResult.cert && (
                <div className="muted">
                  {[
                    certResult.cert.subject,
                    certResult.cert.year,
                    certResult.cert.grade != null ? `Grade ${certResult.cert.grade}` : null,
                    certResult.cert.cardNumber ? `#${certResult.cert.cardNumber}` : null,
                    certResult.cert.brand,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}

              {confirmed ? (
                <div className="banner">Confirmed ✓ — this cert will resolve instantly next time.</div>
              ) : (
                <>
                  {needsGrade && (
                    <div className="row">
                      <label className="grow">Grade</label>
                      <input
                        className="num"
                        type="number"
                        step="0.5"
                        min="1"
                        max="10"
                        value={manualGrade}
                        onChange={(e) => setManualGrade(e.target.value)}
                        placeholder="e.g. 10"
                      />
                    </div>
                  )}

                  {certResult.match ? (
                    <div>
                      <div className="muted">Confident match:</div>
                      {renderCandidate(certResult.match, 'Confirm this match')}
                    </div>
                  ) : certResult.candidates && certResult.candidates.length > 0 ? (
                    <div>
                      <div className="muted">Pick the matching card</div>
                      {certResult.candidates.map((c) => renderCandidate(c, 'This one'))}
                    </div>
                  ) : (
                    <div className="empty">No candidate cards matched this cert.</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* UPC RESULT */}
      {mode === 'upc' && upcResult && (
        <div className="panel">
          <h2>Sealed product</h2>
          {upcResult.matches.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Set</th><th>Game</th></tr>
                </thead>
                <tbody>
                  {upcResult.matches.map((m) => (
                    <tr key={m.product_id}>
                      <td>{m.name}</td>
                      <td>{m.set_code}</td>
                      <td className="muted">{m.game}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : upcResult.needsAssociation ? (
            <div className="empty">No sealed product is linked to this UPC yet — associate it from the product page.</div>
          ) : (
            <div className="empty">No sealed product found for this UPC.</div>
          )}
        </div>
      )}
    </div>
  )
}
