#!/usr/bin/env node
/**
 * verify-pricecharting.js — confirms the two price fields the sealed source relies
 * on (`loose-price`, `new-price`) against the live API before any bulk sync, using
 * the verified anchor product (Prismatic Evolutions Super Premium Collection,
 * PriceCharting id 9382733, TCGplayer 622770). Also prints the sealed identity
 * fields (UPC, ePID, TCGplayer ID, Genre).
 *
 *   PRICECHARTING_TOKEN=xxx node scripts/verify-pricecharting.js
 *
 * Node 18+, no deps, read-only. 1 request/second — this makes at most two calls.
 */
const KEY = process.env.PRICECHARTING_TOKEN;
const BASE = 'https://www.pricecharting.com';

if (!KEY) {
  console.error('Set PRICECHARTING_TOKEN first:\n  PRICECHARTING_TOKEN=xxx node scripts/verify-pricecharting.js');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}t=${encodeURIComponent(KEY)}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

function dollars(pennies) {
  return pennies == null ? '(absent)' : `$${(Number(pennies) / 100).toFixed(2)}`;
}

async function main() {
  console.log('Checking PriceCharting sealed assumptions...\n');

  // Anchor: Prismatic Evolutions Super Premium Collection.
  const r = await get('/api/product?id=9382733');
  if (r.status !== 200 || !r.json) {
    console.log(`FAIL  GET /api/product?id=9382733 -> HTTP ${r.status}: ${r.text}`);
    if (r.status === 403 || r.status === 401) console.log('  -> token rejected or account not permitted.');
    return;
  }
  const p = r.json;
  console.log('Anchor product keys:', Object.keys(p).join(', '), '\n');
  const show = (k) => console.log(`  ${k.padEnd(18)} ${JSON.stringify(p[k])}`);
  console.log('Identity fields:');
  ['id', 'product-name', 'console-name', 'genre', 'release-date', 'upc', 'epid'].forEach(show);
  console.log('\nPrice fields we depend on (should be integer pennies):');
  console.log(`  loose-price        ${JSON.stringify(p['loose-price'])}  -> ${dollars(p['loose-price'])}`);
  console.log(`  new-price          ${JSON.stringify(p['new-price'])}  -> ${dollars(p['new-price'])}`);

  const checks = [];
  checks.push([/super premium/i.test(String(p['product-name'])), 'product-name is the SPC']);
  checks.push([String(p['genre'] || '').toLowerCase() === 'sealed product', `genre is "Sealed Product" (got ${JSON.stringify(p['genre'])})`]);
  checks.push([p['loose-price'] != null || p['new-price'] != null, 'at least one of loose-price/new-price is present']);
  checks.push([Number.isInteger(p['new-price'] ?? p['loose-price']), 'price is an integer (pennies, no float conversion)']);

  await sleep(1100); // honor 1 req/sec
  const s = await get('/api/products?q=One%20Piece%20OP-17%20Booster%20Box');
  const list = Array.isArray(s.json) ? s.json : s.json?.products;
  checks.push([Array.isArray(list), 'search endpoint returns a product list']);

  console.log('\n' + '='.repeat(60));
  let bad = 0;
  for (const [ok, name] of checks) { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`); if (!ok) bad++; }
  console.log('='.repeat(60));
  console.log(bad === 0
    ? '\nSealed source assumptions hold. Safe to run seed-sealed + sync-sealed-prices.'
    : `\n${bad} assumption(s) off. Fix src/sources/pricecharting.ts before a bulk sync.`);
}

main().catch((err) => { console.error('\nUnexpected failure:', err); });
