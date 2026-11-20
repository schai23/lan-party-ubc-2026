// Read models for /status, /status.json, /admin and earnings:update.
// Earnings, leaderboard and settlement lists read ONLY from the `settlements` table (written by the webhook).
import { explorerTx, type Dispatch, type EarningsUpdate, type SettlementRow } from '@sidekick/shared';
import { cfg, integrationStatus } from '@sidekick/shared/config';
import type { DB, HelperRow, RoomRow, SettlementDbRow } from './db';
import { programIdString, solanaConfigured } from './solana';

export interface OnlineInfo { helperId: string; displayName: string; kind: string; jobTypes: string[]; inflight: number; paused: boolean; roomCode: string }

export function toSettlementRow(r: SettlementDbRow): SettlementRow {
  return {
    signature: r.signature, slot: r.slot, blockTime: r.block_time, session: r.session, helperWallet: r.helper_wallet,
    units: r.units, amount: r.amount, receiptsRoot: r.receipts_root, source: r.source,
  };
}

export function earningsFor(db: DB, roomCode?: string, latestSig?: string): EarningsUpdate {
  const helpers = (roomCode
    ? db.prepare('SELECT * FROM helpers WHERE room_code = ?').all(roomCode)
    : db.prepare('SELECT * FROM helpers').all()) as HelperRow[];
  const totals = new Map<string, { units: number; amount: number }>();
  for (const r of db.prepare('SELECT helper_wallet, SUM(units) u, SUM(amount) a FROM settlements GROUP BY helper_wallet').all() as any[]) {
    totals.set(r.helper_wallet, { units: r.u ?? 0, amount: r.a ?? 0 });
  }
  const rows = helpers.map((h) => {
    const t = totals.get(h.wallet) ?? { units: 0, amount: 0 };
    return { helperId: h.id, displayName: h.display_name, wallet: h.wallet, units: t.units, usdc: t.amount / 1e6, rank: 0 };
  });
  rows.sort((a, b) => b.usdc - a.usdc || b.units - a.units || a.displayName.localeCompare(b.displayName));
  rows.forEach((r, i) => (r.rank = i + 1));
  let latest: EarningsUpdate['latest'];
  const lr = (latestSig
    ? db.prepare('SELECT * FROM settlements WHERE signature = ?').get(latestSig)
    : undefined) as SettlementDbRow | undefined;
  if (lr) {
    const h = helpers.find((x) => x.wallet === lr.helper_wallet);
    latest = { ...toSettlementRow(lr), explorerUrl: explorerTx(lr.signature), displayName: h?.display_name };
  }
  return { roomCode, latest, helpers: rows, solanaConfigured: solanaConfigured() };
}

export interface Alert { kind: string; message: string; helperId?: string; roomCode?: string }

export function computeAlerts(db: DB): Alert[] {
  const now = Date.now();
  const alerts: Alert[] = [];
  // Helper with >= 2 timeouts in the last 5 minutes (timeouts are logged with ok=0 and no compute_ms).
  for (const r of db.prepare(
    `SELECT j.helper_id, COUNT(*) n, h.display_name FROM job_log j LEFT JOIN helpers h ON h.id = j.helper_id
     WHERE j.ok = 0 AND j.compute_ms IS NULL AND j.helper_id IS NOT NULL AND j.created_at >= ? GROUP BY j.helper_id HAVING n >= 2`,
  ).all(now - 5 * 60_000) as any[]) {
    alerts.push({ kind: 'helper-timeouts', helperId: r.helper_id, message: `Helper ${r.display_name ?? r.helper_id} (${r.helper_id}) had ${r.n} timeouts in the last 5 min` });
  }
  for (const room of db.prepare(`SELECT * FROM rooms WHERE status = 'open' AND session_pda IS NOT NULL`).all() as RoomRow[]) {
    const spent = (db.prepare('SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE session = ?').get(room.session_pda) as any).s as number;
    if (room.budget && room.budget - spent < room.budget * 0.1) {
      alerts.push({ kind: 'vault-low', roomCode: room.code, message: `Session vault for room ${room.code} below 10% of budget (${((room.budget - spent) / 1e6).toFixed(3)} USDC left)` });
    }
  }
  // Open session with ready receipts but no settlement in 15 min.
  for (const room of db.prepare(`SELECT * FROM rooms WHERE status = 'open'`).all() as RoomRow[]) {
    const ready = db.prepare(
      `SELECT COUNT(*) n, MIN(r.created_at) oldest FROM receipts r JOIN helpers h ON h.id = r.helper_id
       WHERE h.room_code = ? AND r.game_sig IS NOT NULL AND r.settled_tx IS NULL`,
    ).get(room.code) as any;
    if (!ready.n || now - ready.oldest < 15 * 60_000) continue;
    const lastSettle = room.session_pda
      ? (db.prepare('SELECT MAX(block_time) t FROM settlements WHERE session = ?').get(room.session_pda) as any).t
      : null;
    if (!lastSettle || now / 1000 - lastSettle > 15 * 60) {
      alerts.push({ kind: 'settlement-stalled', roomCode: room.code, message: `Room ${room.code} has ${ready.n} ready receipts but no settlement in 15 min` });
    }
  }
  for (const s of db.prepare('SELECT * FROM settlements WHERE amount > 5000000 ORDER BY slot DESC LIMIT 10').all() as SettlementDbRow[]) {
    alerts.push({ kind: 'large-settlement', message: `Settlement ${s.signature} paid ${(s.amount / 1e6).toFixed(3)} USDC (> 5 USDC)` });
  }
  return alerts;
}

export function statusData(db: DB, online: OnlineInfo[], dispatch: Dispatch & { storedAt?: number }) {
  const now = Date.now();
  const jobCounts = new Map<string, { ok: number; failed: number }>();
  for (const r of db.prepare('SELECT helper_id, SUM(ok) ok, SUM(1 - ok) failed FROM job_log WHERE helper_id IS NOT NULL GROUP BY helper_id').all() as any[]) {
    jobCounts.set(r.helper_id, { ok: r.ok ?? 0, failed: r.failed ?? 0 });
  }
  const helpersOnline = online.map((h) => ({ ...h, jobsOk: jobCounts.get(h.helperId)?.ok ?? 0, jobsFailed: jobCounts.get(h.helperId)?.failed ?? 0 }));
  const unitsByType = Object.fromEntries(
    (db.prepare('SELECT type, SUM(work_units) u, COUNT(*) n FROM receipts WHERE created_at >= ? GROUP BY type').all(now - 3_600_000) as any[]).map((r) => [r.type, { units: r.u, jobs: r.n }]),
  );
  const helperNames = new Map((db.prepare('SELECT wallet, display_name FROM helpers').all() as any[]).map((h) => [h.wallet, h.display_name]));
  const settlements = (db.prepare('SELECT * FROM settlements ORDER BY slot DESC LIMIT 20').all() as SettlementDbRow[]).map((s) => ({
    ...toSettlementRow(s), usdc: s.amount / 1e6, explorerUrl: explorerTx(s.signature), displayName: helperNames.get(s.helper_wallet),
  }));
  const leaderboard = earningsFor(db).helpers.filter((h) => h.units > 0 || h.usdc > 0);
  const lastClosed = db.prepare(`SELECT * FROM rooms WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1`).get() as RoomRow | undefined;
  let lastClosedSession: any = null;
  if (lastClosed) {
    const helpers = db.prepare('SELECT * FROM helpers WHERE room_code = ?').all(lastClosed.code) as HelperRow[];
    const jobs = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(r.work_units),0) u FROM receipts r JOIN helpers h ON h.id = r.helper_id WHERE h.room_code = ?`).get(lastClosed.code) as any;
    const paid = lastClosed.session_pda
      ? (db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) a, COALESCE(SUM(units),0) u FROM settlements WHERE session = ?').get(lastClosed.session_pda) as any)
      : { n: 0, a: 0, u: 0 };
    const earn = earningsFor(db, lastClosed.code).helpers;
    lastClosedSession = {
      roomCode: lastClosed.code, sessionId: lastClosed.session_id, sessionPda: lastClosed.session_pda,
      helpers: helpers.length, jobs: jobs.n, workUnits: jobs.u, settlements: paid.n, unitsPaid: paid.u, usdcPaid: paid.a / 1e6,
      topHelpers: earn.slice(0, 3).map((h) => ({ displayName: h.displayName, units: h.units, usdc: h.usdc })),
    };
  }
  const integrations = integrationStatus();
  return {
    generatedAt: new Date(now).toISOString(),
    integrations,
    stubbed: integrations.filter((i) => !i.configured).map((i) => i.name),
    solanaConfigured: solanaConfigured(),
    programId: programIdString() ?? null,
    usdcMint: cfg.USDC_MINT,
    dispatch: { source: dispatch.source, date: dispatch.date, worldEvent: dispatch.worldEvent, area: dispatch.area, quests: dispatch.quests, loreMentions: dispatch.loreMentions },
    helpersOnline,
    workUnitsLastHour: unitsByType,
    settlements,
    leaderboard,
    alerts: computeAlerts(db),
    lastClosedSession,
  };
}

export type StatusData = ReturnType<typeof statusData>;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#111418;color:#e6e6e6;margin:0;padding:16px;max-width:1100px}
h1{margin:0 0 8px}h2{margin-top:28px;border-bottom:1px solid #333;padding-bottom:4px;color:#f5b041}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #333;padding:4px 8px;text-align:left;vertical-align:top}
a{color:#7fb3ff}.ok{color:#58d68d}.miss{color:#f5b041}.alert{color:#ec7063}code,pre,textarea{font-family:ui-monospace,monospace}
pre{background:#1b1f24;padding:8px;overflow:auto}textarea{width:100%;min-height:320px;background:#1b1f24;color:#e6e6e6}
input,button,select{font-size:14px;padding:4px 8px}form.inline{display:inline}
</style></head><body>${body}</body></html>`;
}

export function statusHtml(d: StatusData): string {
  const table = (head: string[], rows: string[][]) =>
    `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}">none</td></tr>`}</table>`;
  const lc = d.lastClosedSession;
  return page('Lanternfall Sidekick status', `
<h1>Lanternfall / Sidekick network status</h1>
<p>Generated ${esc(d.generatedAt)}. Program: ${d.programId ? `<a href="https://explorer.solana.com/address/${esc(d.programId)}?cluster=devnet">${esc(d.programId)}</a>` : 'not configured'} (devnet). USDC mint: <code>${esc(d.usdcMint)}</code>. <a href="/status.json">status.json</a></p>
<h2>Integrations</h2>
${d.stubbed.length ? `<p class="miss">Running in stub mode: ${d.stubbed.map(esc).join(', ')}</p>` : '<p class="ok">All integrations configured.</p>'}
${table(['Integration', 'Status', 'Missing', 'Stub behavior'], d.integrations.map((i) => [esc(i.name), i.configured ? '<span class="ok">configured</span>' : '<span class="miss">stub</span>', esc(i.missing.join(', ')), esc(i.stub)]))}
<h2>Dispatch in effect</h2>
<p>Source: <strong>${esc(d.dispatch.source)}</strong> (${esc(d.dispatch.date)}). World event: <strong>${esc(d.dispatch.worldEvent.title)}</strong>: ${esc(d.dispatch.worldEvent.summary)}</p>
<p>Area: ${esc(d.dispatch.area.theme)} (seed ${esc(d.dispatch.area.seed)}). Lore mentions: ${esc(d.dispatch.loreMentions.join(', ') || 'none')}</p>
<h2>Active alerts</h2>
${d.alerts.length ? `<ul>${d.alerts.map((a) => `<li class="alert">[${esc(a.kind)}] ${esc(a.message)}</li>`).join('')}</ul>` : '<p class="ok">No active alerts.</p>'}
<h2>Helpers online</h2>
${table(['Helper', 'ID', 'Room', 'Kind', 'Job types', 'In flight', 'Paused', 'Jobs ok', 'Jobs failed'], d.helpersOnline.map((h) => [esc(h.displayName), `<code>${esc(h.helperId)}</code>`, esc(h.roomCode), esc(h.kind), esc(h.jobTypes.join(', ')), esc(h.inflight), h.paused ? 'yes' : 'no', esc(h.jobsOk), esc(h.jobsFailed)]))}
<h2>Work units by type (last hour)</h2>
${table(['Type', 'Jobs', 'Work units'], Object.entries(d.workUnitsLastHour).map(([t, v]: [string, any]) => [esc(t), esc(v.jobs), esc(v.units)]))}
<h2>Last 20 settlements (from QuickNode Stream)</h2>
${d.solanaConfigured ? '' : '<p class="miss">Solana not configured: no settlements are sent; earnings stay 0.</p>'}
${table(['Tx', 'Helper', 'Units', 'USDC', 'Slot', 'Source'], d.settlements.map((s) => [`<a href="${esc(s.explorerUrl)}">${esc(s.signature.slice(0, 16))}...</a>`, esc(s.displayName ?? s.helperWallet), esc(s.units), esc(s.usdc.toFixed(3)), esc(s.slot), esc(s.source)]))}
<h2>Leaderboard</h2>
${table(['Rank', 'Helper', 'Units', 'USDC'], d.leaderboard.map((h) => [esc(h.rank), esc(h.displayName), esc(h.units), esc(h.usdc.toFixed(3))]))}
<h2>Last closed session</h2>
${lc ? `<p>Room <strong>${esc(lc.roomCode)}</strong>, session ${esc(lc.sessionId ?? 'n/a')}: ${esc(lc.helpers)} helpers, ${esc(lc.jobs)} jobs, ${esc(lc.workUnits)} work units, ${esc(lc.settlements)} settlements paying ${esc(lc.usdcPaid.toFixed(3))} USDC.
Top helpers: ${esc(lc.topHelpers.map((h: any) => `${h.displayName} (${h.units} units, ${h.usdc.toFixed(3)} USDC)`).join('; ') || 'none')}</p>` : '<p>No session has been closed yet.</p>'}
`);
}
