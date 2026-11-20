// /helper (spec 9.2): pair, log in, register, then either help from this device (Web Worker) or show the runner command.
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';
import {
  EV, WORK_UNITS, bytesToHex, hexToBytes, receiptMessage,
  type EarningsUpdate, type HelperCaps, type Job, type JobResult, type JobType, type RegisterHelperResponse,
} from '@sidekick/shared';
import { PRIVY_APP_ID, SERVER_URL, getJson, postJson } from '../env';
import type { PrivyIdentity } from './PrivyLogin';

const PrivyLogin = lazy(() => import('./PrivyLogin'));

const q = new URLSearchParams(window.location.search);
const ROOM = q.get('room') ?? '';
const SECRET = q.get('s') ?? '';
const PHONE_JOBS: JobType[] = ['pathfind', 'areagen', 'simtick'];

function helperKey(): { publicKey: string; secretKey: string } {
  const k = 'sidekick.helperKey';
  try {
    const s = localStorage.getItem(k);
    if (s) return JSON.parse(s);
  } catch {
    /* ignore */
  }
  const kp = nacl.sign.keyPair();
  const v = { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.secretKey) };
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
  return v;
}

type Reg = RegisterHelperResponse & { displayName: string; kind: 'laptop' | 'phone' };
const regKey = `sidekick.reg.${ROOM}`;

function loadReg(): Reg | null {
  try {
    const s = localStorage.getItem(regKey);
    return s ? (JSON.parse(s) as Reg) : null;
  } catch {
    return null;
  }
}

export default function HelperPage() {
  const [identity, setIdentity] = useState<{ email: string; wallet?: string } | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [reg, setReg] = useState<Reg | null>(loadReg);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const onPrivy = useCallback((id: PrivyIdentity) => setIdentity({ email: id.email, wallet: id.wallet }), []);

  async function register(kind: 'laptop' | 'phone') {
    const id = identity ?? { email };
    if (!displayName.trim()) return setErr('Pick a display name');
    if (!id.wallet && !id.email.trim()) return setErr('Enter your email');
    setBusy(true);
    setErr('');
    try {
      const r = await postJson<RegisterHelperResponse>('/api/helpers/register', {
        roomCode: ROOM,
        pairSecret: SECRET,
        wallet: id.wallet || undefined,
        email: id.email || undefined,
        displayName: displayName.trim(),
        kind,
        helperPubKey: helperKey().publicKey,
      });
      const v: Reg = { ...r, displayName: displayName.trim(), kind };
      try {
        localStorage.setItem(regKey, JSON.stringify(v));
      } catch {
        /* ignore */
      }
      setReg(v);
    } catch (e) {
      setErr(`Could not register: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!ROOM || !SECRET)
    return (
      <div className="helper-page">
        <h1>Sidekick</h1>
        <p>Scan the QR code on the game screen to pair this device with a room.</p>
      </div>
    );

  if (reg) return <Helping reg={reg} onSignOut={() => { localStorage.removeItem(regKey); setReg(null); }} />;

  return (
    <div className="helper-page">
      <h1>Help Lanternfall</h1>
      <p className="dim">Room <b>{ROOM}</b>. Lend this device's spare compute and earn devnet USDC per unit of work.</p>
      {PRIVY_APP_ID ? (
        identity ? (
          <p>Signed in as <b>{identity.email || 'you'}</b></p>
        ) : (
          <Suspense fallback={<div className="dim">Loading login…</div>}>
            <PrivyLogin onLogin={onPrivy} />
          </Suspense>
        )
      ) : (
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <span className="dim small">Demo custodial mode: the server holds a devnet wallet for your email.</span>
        </label>
      )}
      <label>
        Display name
        <input value={displayName} maxLength={40} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Marcus" />
      </label>
      {err && <div className="warn">{err}</div>}
      <div className="buttons">
        <button className="big" disabled={busy || (!!PRIVY_APP_ID && !identity)} onClick={() => register('phone')}>
          Use this device as a helper
        </button>
        <button className="big secondary" disabled={busy || (!!PRIVY_APP_ID && !identity)} onClick={() => register('laptop')}>
          I have a laptop (run the Node runner)
        </button>
      </div>
    </div>
  );
}

interface Mine { units: number; usdc: number; rank: number }

function Helping({ reg, onSignOut }: { reg: Reg; onSignOut: () => void }) {
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [mine, setMine] = useState<Mine>({ units: 0, usdc: 0, rank: 0 });
  const [done, setDone] = useState<Record<string, number>>({});
  const [lastJob, setLastJob] = useState('');
  const [wake, setWake] = useState('');
  const [copied, setCopied] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const applyEarnings = useCallback(
    (e: EarningsUpdate) => {
      const h = e.helpers?.find((x) => x.helperId === reg.helperId);
      if (h) setMine({ units: h.units, usdc: h.usdc, rank: h.rank });
    },
    [reg.helperId],
  );

  useEffect(() => {
    getJson<EarningsUpdate>(`/api/earnings?room=${encodeURIComponent(ROOM)}`).then(applyEarnings).catch(() => undefined);
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    const key = helperKey();
    let workers: Worker[] = [];
    const busyCount: number[] = [];
    const waiting = new Map<string, { job: Job; w: number }>();

    if (reg.kind === 'phone') {
      const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      workers = Array.from({ length: n }, (_, i) => {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        busyCount[i] = 0;
        w.onmessage = (ev: MessageEvent<{ jobId: string; ok: boolean; output?: unknown; outputHash?: string; computeMs?: number; error?: string }>) => {
          const m = ev.data;
          const p = waiting.get(m.jobId);
          if (!p) return;
          waiting.delete(m.jobId);
          busyCount[p.w]--;
          const type = p.job.type;
          const workUnits = WORK_UNITS[type];
          const outputHash = m.outputHash ?? '';
          const helperSig = bytesToHex(nacl.sign.detached(receiptMessage(m.jobId, type, workUnits, outputHash), hexToBytes(key.secretKey)));
          const result: JobResult = {
            jobId: m.jobId, helperId: reg.helperId, type, ok: m.ok, error: m.error, output: m.output,
            outputHash, workUnits, computeMs: m.computeMs ?? 0, helperSig,
          };
          socket.emit(EV.JOB_RESULT, result);
          if (m.ok) setDone((d) => ({ ...d, [type]: (d[type] ?? 0) + 1 }));
          setLastJob(`${type} in ${(m.computeMs ?? 0).toFixed(0)} ms`);
        };
        return w;
      });
      socket.on(EV.JOB_ASSIGN, (job: Job) => {
        if (job.type === 'dialogue') return;
        let best = 0;
        for (let i = 1; i < workers.length; i++) if (busyCount[i] < busyCount[best]) best = i;
        busyCount[best]++;
        waiting.set(job.jobId, { job, w: best });
        workers[best].postMessage({ jobId: job.jobId, type: job.type, input: job.input });
      });
    }

    socket.on('connect', () => {
      setConnected(true);
      if (reg.kind === 'phone') {
        const caps: HelperCaps = {
          kind: 'phone', jobTypes: PHONE_JOBS, cpuThreads: navigator.hardwareConcurrency || 1, ollama: false, displayName: reg.displayName,
        };
        socket.emit(EV.HELPER_HELLO, { helperToken: reg.helperToken, caps }, (ack?: { ok: boolean; error?: string }) => {
          if (ack && !ack.ok) console.warn('helper:hello rejected', ack.error);
        });
      } else {
        socket.emit('helper:watch', { helperToken: reg.helperToken });
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on(EV.EARNINGS_UPDATE, applyEarnings);
    socket.on(EV.HELPER_PAUSED, (p: { paused: boolean }) => setPaused(!!p.paused));

    // Screen Wake Lock keeps the phone helping while the screen is on.
    let lock: { release: () => Promise<void> } | null = null;
    const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    const requestLock = () => {
      if (reg.kind !== 'phone' || !wl) return;
      wl.request('screen').then((l) => { lock = l; setWake('screen kept awake'); }).catch(() => setWake('wake lock unavailable'));
    };
    requestLock();
    const onVis = () => document.visibilityState === 'visible' && requestLock();
    document.addEventListener('visibilitychange', onVis);

    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => undefined);
      workers.forEach((w) => w.terminate());
      socket.close();
    };
  }, [reg, applyEarnings]);

  const totalDone = Object.values(done).reduce((a, b) => a + b, 0);
  return (
    <div className="helper-page">
      <div className={`status-big ${connected && !paused ? 'on' : ''}`}>
        {paused ? 'Paused by admin' : connected ? 'Helping Lanternfall' : 'Connecting…'}
      </div>
      <h2>{reg.displayName}</h2>
      <div className="grid2">
        <div className="metric"><span>Work units</span><b>{mine.units}</b></div>
        <div className="metric"><span>Earned</span><b>{mine.usdc.toFixed(4)} USDC</b></div>
        <div className="metric"><span>Rank</span><b>{mine.rank ? `#${mine.rank}` : '—'}</b></div>
        <div className="metric"><span>Jobs done</span><b>{totalDone}</b></div>
      </div>
      {reg.kind === 'phone' ? (
        <>
          <div className="row">
            {PHONE_JOBS.map((t) => (
              <span key={t} className="tag">{t}: {done[t] ?? 0}</span>
            ))}
          </div>
          {lastJob && <div className="dim">last: {lastJob}</div>}
          {wake && <div className="dim small">{wake}</div>}
        </>
      ) : (
        <div className="runner">
          <p>Run this on your laptop to start helping:</p>
          <pre>{reg.runnerCommand}</pre>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(reg.runnerCommand).then(() => setCopied(true)).catch(() => undefined);
            }}
          >
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </div>
      )}
      <div className="dim small">Wallet {reg.wallet.slice(0, 6)}…{reg.wallet.slice(-4)} · earnings are read from on-chain settlements (QuickNode Stream)</div>
      <button className="link" onClick={onSignOut}>Sign out of this room</button>
    </div>
  );
}
