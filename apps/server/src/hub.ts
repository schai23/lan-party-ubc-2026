// Socket.IO relay and job routing (spec 8.3).
import {
  EV, HelperCapsSchema, JobResultSchema, JobSchema, WORK_UNITS, receiptMessage, verifyMessage,
  type HelperCaps, type Job, type JobResult, type RosterEntry,
} from '@sidekick/shared';
import type { Server, Socket } from 'socket.io';
import type { DB, HelperRow, ReceiptRow, RoomRow } from './db';
import { earningsFor, type OnlineInfo } from './status';

interface OnlineHelper {
  helperId: string;
  roomCode: string;
  displayName: string;
  pubkey: string;
  caps: HelperCaps;
  socket: Socket;
  inflight: number;
  paused: boolean;
}

interface PendingJob {
  job: Job;
  helperId: string;
  gameSocketId: string;
  receivedAt: number;
  timer: NodeJS.Timeout;
}

const gameChan = (room: string) => `game:${room}`;
const helpersChan = (room: string) => `helpers:${room}`;
const helperChan = (id: string) => `helper:${id}`;

export class Hub {
  online = new Map<string, OnlineHelper>(); // by helperId
  pending = new Map<string, PendingJob>();

  constructor(public db: DB, public io: Server) {
    io.on('connection', (s) => this.onConnection(s));
  }

  onlineInfo(): OnlineInfo[] {
    return [...this.online.values()].map((h) => ({
      helperId: h.helperId, displayName: h.displayName, kind: h.caps.kind, jobTypes: h.caps.jobTypes,
      inflight: h.inflight, paused: h.paused, roomCode: h.roomCode,
    }));
  }

  roster(roomCode: string): RosterEntry[] {
    return [...this.online.values()]
      .filter((h) => h.roomCode === roomCode)
      .map((h) => ({ helperId: h.helperId, displayName: h.displayName, caps: h.caps, busy: h.inflight > 0, paused: h.paused, inflight: h.inflight }));
  }

  broadcastRoster(roomCode: string) {
    this.io.to(gameChan(roomCode)).emit(EV.ROOM_ROSTER, { helpers: this.roster(roomCode) });
  }

  broadcastEarnings(roomCode: string, latestSig?: string) {
    const upd = earningsFor(this.db, roomCode, latestSig);
    this.io.to(gameChan(roomCode)).to(helpersChan(roomCode)).emit(EV.EARNINGS_UPDATE, upd);
  }

  setPaused(helperId: string, paused: boolean) {
    this.db.prepare('UPDATE helpers SET paused = ? WHERE id = ?').run(paused ? 1 : 0, helperId);
    const h = this.online.get(helperId);
    if (h) {
      h.paused = paused;
      this.broadcastRoster(h.roomCode);
    }
    this.io.to(helperChan(helperId)).emit(EV.HELPER_PAUSED, { paused });
  }

  private log(jobId: string, type: string, helperId: string | null, ok: boolean, computeMs: number | null, latencyMs: number | null) {
    this.db.prepare('INSERT INTO job_log (job_id, type, helper_id, ok, compute_ms, latency_ms, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(jobId, type, helperId, ok ? 1 : 0, computeMs, latencyMs, Date.now());
  }

  /** Dialogue -> laptop with Ollama, least inflight. Others -> least inflight, laptops before phones on ties. */
  pick(job: Job): OnlineHelper | undefined {
    const eligible = [...this.online.values()].filter(
      (h) => h.roomCode === job.roomCode && !h.paused && h.caps.jobTypes.includes(job.type) &&
        (job.type !== 'dialogue' || (h.caps.kind === 'laptop' && h.caps.ollama)),
    );
    eligible.sort((a, b) => a.inflight - b.inflight || (a.caps.kind === b.caps.kind ? 0 : a.caps.kind === 'laptop' ? -1 : 1));
    return eligible[0];
  }

  private finish(jobId: string): PendingJob | undefined {
    const p = this.pending.get(jobId);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    const h = this.online.get(p.helperId);
    if (h) {
      h.inflight = Math.max(0, h.inflight - 1);
      this.broadcastRoster(h.roomCode);
    }
    return p;
  }

  private fail(jobId: string, reason: string, logComputeMs: number | null = null) {
    const p = this.finish(jobId);
    if (!p) return;
    this.io.to(p.gameSocketId).emit(EV.JOB_FAILED, { jobId, reason });
    this.log(jobId, p.job.type, p.helperId, false, logComputeMs, Date.now() - p.receivedAt);
  }

  private onConnection(s: Socket) {
    let gameRoom: string | null = null;
    let helperId: string | null = null;

    // ---------- game ----------
    s.on(EV.ROOM_JOIN, (p: { roomCode?: string; gamePubKey?: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
      const room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(String(p?.roomCode ?? '').toUpperCase()) as RoomRow | undefined;
      if (!room) return ack?.({ ok: false, error: 'unknown room' });
      if (!p.gamePubKey || !/^[0-9a-f]{64}$/i.test(p.gamePubKey)) return ack?.({ ok: false, error: 'bad gamePubKey' });
      this.db.prepare('UPDATE rooms SET game_pubkey = ? WHERE code = ?').run(p.gamePubKey.toLowerCase(), room.code);
      gameRoom = room.code;
      s.join(gameChan(room.code));
      ack?.({ ok: true });
      s.emit(EV.ROOM_ROSTER, { helpers: this.roster(room.code) });
      s.emit(EV.EARNINGS_UPDATE, earningsFor(this.db, room.code));
    });

    s.on(EV.JOB_SUBMIT, (raw: unknown) => {
      const parsed = JobSchema.safeParse(raw);
      const jobId = (raw as any)?.jobId ?? 'unknown';
      if (!parsed.success) return s.emit(EV.JOB_FAILED, { jobId, reason: 'error' });
      const job = parsed.data;
      job.roomCode = job.roomCode.toUpperCase();
      const helper = this.pick(job);
      if (!helper) {
        s.emit(EV.JOB_FAILED, { jobId: job.jobId, reason: 'no-helper' });
        this.log(job.jobId, job.type, null, false, null, 0);
        return;
      }
      const timer = setTimeout(() => this.fail(job.jobId, 'timeout'), job.deadlineMs);
      this.pending.set(job.jobId, { job, helperId: helper.helperId, gameSocketId: s.id, receivedAt: Date.now(), timer });
      helper.inflight++;
      helper.socket.emit(EV.JOB_ASSIGN, job);
      this.broadcastRoster(helper.roomCode);
    });

    s.on(EV.RECEIPT_COUNTERSIGN, (p: { jobId?: string; gameSig?: string }) => {
      if (!p?.jobId || !p.gameSig) return;
      const r = this.db.prepare('SELECT * FROM receipts WHERE job_id = ?').get(p.jobId) as ReceiptRow | undefined;
      if (!r || r.game_sig) return;
      const h = this.db.prepare('SELECT room_code FROM helpers WHERE id = ?').get(r.helper_id) as { room_code: string } | undefined;
      const room = h && (this.db.prepare('SELECT game_pubkey FROM rooms WHERE code = ?').get(h.room_code) as { game_pubkey: string | null } | undefined);
      if (!room?.game_pubkey) return;
      const msg = receiptMessage(r.job_id, r.type as any, r.work_units, r.output_hash);
      if (!verifyMessage(msg, p.gameSig, room.game_pubkey)) {
        console.warn(`[receipt] bad game countersignature for ${p.jobId}`);
        return;
      }
      this.db.prepare('UPDATE receipts SET game_sig = ? WHERE job_id = ?').run(p.gameSig, p.jobId);
    });

    // ---------- helper ----------
    const attachHelper = (token: string): HelperRow | undefined =>
      this.db.prepare('SELECT * FROM helpers WHERE token = ?').get(token) as HelperRow | undefined;

    s.on(EV.HELPER_HELLO, (p: { helperToken?: string; caps?: unknown; helperPubKey?: string }, ack?: (r: { ok: boolean; helperId?: string; error?: string }) => void) => {
      const row = p?.helperToken ? attachHelper(p.helperToken) : undefined;
      if (!row) return ack?.({ ok: false, error: 'unknown helper token' });
      const caps = HelperCapsSchema.safeParse(p.caps);
      if (!caps.success) return ack?.({ ok: false, error: 'bad caps: ' + caps.error.message });
      // The runner keeps its own key (~/.sidekick/helper-key.json) and registers it through the token here.
      if (p.helperPubKey && /^[0-9a-f]{64}$/i.test(p.helperPubKey) && p.helperPubKey.toLowerCase() !== row.helper_pubkey) {
        this.db.prepare('UPDATE helpers SET helper_pubkey = ? WHERE id = ?').run(p.helperPubKey.toLowerCase(), row.id);
        row.helper_pubkey = p.helperPubKey.toLowerCase();
      }
      this.db.prepare('UPDATE helpers SET caps_json = ? WHERE id = ?').run(JSON.stringify(caps.data), row.id);
      const prev = this.online.get(row.id);
      if (prev && prev.socket.id !== s.id) prev.socket.disconnect(true);
      helperId = row.id;
      this.online.set(row.id, {
        helperId: row.id, roomCode: row.room_code, displayName: row.display_name, pubkey: row.helper_pubkey,
        caps: caps.data, socket: s, inflight: 0, paused: !!row.paused,
      });
      s.join(helperChan(row.id));
      s.join(helpersChan(row.room_code));
      ack?.({ ok: true, helperId: row.id });
      s.emit(EV.HELPER_PAUSED, { paused: !!row.paused });
      s.emit(EV.EARNINGS_UPDATE, earningsFor(this.db, row.room_code));
      this.broadcastRoster(row.room_code);
      console.log(`[hub] helper online: ${row.display_name} (${caps.data.kind}, ${caps.data.jobTypes.join(',')}) room ${row.room_code}`);
    });

    s.on('helper:watch', (p: { helperToken?: string }, ack?: (r: { ok: boolean; helperId?: string }) => void) => {
      const row = p?.helperToken ? attachHelper(p.helperToken) : undefined;
      if (!row) return ack?.({ ok: false });
      s.join(helperChan(row.id));
      s.join(helpersChan(row.room_code));
      ack?.({ ok: true, helperId: row.id });
      s.emit(EV.HELPER_PAUSED, { paused: !!row.paused });
      s.emit(EV.EARNINGS_UPDATE, earningsFor(this.db, row.room_code));
    });

    s.on(EV.JOB_CHUNK, (p: { jobId?: string; text?: string }) => {
      const pj = p?.jobId ? this.pending.get(p.jobId) : undefined;
      if (!pj || pj.helperId !== helperId) return;
      this.io.to(pj.gameSocketId).emit(EV.JOB_CHUNK, { jobId: p.jobId, text: String(p.text ?? '') });
    });

    s.on(EV.JOB_RESULT, (raw: unknown) => {
      const parsed = JobResultSchema.safeParse(raw);
      if (!parsed.success) {
        const jid = (raw as any)?.jobId;
        if (jid && this.pending.get(jid)?.helperId === helperId) this.fail(jid, 'error');
        return;
      }
      const res: JobResult = { ...parsed.data, helperId: helperId! };
      const pj = this.pending.get(res.jobId);
      if (!pj || pj.helperId !== helperId) return; // late (timed out) or not ours: ignore
      const h = this.online.get(helperId!);
      if (!res.ok) return this.fail(res.jobId, res.error ? `error: ${res.error}` : 'error', res.computeMs);
      const units = WORK_UNITS[pj.job.type];
      const msg = receiptMessage(res.jobId, pj.job.type, res.workUnits, res.outputHash);
      if (res.type !== pj.job.type || res.workUnits !== units || !h || !verifyMessage(msg, res.helperSig, h.pubkey)) {
        console.warn(`[hub] rejected result ${res.jobId} from ${h?.displayName}: bad signature or work units`);
        return this.fail(res.jobId, 'error: bad-signature', res.computeMs);
      }
      this.finish(res.jobId);
      this.db.prepare(
        'INSERT OR IGNORE INTO receipts (job_id, helper_id, type, work_units, output_hash, helper_sig, game_sig, created_at, settled_tx) VALUES (?,?,?,?,?,?,NULL,?,NULL)',
      ).run(res.jobId, res.helperId, res.type, res.workUnits, res.outputHash, res.helperSig, Date.now());
      this.log(res.jobId, res.type, res.helperId, true, res.computeMs, Date.now() - pj.receivedAt);
      this.io.to(pj.gameSocketId).emit(EV.JOB_RESULT, res);
    });

    s.on('disconnect', () => {
      if (helperId) {
        const h = this.online.get(helperId);
        if (h && h.socket.id === s.id) {
          this.online.delete(helperId);
          for (const [jid, pj] of this.pending) if (pj.helperId === helperId) this.fail(jid, 'error: helper disconnected');
          this.broadcastRoster(h.roomCode);
          console.log(`[hub] helper offline: ${h.displayName}`);
        }
      }
      void gameRoom;
    });
  }
}
