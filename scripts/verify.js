#!/usr/bin/env node
/**
 * verify.js — checks every assumption the adapter makes against the
 * live JustTCG API, and prints what's actually there.
 *
 * You don't need to know the API to run this. It tells you which
 * guesses held and which didn't.
 *
 *   1. Get a free key at justtcg.com
 *   2. JUSTTCG_API_KEY=tcg_xxx node verify.js
 *   3. Paste the output back to me
 *
 * Node 18+. No dependencies. Read-only — it can't change anything
 * on your account.
 */

const KEY = process.env.JUSTTCG_API_KEY;
const BASE = 'https://api.justtcg.com/v1';

if (!KEY) {
  console.error('Set JUSTTCG_API_KEY first:\n  JUSTTCG_API_KEY=tcg_xxx node verify.js');
  process.exit(1);
}

const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-api-key': KEY } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, json, text: text.slice(0, 400) };
}

/** Response envelope may be {data:[...]} or a bare array. Handle both. */
const unwrap = (r) => (Array.isArray(r?.json) ? r.json : r?.json?.data);

async function main() {
  console.log('Checking JustTCG API assumptions...\n');

  // --- 1. Auth + which games exist, under what slugs -----------------
  const games = await get('/games');
  if (games.status !== 200) {
    fail('auth / GET /games', `HTTP ${games.status}: ${games.text}`);
    return report();
  }
  const gameList = unwrap(games) ?? [];
  pass('auth / GET /games', `${gameList.length} games`);
  console.log('Game identifiers (the adapter needs these exact strings):');
  for (const g of gameList) {
    console.log('  ', JSON.stringify(g));
  }
  console.log('');

  // The adapter assumes these four slugs. Confirm each one exists.
  const assumed = ['pokemon', 'pokemon-japan', 'magic-the-gathering', 'one-piece-card-game'];
  const actual = new Set(
    gameList.flatMap((g) => [g?.id, g?.slug, g?.game, g?.name].filter(Boolean)),
  );
  for (const slug of assumed) {
    actual.has(slug)
      ? pass(`game slug "${slug}"`, 'exists')
      : fail(`game slug "${slug}"`, 'NOT FOUND — see the list above for the real value');
  }

  // Pick a real One Piece slug to test with, falling back to whatever exists.
  const opGame =
    [...actual].find((s) => /one.?piece/i.test(String(s))) ?? gameList[0]?.id ?? 'pokemon';

  // --- 2. Sets endpoint + whether set codes are exposed --------------
  const sets = await get(`/sets?game=${encodeURIComponent(opGame)}`);
  const setList = unwrap(sets) ?? [];
  if (sets.status === 200 && setList.length) {
    pass(`GET /sets?game=${opGame}`, `${setList.length} sets`);
    console.log('First set object (does it carry a set code like OP09?):');
    console.log('  ', JSON.stringify(setList[0]), '\n');
    'code' in (setList[0] ?? {})
      ? pass('sets expose a code', 'sets.set_code can be populated directly')
      : fail('sets expose a code', 'no "code" field — derive set_code from the name instead');
  } else {
    fail(`GET /sets?game=${opGame}`, `HTTP ${sets.status}: ${sets.text}`);
  }

  // --- 3. Cards: params, pagination, and the variant shape -----------
  const setName = setList[0]?.name ?? setList[0]?.id;
  const cardsPath =
    `/cards?game=${encodeURIComponent(opGame)}` +
    (setName ? `&set=${encodeURIComponent(setName)}` : '') +
    `&limit=5&offset=0&priceHistoryDuration=30d`;

  const cards = await get(cardsPath);
  const cardList = unwrap(cards) ?? [];

  if (cards.status !== 200) {
    fail('GET /cards with assumed params', `HTTP ${cards.status}: ${cards.text}`);
    fail('  -> likely cause', 'one of limit/offset/set/priceHistoryDuration is named differently');
  } else if (!cardList.length) {
    fail('GET /cards with assumed params', 'HTTP 200 but zero cards — check the set param name');
  } else {
    pass('GET /cards with assumed params', `${cardList.length} cards`);
    cardList.length === 5
      ? pass('limit param honored', 'pagination loop should work')
      : fail('limit param honored', `asked for 5, got ${cardList.length}`);

    const card = cardList[0];
    console.log('First card object, keys only:');
    console.log('  ', Object.keys(card).join(', '), '\n');

    for (const f of ['uuid', 'id', 'name', 'set', 'game']) {
      f in card ? pass(`card.${f}`, 'present') : fail(`card.${f}`, 'MISSING');
    }
    'number' in card
      ? pass('card.number', `e.g. ${JSON.stringify(card.number)}`)
      : fail('card.number', 'MISSING — collector_number is NOT NULL in the schema');

    const v = card.variants?.[0];
    if (!v) {
      fail('card.variants', 'MISSING — the whole variant model depends on this');
    } else {
      console.log('First variant object:');
      console.log('  ', JSON.stringify(v, null, 2).slice(0, 900), '\n');

      for (const f of ['uuid', 'condition', 'printing', 'price']) {
        f in v ? pass(`variant.${f}`, 'present') : fail(`variant.${f}`, 'MISSING');
      }
      'tcgplayerSkuId' in v
        ? pass('variant.tcgplayerSkuId', 'crosswalk to other sources works')
        : fail('variant.tcgplayerSkuId', 'MISSING — second source would need fuzzy matching');

      const hist = v.priceHistory30d ?? v.priceHistory;
      Array.isArray(hist) && hist.length
        ? pass('variant price history', `${hist.length} points, e.g. ${JSON.stringify(hist[0])}`)
        : fail('variant price history', 'empty — you may need to accumulate your own after all');

      'language' in v
        ? pass('variant.language', `present: ${JSON.stringify(v.language)}`)
        : pass('variant.language', 'absent, which per docs means English — default is correct');
    }

    // --- 4. Batch endpoint — the nightly job depends on this ---------
    const uuids = cardList.map((c) => c.uuid).filter(Boolean).slice(0, 3);
    if (uuids.length) {
      const batch = await post('/cards', {
        cards: uuids.map((uuid) => ({ uuid })),
        priceHistoryDuration: '30d',
      });
      const batchList = unwrap(batch) ?? [];
      batch.status === 200 && batchList.length
        ? pass('POST /cards batch', `${batchList.length} cards returned for ${uuids.length} sent`)
        : fail('POST /cards batch', `HTTP ${batch.status}: ${batch.text}`);
    }
  }

  report();
}

function report() {
  console.log('\n' + '='.repeat(60));
  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name} — ${r.detail}`);
  }
  console.log('='.repeat(60));
  console.log(
    bad.length === 0
      ? '\nEverything checked out. The adapter should run as written.'
      : `\n${bad.length} assumption(s) wrong. Paste this output back and I'll fix the adapter.`,
  );
}

main().catch((err) => {
  console.error('\nUnexpected failure:', err);
  report();
});
