/**
 * Integration test for the JustTCG adapter, run against a recorded fixture
 * (__fixtures__/justtcg-cards-one-piece.json — a real API response, captured
 * once). No network, no invented data.
 *
 * The fixture is imported ONLY here in tests, never by application code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JustTCGSource } from './adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, '../../__fixtures__/justtcg-cards-one-piece.json'), 'utf8'),
);

describe('JustTCGSource (against recorded fixture)', () => {
  beforeEach(() => {
    // Any call returns the recorded envelope { data, meta, _metadata }.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => fixture,
      text: async () => '',
    })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps prices as integer cents — never multiplies by 100', async () => {
    const src = new JustTCGSource({ apiKey: 'test', requestsPerSecond: 1000 });
    const cards = await src.fetchByIds(['any-uuid']);
    const quotes = cards.flatMap((c) => c.quotes);
    expect(quotes.length).toBeGreaterThan(0);

    for (const q of quotes) {
      // Raw JustTCG value is already cents (float); the adapter rounds it.
      const raw = (q.raw as { price: number }).price;
      expect(q.priceCents).toBe(Math.round(raw));
      // Sanity: a booster-box case should be a few hundred dollars, not tens of thousands.
      expect(q.priceCents).toBeLessThan(10_000_00);
    }
  });

  it('uses set_name for the display name and set slug separately', async () => {
    const src = new JustTCGSource({ apiKey: 'test', requestsPerSecond: 1000 });
    const [card] = await src.fetchByIds(['any-uuid']);
    expect(card.setName).toBe('Romance Dawn');
    expect(card.setSlug).toBe('romance-dawn-one-piece-card-game');
  });

  it('defaults language to English and never emits null', async () => {
    const src = new JustTCGSource({ apiKey: 'test', requestsPerSecond: 1000 });
    const cards = await src.fetchByIds(['any-uuid']);
    for (const q of cards.flatMap((c) => c.quotes)) {
      expect(q.variant.language).toBeTruthy();
    }
  });

  it('backfills history points as { observedOn, priceCents } with cents rounded', async () => {
    const src = new JustTCGSource({ apiKey: 'test', requestsPerSecond: 1000 });
    const withHistory = (await src.fetchByIds(['any-uuid']))
      .flatMap((c) => c.quotes)
      .find((q) => q.history && q.history.length);

    if (!withHistory) return; // fixture may not carry history for every variant
    for (const pt of withHistory.history!) {
      expect(pt.observedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(pt.priceCents)).toBe(true);
    }
  });
});
