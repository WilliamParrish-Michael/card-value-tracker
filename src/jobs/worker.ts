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

// Daily prices at 08:10 UTC, then compute valuations at 08:40 UTC.
cron.schedule('10 8 * * *', () => guarded('sync-prices', () => syncPrices()));
cron.schedule('40 8 * * *', () => guarded('compute-valuations', () => computeValuations()));
// Backfill history for newly-seen variants at 09:10 UTC.
cron.schedule('10 9 * * *', () => guarded('backfill-history', () => backfillHistory()));
// Catalog sync weekly, Sunday 06:00 UTC.
cron.schedule('0 6 * * 0', () => guarded('sync-catalog', () => syncCatalog()));

console.log('[worker] scheduled: prices 08:10, valuations 08:40, backfill 09:10 (daily), catalog Sun 06:00 UTC');

// Keep the process alive; close the DB cleanly on shutdown.
const shutdown = async () => { await sequelize.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
