// Mutable state shared between the Phaser scene, the router and the React panels.
// React polls this (the panel re-renders a few times per second); nothing here slows the game down.
import type { Dispatch, EarningsUpdate, IntegrationStatus, JobType, RosterEntry, SimtickOutput } from '@sidekick/shared';

export interface TypeStats {
  remote: number;
  local: number;
  lastRemoteMs: number; // round-trip latency of the last remote job
  remoteMsSum: number; // for the average round trip
  remoteFailed: number; // job:failed (timeout / no-helper / error) that fell back to local
  lastLocalMs: number; // main-thread duration of the last local job
}

export interface Settlement { signature: string; units: number; usdc: number; name: string; explorerUrl: string; at: number }

export const store = {
  online: false,
  offlineReason: '' as string,
  roomCode: '' as string,
  pairUrl: '' as string,
  qrDataUrl: '' as string,
  helpers: [] as RosterEntry[],
  forceLocal: false,
  panelVisible: true,
  stats: {
    dialogue: { remote: 0, local: 0, lastRemoteMs: 0, remoteMsSum: 0, remoteFailed: 0, lastLocalMs: 0 },
    pathfind: { remote: 0, local: 0, lastRemoteMs: 0, remoteMsSum: 0, remoteFailed: 0, lastLocalMs: 0 },
    areagen: { remote: 0, local: 0, lastRemoteMs: 0, remoteMsSum: 0, remoteFailed: 0, lastLocalMs: 0 },
    simtick: { remote: 0, local: 0, lastRemoteMs: 0, remoteMsSum: 0, remoteFailed: 0, lastLocalMs: 0 },
  } as Record<JobType, TypeStats>,
  /** (timestamp, ms) of synchronous job work on the main thread. */
  mainThreadJobs: [] as { t: number; ms: number }[],
  /** Frame times (timestamp, ms) for the last 5 s. */
  frames: [] as { t: number; ms: number }[],
  ttfaMs: null as number | null,
  ttfaSource: '' as string,
  voice: 'elevenlabs' as 'elevenlabs' | 'browser',
  integrations: [] as IntegrationStatus[],
  integrationsLoaded: false,
  solanaConfigured: false,
  dispatch: null as Dispatch | null,
  earnings: null as EarningsUpdate | null,
  settlements: [] as Settlement[],
  sim: null as SimtickOutput | null,
  simTick: 0,
  areaStatus: 'not requested' as string,
  inArea: false,
  dialogue: { npcId: '' as string, npcName: '' as string, text: '', player: '', status: '' as string, source: '' as string },
  nearNpc: null as null | { id: string; name: string },
  listening: false,
};

export function recordMainThreadJob(ms: number) {
  const t = performance.now();
  store.mainThreadJobs.push({ t, ms });
  while (store.mainThreadJobs.length && store.mainThreadJobs[0].t < t - 1000) store.mainThreadJobs.shift();
}

export function mainThreadJobMsLastSecond(): number {
  const t = performance.now();
  let s = 0;
  for (const j of store.mainThreadJobs) if (j.t >= t - 1000) s += j.ms;
  return s;
}

export function recordFrame(ms: number) {
  const t = performance.now();
  store.frames.push({ t, ms });
  while (store.frames.length && store.frames[0].t < t - 5000) store.frames.shift();
}

export function frameStats() {
  const f = store.frames;
  if (!f.length) return { fps: 0, avg: 0, p95: 0 };
  let sum = 0;
  for (const x of f) sum += x.ms;
  const sorted = f.map((x) => x.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const span = (f[f.length - 1].t - f[0].t) / 1000;
  return { fps: span > 0 ? (f.length - 1) / span : 0, avg: sum / f.length, p95 };
}
