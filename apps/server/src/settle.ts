// Settlement loop (spec 8.4). Every 5 s, per helper: if >= 10 ready receipts or the oldest is >= 60 s old,
// send settle(session_id, units, receipts_root) signed by the settler. Never writes `settlements`
// (only the QuickNode webhook does). Without Solana keys it logs "would settle" once per batch.
import { merkleRoot, receiptMessage, type JobType } from '@sidekick/shared';
import { cfg } from '@sidekick/shared/config';
import type { DB, HelperRow, ReceiptRow, RoomRow } from './db';
import { solana } from './solana';

const BATCH_MIN = 10;
const MAX_AGE_MS = 60_000;

export class Settler {
  private busy = new Set<string>(); // helper ids with a settle in flight
  private loggedBatches = new Set<string>();
  private roomLocks = new Map<string, Promise<unknown>>();
  /** Local tally of amounts sent per session (the webhook confirms them later). */
  private spentLocal = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(private db: DB) {}

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => console.warn('[settle] tick failed:', e.message)), 5_000);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** Serialize Solana work per room (open_session must land before register/settle). */
  withRoom<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.roomLocks.get(code) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.roomLocks.set(code, next.catch(() => {}));
    return next;
  }

  budgetBaseUnits() { return Math.round(cfg.SESSION_BUDGET_USDC * 1e6); }

  async openSession(code: string): Promise<void> {
    const sol = solana();
    if (!sol) {
      this.db.prepare(`UPDATE rooms SET status = 'open' WHERE code = ?`).run(code);
      console.log(`[settle] Solana not configured: room ${code} session marked open locally (no tx)`);
      return;
    }
    const sessionId = BigInt(Date.now());
    const budget = this.budgetBaseUnits();
    const { sig, sessionPda } = await sol.openSession(sessionId, budget);
    this.db.prepare(`UPDATE rooms SET session_id = ?, session_pda = ?, budget = ?, status = 'open' WHERE code = ?`)
      .run(sessionId.toString(), sessionPda, budget, code);
    this.spentLocal.set(sessionPda, 0);
    console.log(`[settle] open_session ${sessionId} for room ${code}: ${sig}`);
  }

  async ensureSession(code: string): Promise<void> {
    return this.withRoom(code, async () => {
      const room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as RoomRow | undefined;
      if (room && !room.session_id) await this.openSession(code);
    });
  }

  async closeSession(code: string): Promise<string | null> {
    return this.withRoom(code, async () => {
      const room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as RoomRow | undefined;
      if (!room) throw new Error('unknown room');
      let sig: string | null = null;
      const sol = solana();
      if (sol && room.session_id) {
        sig = await sol.closeSession(BigInt(room.session_id));
        console.log(`[settle] close_session ${room.session_id} for room ${code}: ${sig}`);
      }
      this.db.prepare(`UPDATE rooms SET status = 'closed' WHERE code = ?`).run(code);
      return sig;
    });
  }

  async tick() {
    const now = Date.now();
    const helpers = this.db.prepare(
      `SELECT h.* FROM helpers h JOIN rooms r ON r.code = h.room_code WHERE r.status = 'open'`,
    ).all() as HelperRow[];
    for (const h of helpers) {
      if (this.busy.has(h.id)) continue;
      const ready = this.db.prepare(
        'SELECT * FROM receipts WHERE helper_id = ? AND game_sig IS NOT NULL AND settled_tx IS NULL ORDER BY created_at',
      ).all(h.id) as ReceiptRow[];
      if (!ready.length) continue;
      if (ready.length < BATCH_MIN && now - ready[0].created_at < MAX_AGE_MS) continue;
      const units = ready.reduce((s, r) => s + r.work_units, 0);
      const root = merkleRoot(ready.map((r) => receiptMessage(r.job_id, r.type as JobType, r.work_units, r.output_hash)));
      const sol = solana();
      if (!sol) {
        const key = `${h.id}:${ready.length}:${ready[0].job_id}`;
        if (!this.loggedBatches.has(key)) {
          this.loggedBatches.add(key);
          console.log(`[settle] would settle ${units} units for ${h.display_name} (${ready.length} receipts, Solana not configured; batch kept pending)`);
        }
        continue;
      }
      this.busy.add(h.id);
      void this.withRoom(h.room_code, async () => {
        let room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(h.room_code) as RoomRow;
        if (!room.session_id) {
          await this.openSession(h.room_code);
          room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(h.room_code) as RoomRow;
        }
        const price = await sol.getUnitPrice();
        const amount = units * price;
        const spent = this.spentLocal.get(room.session_pda!) ?? 0;
        if (spent + amount > (room.budget ?? this.budgetBaseUnits())) {
          console.log(`[settle] session ${room.session_id} vault would be exceeded (${spent}+${amount} > ${room.budget}); topping up with a new open_session`);
          await this.openSession(h.room_code);
          room = this.db.prepare('SELECT * FROM rooms WHERE code = ?').get(h.room_code) as RoomRow;
        }
        const sig = await sol.settle(BigInt(room.session_id!), h.wallet, units, root);
        this.spentLocal.set(room.session_pda!, (this.spentLocal.get(room.session_pda!) ?? 0) + amount);
        const upd = this.db.prepare('UPDATE receipts SET settled_tx = ? WHERE job_id = ?');
        this.db.transaction(() => { for (const r of ready) upd.run(sig, r.job_id); })();
        console.log(`[settle] settled ${units} units (${ready.length} receipts) for ${h.display_name}: ${sig}`);
      })
        .catch((e) => console.warn(`[settle] settle for ${h.display_name} failed:`, (e as Error).message))
        .finally(() => this.busy.delete(h.id));
    }
  }
}
