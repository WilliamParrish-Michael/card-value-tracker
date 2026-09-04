import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { api, type Health } from './lib/api';
import Search from './pages/Search';
import Collection from './pages/Collection';
import Scan from './pages/Scan';
import Trades from './pages/Trades';
import Settings from './pages/Settings';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setHealthErr(e.message));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Card Value Tracker</div>
        <nav>
          <NavLink to="/search">Search</NavLink>
          <NavLink to="/collection">Collection</NavLink>
          <NavLink to="/scan">Scan</NavLink>
          <NavLink to="/trades">Trades</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>

      {/* Honest status banners — name what's missing rather than showing empty grids silently. */}
      {healthErr && <div className="banner error">API unreachable: {healthErr}. Is the server running (npm run dev in the repo root)?</div>}
      {health && !health.db && <div className="banner error">Database not connected — check DATABASE_URL and run the migrations.</div>}
      {health && health.db && !health.priceSource && (
        <div className="banner warn">No price source configured — set <code>JUSTTCG_API_KEY</code> to load catalog and prices.</div>
      )}

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/search" replace />} />
          <Route path="/search" element={<Search />} />
          <Route path="/collection" element={<Collection />} />
          <Route path="/scan" element={<Scan health={health} />} />
          <Route path="/trades" element={<Trades />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
