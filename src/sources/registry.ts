/**
 * Wires the configured price sources into a registry from the environment.
 *
 * A source only exists here if its key is present — no key, no source, and the
 * caller gets an empty registry that the UI surfaces as "no source configured"
 * rather than a fake number (Rule Zero).
 *
 * `commercialOk` is read from the JUSTTCG_COMMERCIAL flag (set it true only on a
 * Pro/Business plan whose terms permit a public surface). It should also be
 * mirrored into sources.commercial_ok so any public API gate reads one column.
 */
import { SourceRegistry, JustTCGSource } from './adapter.js';

export function buildRegistry(env: NodeJS.ProcessEnv = process.env): SourceRegistry {
  const registry = new SourceRegistry();

  const justTcgKey = env.JUSTTCG_API_KEY?.trim();
  if (justTcgKey) {
    registry.register(
      new JustTCGSource({
        apiKey: justTcgKey,
        commercialOk: env.JUSTTCG_COMMERCIAL === 'true',
        requestsPerSecond: env.JUSTTCG_RPS ? Number(env.JUSTTCG_RPS) : 2,
      }),
    );
  }

  return registry;
}

/** True when at least one price source is configured. Callers show an empty
 *  state naming JUSTTCG_API_KEY when this is false. */
export function hasAnySource(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.JUSTTCG_API_KEY?.trim());
}
