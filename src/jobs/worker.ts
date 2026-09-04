/**
 * Plain worker process (no queue service yet). Schedules the daily jobs with
 * node-cron. Runs are guarded so an overrun never overlaps itself.
 *
 * Cadence (UTC): prices hourly-ish is overkill for a daily-updating source and
 * would burn the API quota, so prices refresh once a day, then valuations
 * compute right after. Catalog sync is weekly. Times are conservative defaults —
 * tune per your plan's rate limits.
 */
import 'dotenv/config';
import cron from 'node-cron';
import { sequelize } from '../models/index.js';
import { syncCatalog } from './sync-catalog.js';
import { syncPrices } from './sync-prices.js';
import { backfillHistory } from './backfill-history.js';
import { computeValuations } from '../valuation/compute.js';
import { seedSealed } from './seed-sealed.js';
import { syncSealedPrices } from './sync-sealed-prices.js';
import { computeFriction } from './compute-friction.js';

let running = false;
async function guarded(name: string, fn: () => Promise<unknown>) {
  if (running) { console.warn(`[worker] skip ${name} — another job is running`); return; }
  running = true;
  const t = Date.now();
  try {
    const result = await fn();
    console.log(`[worker] ${name} ok in ${Math.round((Date.now() - t) / 1000)}s`, result);
  } catch (err) {
    console.error(`[worker] ${name} failed`, err);
  } finally {
    running = false;
  }
}

// Daily: singles prices 08:10, sealed snapshot 08:25, valuations 08:40, friction 08:55.
cron.schedule('10 8 * * *', () => guarded('sync-prices', () => syncPrices()));
cron.schedule('25 8 * * *', () => guarded('sync-sealed-prices', () => syncSealedPrices()));
cron.schedule('40 8 * * *', () => guarded('compute-valuations', () => computeValuations()));
cron.schedule('55 8 * * *', () => guarded('compute-friction', () => computeFriction()));
// Backfill singles history for newly-seen variants at 09:10 UTC.
cron.schedule('10 9 * * *', () => guarded('backfill-history', () => backfillHistory()));
// Catalog sync weekly Sun 06:00 UTC; sealed catalog seed Sun 06:40 UTC.
cron.schedule('0 6 * * 0', () => guarded('sync-catalog', () => syncCatalog()));
cron.schedule('40 6 * * 0', () => guarded('seed-sealed', () => seedSealed()));

console.log('[worker] scheduled: singles 08:10, sealed 08:25, valuations 08:40, friction 08:55, backfill 09:10 (daily); catalog + sealed seed Sun 06:00/06:40 UTC');

// Keep the process alive; close the DB cleanly on shutdown.
const shutdown = async () => { await sequelize.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
