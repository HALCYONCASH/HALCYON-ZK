// Data hooks: the config once, a fetch with a refresh interval, the document title.
import { useEffect, useState } from 'react';
import { api, type Config } from './api';

let configPromise: Promise<Config> | null = null; let configValue: Config | null = null;
export function loadConfig() { if (!configPromise) configPromise = api.config().then(c => { configValue = c; return c; }); return configPromise; }
export function useConfig(): Config | null { const [c, set] = useState<Config | null>(configValue); useEffect(() => { loadConfig().then(set).catch(() => {}); }, []); return c; }
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[], every = 0): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [n, setN] = useState(0);
  useEffect(() => { let alive = true; const run = () => fn().then(d => { if (alive) { setData(d); setError(''); } }).catch(e => { if (alive) setError(String(e.message || e)); }); run(); const id = every ? setInterval(run, every) : 0; return () => { alive = false; if (id) clearInterval(id); }; }, [...deps, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setN(x => x + 1) };
}
export function useTitle(t: string) { useEffect(() => { document.title = t; }, [t]); }
