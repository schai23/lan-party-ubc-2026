// Browser-side config. Never import '@sidekick/shared/config' here (Node only).
export const SERVER_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined) || window.location.origin;
export const PRIVY_APP_ID: string = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) || '';
export const LOCAL_OLLAMA_URL: string =
  (import.meta.env.VITE_LOCAL_OLLAMA_URL as string | undefined) || 'http://localhost:11434';

export const api = (path: string) => `${SERVER_URL.replace(/\/$/, '')}${path}`;

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(api(path));
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return (await r.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text().catch(() => '')}`);
  return (await r.json()) as T;
}

/** /play URL parameters (spec 9.4). Workload sizes are the only performance knobs. */
function parseSize(v: string | null, dw: number, dh: number): [number, number] {
  if (!v) return [dw, dh];
  const m = /^(\d+)x(\d+)$/i.exec(v.trim());
  return m ? [Math.max(32, +m[1]), Math.max(32, +m[2])] : [dw, dh];
}

export function readPlayParams() {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const [gridW, gridH] = parseSize(q.get('grid'), 384, 288);
  const [areaW, areaH] = parseSize(q.get('areaSize'), 512, 384);
  return {
    villagers: Math.floor(num('villagers', 2500)),
    gridW,
    gridH,
    targets: Math.min(32, Math.max(1, Math.floor(num('targets', 8)))),
    recomputeMs: num('recomputeMs', 250),
    areaW,
    areaH,
    model: q.get('model') || 'llama3.1:8b',
    /** Pathfind job deadline (ms). Flow fields are ~1.3 MB at defaults, so the spec's 400 ms is too tight on Wi-Fi. */
    pathfindDeadlineMs: num('pathfindDeadlineMs', 1000),
  };
}
export type PlayParams = ReturnType<typeof readPlayParams>;
