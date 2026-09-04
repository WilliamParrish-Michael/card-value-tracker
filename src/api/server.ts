/**
 * Express server. Every external API call (JustTCG, PSA) happens behind this
 * layer — the browser never sees a key. Routes return honest empty states with
 * a `missing` field when something isn't configured, rather than faking data.
 */
import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { sequelize } from '../models/index.js';
import { hasAnySource } from '../sources/registry.js';
import { searchRouter } from './routes/search.js';
import { collectionRouter } from './routes/collection.js';
import { valuationRouter } from './routes/valuation.js';
import { scanRouter } from './routes/scan.js';
import { tradeRulesRouter } from './routes/trade-rules.js';
import { tradesRouter } from './routes/trades.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Dev CORS: the Vite front end runs on a different origin. Lock this down in prod.
  const origin = process.env.FRONTEND_ORIGIN ?? '*';
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  app.get('/api/health', async (_req, res) => {
    let db = false;
    try { await sequelize.authenticate(); db = true; } catch { /* db down */ }
    res.json({
      ok: true,
      db,
      // Surfaced so the UI can show "set JUSTTCG_API_KEY" instead of empty grids
      // with no explanation.
      priceSource: hasAnySource(),
      psa: Boolean(process.env.PSA_ACCESS_TOKEN),
    });
  });

  app.use('/api/search', searchRouter());
  app.use('/api/collection', collectionRouter());
  app.use('/api/valuation', valuationRouter());
  app.use('/api/scan', scanRouter());
  app.use('/api/trade-rules', tradeRulesRouter());
  app.use('/api/trades', tradesRouter());

  // In production, serve the built web app from the same origin so one Render
  // service hosts both API and UI (keys stay server-side; no CORS in play).
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return app;
}

const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();
  app.listen(port, () => console.log(`[api] listening on http://localhost:${port}`));
}
