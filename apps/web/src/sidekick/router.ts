// Sidekick router (spec 9.1): decides remote vs local per job.
// Remote: job:submit -> helper -> job:result (countersigned with the room keypair).
// Local: the same @sidekick/jobs function, run SYNCHRONOUSLY on the main thread (the honest naive baseline).
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';
import QRCode from 'qrcode';
import {
  DEADLINES_MS, EV, bytesToHex, explorerTx, receiptMessage,
  type CreateRoomResponse, type Dispatch, type EarningsUpdate, type IntegrationStatus, type Job, type JobFailedPayload,
  type JobChunkPayload, type JobResult, type JobType, type RosterEntry,
} from '@sidekick/shared';
import { runJob } from '@sidekick/jobs';
type ComputeJobType = Exclude<JobType, 'dialogue'>;
import { SERVER_URL, getJson, postJson, readPlayParams } from '../env';
import { recordMainThreadJob, store } from './store';
import { playCoin } from '../play/audio';

type Input = Job['input'];

interface Pending {
  type: JobType;
  start: number;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
  onChunk?: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RunOutcome<T> { output: T; where: 'remote' | 'local'; ms: number }

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class Router {
  /** Per-type deadlines: spec defaults, except pathfind which comes from ?pathfindDeadlineMs (default 1000). */
  readonly deadlines: Record<JobType, number> = { ...DEADLINES_MS, pathfind: readPlayParams().pathfindDeadlineMs };
  socket: Socket | null = null;
  readonly keypair = nacl.sign.keyPair(); // room keypair, generated on load
  readonly gamePubKey = bytesToHex(this.keypair.publicKey);
  private pending = new Map<string, Pending>();
  /** At most one remote pathfind in flight; ticks are skipped while it is outstanding. */
  pathfindInFlight = false;
  dispatchListeners: ((d: Dispatch) => void)[] = [];

  async start() {
    this.loadIntegrations();
    this.loadDispatch();
    try {
      const room = await postJson<CreateRoomResponse>('/api/rooms', {});
      store.roomCode = room.roomCode;
      store.pairUrl = room.pairUrl;
      store.qrDataUrl = await QRCode.toDataURL(room.pairUrl, { margin: 1, width: 320 });
      this.connect(room.roomCode);
      getJson<EarningsUpdate>(`/api/earnings?room=${encodeURIComponent(room.roomCode)}`)
        .then((e) => this.applyEarnings(e, false))
        .catch(() => undefined);
    } catch (e) {
      store.online = false;
      store.offlineReason = 'offline, local only';
      console.warn('[router] POST /api/rooms failed, running local only', e);
    }
  }

  private async loadIntegrations() {
    try {
      const r = await getJson<{ integrations: IntegrationStatus[]; voice: 'elevenlabs' | 'browser'; solanaConfigured: boolean }>(
        '/api/integrations',
      );
      store.integrations = r.integrations ?? [];
      store.voice = r.voice === 'elevenlabs' ? 'elevenlabs' : 'browser';
      store.solanaConfigured = !!r.solanaConfigured;
      store.integrationsLoaded = true;
    } catch {
      store.voice = 'browser';
      store.integrationsLoaded = false;
    }
  }

  private async loadDispatch() {
    try {
      const d = await getJson<Dispatch>('/api/dispatch/current');
      if (d && d.worldEvent) this.setDispatch(d);
    } catch {
      /* default dispatch from the scene stays in effect */
    }
  }

  setDispatch(d: Dispatch) {
    store.dispatch = d;
    for (const l of this.dispatchListeners) l(d);
  }

  private connect(roomCode: string) {
    const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    this.socket = socket;
    socket.on('connect', () => {
      socket.emit(EV.ROOM_JOIN, { roomCode, gamePubKey: this.gamePubKey }, (r?: { ok: boolean; error?: string }) => {
        if (r && !r.ok) console.warn('[router] room:join failed', r.error);
      });
      store.online = true;
      store.offlineReason = '';
    });
    socket.on('disconnect', () => {
      store.online = false;
      store.offlineReason = 'server disconnected, local only';
      store.helpers = [];
      this.failAll('disconnect');
    });
    socket.on(EV.ROOM_ROSTER, (p: { helpers: RosterEntry[] }) => {
      store.helpers = p.helpers ?? [];
    });
    socket.on(EV.JOB_CHUNK, (p: JobChunkPayload) => this.pending.get(p.jobId)?.onChunk?.(p.text));
    socket.on(EV.JOB_RESULT, (r: JobResult) => this.onResult(r));
    socket.on(EV.JOB_FAILED, (p: JobFailedPayload) => this.onFailed(p.jobId, p.reason));
    socket.on(EV.EARNINGS_UPDATE, (e: EarningsUpdate) => this.applyEarnings(e, true));
    socket.on(EV.DISPATCH_UPDATE, (d: Dispatch) => this.setDispatch(d));
  }

  private applyEarnings(e: EarningsUpdate, chime: boolean) {
    store.earnings = e;
    if (typeof e.solanaConfigured === 'boolean') store.solanaConfigured = e.solanaConfigured;
    if (e.latest) {
      const l = e.latest;
      if (!store.settlements.some((s) => s.signature === l.signature)) {
        store.settlements.unshift({
          signature: l.signature,
          units: l.units,
          usdc: l.amount / 1e6,
          name: l.displayName ?? l.helperWallet.slice(0, 6),
          explorerUrl: l.explorerUrl || explorerTx(l.signature),
          at: Date.now(),
        });
        store.settlements.length = Math.min(store.settlements.length, 8);
      }
      if (chime) playCoin();
    }
  }

  /** True if a linked, unpaused helper advertises this job type and we are not forced local. */
  canRemote(type: JobType): boolean {
    if (store.forceLocal || !store.online || !this.socket?.connected || !store.roomCode) return false;
    return store.helpers.some((h) => !h.paused && h.caps.jobTypes.includes(type));
  }

  /** Submit remotely. Rejects on job:failed / disconnect so the caller can fall back to local. */
  submitRemote(type: JobType, input: Input, onChunk?: (text: string) => void): Promise<JobResult> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('no socket'));
    const job: Job = { jobId: uuid(), roomCode: store.roomCode, type, createdAt: Date.now(), deadlineMs: this.deadlines[type], input };
    return new Promise<JobResult>((resolve, reject) => {
      // Safety net only (the server owns the real deadline): if the server never answers, fail over.
      const timer = setTimeout(() => this.onFailed(job.jobId, 'client-timeout'), this.deadlines[type] + 3000);
      this.pending.set(job.jobId, { type, start: performance.now(), resolve, reject, onChunk, timer });
      socket.emit(EV.JOB_SUBMIT, job);
    });
  }

  private onResult(r: JobResult) {
    const p = this.pending.get(r.jobId);
    if (!p) return; // late or unknown
    this.pending.delete(r.jobId);
    clearTimeout(p.timer);
    if (!r.ok) {
      p.reject(new Error(r.error || 'helper error'));
      return;
    }
    // Countersign the receipt with the room keypair.
    const msg = receiptMessage(r.jobId, r.type, r.workUnits, r.outputHash);
    const gameSig = bytesToHex(nacl.sign.detached(msg, this.keypair.secretKey));
    this.socket?.emit(EV.RECEIPT_COUNTERSIGN, { jobId: r.jobId, gameSig });
    const ms = performance.now() - p.start;
    const s = store.stats[p.type];
    s.remote++;
    s.lastRemoteMs = ms;
    s.remoteMsSum += ms;
    p.resolve(r);
  }

  private onFailed(jobId: string, reason: string) {
    const p = this.pending.get(jobId);
    if (!p) return;
    this.pending.delete(jobId);
    clearTimeout(p.timer);
    store.stats[p.type].remoteFailed++;
    p.reject(new Error(`job failed: ${reason}`));
  }

  private failAll(reason: string) {
    for (const id of [...this.pending.keys()]) this.onFailed(id, reason);
  }

  /** Run a CPU job synchronously on the main thread and measure it. */
  runLocal<T>(type: ComputeJobType, input: Input): RunOutcome<T> {
    const t0 = performance.now();
    const r = runJob(type, input);
    const ms = performance.now() - t0;
    recordMainThreadJob(ms);
    const s = store.stats[type];
    s.local++;
    s.lastLocalMs = ms;
    return { output: r.output as T, where: 'local', ms };
  }

  /** Remote if possible, otherwise (or on failure) local on the main thread. */
  async run<T>(type: ComputeJobType, input: Input): Promise<RunOutcome<T>> {
    if (this.canRemote(type)) {
      const t0 = performance.now();
      try {
        const r = await this.submitRemote(type, input);
        return { output: r.output as T, where: 'remote', ms: performance.now() - t0 };
      } catch (e) {
        console.info(`[router] ${type} remote failed (${(e as Error).message}); running locally`);
      }
    }
    return this.runLocal<T>(type, input);
  }

  recordLocalDialogue(ms: number) {
    const s = store.stats.dialogue;
    s.local++;
    s.lastLocalMs = ms;
  }
}

export const router = new Router();
