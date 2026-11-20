// Sidekick server (spec 8): Fastify HTTP API + Socket.IO relay + settlement loop + server-rendered pages.
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  DispatchSchema, EV, RegisterHelperRequestSchema, type CreateRoomResponse, type Dispatch, type RegisterHelperResponse,
} from '@sidekick/shared';
import { REPO_ROOT, cfg, formatIntegrationTable, integrationStatus } from '@sidekick/shared/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { openDb, type HelperRow, type RoomRow } from './db';
import { Hub } from './hub';
import { Settler } from './settle';
import { decodeSettlements, fetchTxLogs, programIdString, solana, solanaConfigured } from './solana';
import { earningsFor, esc, page, statusData, statusHtml } from './status';
import { pregenerateTts, stt, ttsStream, voiceConfigured } from './voice';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DISPATCH_PATH = resolve(HERE, '../data/default-dispatch.json');
const WEB_DIST = resolve(REPO_ROOT, 'apps/web/dist');
const QN_SAMPLE_PATH = resolve(REPO_ROOT, 'docs/quicknode-sample.json');

export interface StartOptions { port?: number; host?: string; dbPath?: string; quiet?: boolean }

function lanIp(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return undefined;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomCode = () => Array.from(randomBytes(6), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
const token = () => randomBytes(24).toString('hex');

interface Match { signature: string; slot: number; blockTime: number | null; logs: string[] }

/** Be defensive about the QuickNode payload: {matches:[...]}, arrays, {data: ...}, or raw blocks/txs. */
function extractMatches(body: unknown): { matches: Match[]; recognized: boolean } {
  const matches: Match[] = [];
  let recognized = false;
  const visit = (v: any, depth: number, slot?: number, blockTime?: number | null) => {
    if (!v || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1, slot, blockTime); return; }
    if (typeof v !== 'object') return;
    if (Array.isArray(v.logs) && (v.signature || v.sig)) {
      recognized = true;
      matches.push({ signature: String(v.signature ?? v.sig), slot: Number(v.slot ?? slot ?? 0), blockTime: v.blockTime ?? blockTime ?? null, logs: v.logs.map(String) });
      return;
    }
    if (v.meta && v.transaction) {
      recognized = true;
      if (v.meta.err) return;
      const sig = v.transaction.signatures?.[0];
      if (sig) matches.push({ signature: sig, slot: Number(v.slot ?? slot ?? 0), blockTime: v.blockTime ?? blockTime ?? null, logs: (v.meta.logMessages ?? []).map(String) });
      return;
    }
    if (Array.isArray(v.transactions)) { recognized = true; visit(v.transactions, depth + 1, v.slot ?? slot, v.blockTime ?? blockTime); return; }
    if ('matches' in v) { recognized = true; visit(v.matches, depth + 1, slot, blockTime); return; }
    if ('data' in v) visit(v.data, depth + 1, slot, blockTime);
  };
  visit(body, 0);
  return { matches, recognized };
}

export async function startServer(opts: StartOptions = {}) {
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
  const db = openDb(opts.dbPath ?? cfg.DB_PATH ?? resolve(HERE, '../data/sidekick.sqlite'));

  const generated: string[] = [];
  const adminToken = cfg.ADMIN_TOKEN ?? (generated.push('ADMIN_TOKEN'), token());
  const grokToken = cfg.GROK_TOKEN ?? (generated.push('GROK_TOKEN'), token());

  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  const io = new Server(app.server, {
    maxHttpBufferSize: 50e6,
    perMessageDeflate: { threshold: 1024 },
    cors: { origin: true, credentials: true },
  });
  const hub = new Hub(db, io);
  const settler = new Settler(db);

  const ctx = { baseUrl: '' };

  // ---------- dispatch ----------
  const defaultDispatch = DispatchSchema.parse(JSON.parse(readFileSync(DEFAULT_DISPATCH_PATH, 'utf8')));
  function currentDispatch(): Dispatch & { storedAt?: number } {
    const rows = db.prepare(`SELECT * FROM dispatches ORDER BY (source = 'grok-bot') DESC, created_at DESC, id DESC LIMIT 20`).all() as any[];
    for (const r of rows) {
      const p = DispatchSchema.safeParse(JSON.parse(r.json));
      if (p.success) return { ...p.data, storedAt: r.created_at };
    }
    return defaultDispatch;
  }

  // ---------- helpers ----------
  const isForm = (req: FastifyRequest) => String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
  const bodyOf = (req: FastifyRequest) => ((req.body && typeof req.body === 'object') ? (req.body as Record<string, any>) : {});
  const htmlReply = (reply: FastifyReply, code: number, title: string, body: string) =>
    reply.code(code).type('text/html; charset=utf-8').send(page(title, body));
  const tokenFrom = (req: FastifyRequest, header: string) =>
    String(req.headers[header] ?? bodyOf(req).token ?? (req.query as any)?.token ?? '');

  // ---------- rooms + pairing ----------
  app.post('/api/rooms', async (): Promise<CreateRoomResponse> => {
    let code = roomCode();
    while (db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code)) code = roomCode();
    const pairSecret = randomBytes(12).toString('hex');
    db.prepare(`INSERT INTO rooms (code, pair_secret, created_at, status) VALUES (?, ?, ?, 'open')`).run(code, pairSecret, Date.now());
    return { roomCode: code, pairSecret, pairUrl: `${ctx.baseUrl}/helper?room=${code}&s=${pairSecret}` };
  });

  function custodialWallet(email: string): string {
    const row = db.prepare('SELECT pubkey FROM custodial_wallets WHERE email = ?').get(email) as { pubkey: string } | undefined;
    if (row) return row.pubkey;
    const kp = Keypair.generate();
    db.prepare('INSERT INTO custodial_wallets (email, pubkey, secret_json, created_at) VALUES (?,?,?,?)')
      .run(email, kp.publicKey.toBase58(), JSON.stringify(Array.from(kp.secretKey)), Date.now());
    return kp.publicKey.toBase58();
  }

  app.post('/api/helpers/register', async (req, reply): Promise<RegisterHelperResponse | void> => {
    const p = RegisterHelperRequestSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: p.error.message });
    const b = p.data;
    const code = b.roomCode.toUpperCase();
    const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code) as RoomRow | undefined;
    if (!room || room.pair_secret !== b.pairSecret) return reply.code(403).send({ error: 'bad room code or pair secret' });
    if (!/^[0-9a-f]{64}$/i.test(b.helperPubKey)) return reply.code(400).send({ error: 'helperPubKey must be 32-byte hex' });
    let wallet = b.wallet?.trim() || '';
    if (wallet) {
      try { new PublicKey(wallet); } catch { return reply.code(400).send({ error: 'wallet is not a valid Solana address' }); }
    } else {
      wallet = custodialWallet((b.email?.trim().toLowerCase() || `anon:${b.displayName}:${b.helperPubKey}`));
    }
    const pub = b.helperPubKey.toLowerCase();
    const runnerCmd = (t: string) => `pnpm runner --server ${ctx.baseUrl} --token ${t} --jobs dialogue,areagen,pathfind,simtick`;
    const existing = db.prepare('SELECT * FROM helpers WHERE room_code = ? AND helper_pubkey = ?').get(code, pub) as HelperRow | undefined;
    if (existing) {
      db.prepare('UPDATE helpers SET display_name = ?, wallet = ?, kind = ? WHERE id = ?').run(b.displayName, wallet, b.kind, existing.id);
      return { helperId: existing.id, helperToken: existing.token, wallet, runnerCommand: runnerCmd(existing.token) };
    }
    const first = !(db.prepare('SELECT 1 FROM helpers WHERE room_code = ? LIMIT 1').get(code));
    const id = randomUUID();
    const t = token();
    db.prepare('INSERT INTO helpers (id, room_code, display_name, wallet, helper_pubkey, token, kind, caps_json, paused, created_at) VALUES (?,?,?,?,?,?,?,NULL,0,?)')
      .run(id, code, b.displayName, wallet, pub, t, b.kind, Date.now());
    log(`[api] helper registered: ${b.displayName} (${b.kind}) room ${code} wallet ${wallet}`);
    if (solana()) {
      // Non-blocking: open the session on the first helper, register HelperStats + USDC ATA for each helper.
      const sol = solana()!;
      if (first) void settler.ensureSession(code).catch((e) => console.warn('[solana] open_session failed:', e.message));
      void settler.withRoom(code, () => sol.registerHelper(wallet))
        .then(() => log(`[solana] register_helper ok for ${b.displayName}`))
        .catch((e) => console.warn(`[solana] register_helper failed for ${b.displayName}:`, e.message));
    }
    return { helperId: id, helperToken: t, wallet, runnerCommand: runnerCmd(t) };
  });

  app.get('/api/helpers/me', async (req, reply) => {
    const t = String((req.query as any)?.token ?? '');
    const h = db.prepare('SELECT * FROM helpers WHERE token = ?').get(t) as HelperRow | undefined;
    if (!h) return reply.code(404).send({ error: 'unknown token' });
    return { helperId: h.id, displayName: h.display_name, wallet: h.wallet, roomCode: h.room_code, kind: h.kind };
  });

  app.get('/api/integrations', async () => ({
    integrations: integrationStatus(),
    voice: voiceConfigured() ? 'elevenlabs' : 'browser',
    solanaConfigured: solanaConfigured(),
    programId: programIdString(),
    usdcMint: cfg.USDC_MINT,
  }));

  app.get('/api/earnings', async (req) => {
    const room = (req.query as any)?.room ? String((req.query as any).room).toUpperCase() : undefined;
    return earningsFor(db, room);
  });

  // ---------- ElevenLabs ----------
  app.post('/api/tts', async (req, reply) => {
    if (!voiceConfigured()) return reply.code(503).send({ fallback: 'browser' });
    const b = bodyOf(req);
    const npcId = String(b.npcId ?? '');
    const text = String(b.text ?? '').trim();
    if (!npcId || !text) return reply.code(400).send({ error: 'npcId and text required' });
    try {
      const s = await ttsStream(npcId, text);
      return reply.type('audio/mpeg').header('cache-control', 'no-store').send(s);
    } catch (e) {
      console.warn('[tts]', (e as Error).message);
      return reply.code(502).send({ error: (e as Error).message, fallback: 'browser' });
    }
  });

  app.post('/api/stt', async (req, reply) => {
    if (!voiceConfigured()) return reply.code(503).send({ fallback: 'browser' });
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'multipart audio file required' });
      const buf = await file.toBuffer();
      return { text: await stt(buf, file.filename, file.mimetype) };
    } catch (e) {
      console.warn('[stt]', (e as Error).message);
      return reply.code(502).send({ error: (e as Error).message, fallback: 'browser' });
    }
  });

  // ---------- dispatch (Grok Bot writes) ----------
  app.get('/api/dispatch/current', async () => {
    const { storedAt: _s, ...d } = currentDispatch();
    return d;
  });

  app.post('/api/dispatch', async (req, reply) => {
    const form = isForm(req);
    const fail = (code: number, msg: string) =>
      form ? htmlReply(reply, code, 'Dispatch rejected', `<h1>Dispatch rejected</h1><p class="alert">${esc(msg)}</p><p><a href="/admin/dispatch?token=${esc(tokenFrom(req, 'x-grok-token'))}">Back to the form</a></p>`)
        : reply.code(code).send({ ok: false, error: msg });
    if (tokenFrom(req, 'x-grok-token') !== grokToken) return fail(401, 'bad or missing grok token');
    const b = bodyOf(req);
    let raw: any;
    try {
      raw = typeof b.json === 'string' ? JSON.parse(b.json) : b.json && typeof b.json === 'object' ? b.json : { ...b };
    } catch (e) {
      return fail(400, 'json field is not valid JSON: ' + (e as Error).message);
    }
    if (raw && typeof raw === 'object') {
      delete raw.token;
      raw.date ??= new Date().toISOString().slice(0, 10);
      raw.source ??= 'grok-bot';
      raw.loreMentions ??= [];
    }
    const p = DispatchSchema.safeParse(raw);
    if (!p.success) return fail(400, 'schema validation failed: ' + p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = p.data;
    db.prepare('INSERT INTO dispatches (json, source, created_at) VALUES (?,?,?)').run(JSON.stringify(d), d.source, Date.now());
    const now = currentDispatch();
    const { storedAt: _s, ...cur } = now;
    io.emit(EV.DISPATCH_UPDATE, cur);
    log(`[dispatch] accepted (${d.source}): ${d.worldEvent.title}`);
    void pregenerateTts((['innkeeper', 'blacksmith', 'oracle'] as const).flatMap((npc) => d.fallbackLines[npc].slice(0, 5).map((text) => ({ npcId: npc, text }))));
    if (form) {
      return htmlReply(reply, 200, 'Dispatch accepted', `<h1>Dispatch accepted</h1><p>World event: <strong>${esc(d.worldEvent.title)}</strong> (source ${esc(d.source)}, ${esc(d.date)}). It is live in-game now.</p><p><a href="/status">View /status</a></p>`);
    }
    return { ok: true, dispatch: d };
  });

  // ---------- pause requests (Grok Bot files, admin approves) ----------
  app.post('/api/pause-requests', async (req, reply) => {
    const form = isForm(req);
    const respond = (code: number, title: string, msg: string, extra: Record<string, unknown> = {}) =>
      form ? htmlReply(reply, code, title, `<h1>${esc(title)}</h1><p>${esc(msg)}</p><p><a href="/status">View /status</a></p>`)
        : reply.code(code).send({ ok: code < 300, message: msg, ...extra });
    if (tokenFrom(req, 'x-grok-token') !== grokToken) return respond(401, 'Pause request rejected', 'bad or missing grok token');
    const b = bodyOf(req);
    const who = String(b.helperId || b.displayName || b.helper || '').trim();
    const reason = String(b.reason ?? '').trim().slice(0, 500);
    if (!who) return respond(400, 'Pause request rejected', 'helperId or displayName required');
    const h = db.prepare('SELECT * FROM helpers WHERE id = ? OR display_name = ? ORDER BY created_at DESC LIMIT 1').get(who, who) as HelperRow | undefined;
    if (!h) return respond(404, 'Pause request rejected', `no helper matches "${who}"`);
    const r = db.prepare(`INSERT INTO pause_requests (helper_id, reason, created_at, status) VALUES (?,?,?,'pending')`).run(h.id, reason, Date.now());
    log(`[pause] request #${r.lastInsertRowid} filed for ${h.display_name}: ${reason}`);
    return respond(200, 'Pause request filed', `Pause request #${r.lastInsertRowid} filed for helper ${h.display_name} (${h.id}). An admin must approve it.`, { id: Number(r.lastInsertRowid), helperId: h.id });
  });

  app.post('/api/pause-requests/:id/approve', async (req, reply) => {
    const form = isForm(req);
    const t = tokenFrom(req, 'x-admin-token');
    if (t !== adminToken) return form ? htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1>') : reply.code(401).send({ ok: false, error: 'bad admin token' });
    const id = Number((req.params as any).id);
    const pr = db.prepare('SELECT * FROM pause_requests WHERE id = ?').get(id) as any;
    if (!pr) return form ? htmlReply(reply, 404, 'Not found', '<h1>Pause request not found</h1>') : reply.code(404).send({ ok: false, error: 'not found' });
    db.prepare(`UPDATE pause_requests SET status = 'approved' WHERE id = ?`).run(id);
    hub.setPaused(pr.helper_id, true);
    log(`[pause] request #${id} approved; helper ${pr.helper_id} paused`);
    return form ? reply.redirect(`/admin?token=${encodeURIComponent(t)}`, 303) : { ok: true, helperId: pr.helper_id };
  });

  // ---------- QuickNode Streams webhook (the ONLY writer of `settlements`) ----------
  let wroteSample = existsSync(QN_SAMPLE_PATH);
  function ingest(matches: Match[], source: string): number {
    let inserted = 0;
    const ins = db.prepare('INSERT OR IGNORE INTO settlements (signature, slot, block_time, session, helper_wallet, units, amount, receipts_root, source) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const m of matches) {
      const evs = decodeSettlements(m.logs);
      evs.forEach((e, i) => {
        const sig = i === 0 ? m.signature : `${m.signature}#${i}`;
        const r = ins.run(sig, m.slot, m.blockTime, e.session, e.helperWallet, e.units, e.amount, e.receiptsRoot, source);
        if (!r.changes) return;
        inserted++;
        log(`[settlements] ${source}: ${e.units} units / ${(e.amount / 1e6).toFixed(3)} USDC to ${e.helperWallet} (${sig})`);
        const room = db.prepare('SELECT code FROM rooms WHERE session_pda = ?').get(e.session) as { code: string } | undefined;
        const rooms = room ? [room.code] : (db.prepare('SELECT DISTINCT room_code FROM helpers WHERE wallet = ?').all(e.helperWallet) as any[]).map((x) => x.room_code);
        for (const code of rooms) hub.broadcastEarnings(code, sig);
      });
    }
    return inserted;
  }

  app.post('/webhooks/quicknode', async (req, reply) => {
    if (!cfg.QUICKNODE_STREAM_TOKEN || req.headers['x-qn-token'] !== cfg.QUICKNODE_STREAM_TOKEN) return reply.code(401).send({ ok: false });
    const { matches, recognized } = extractMatches(req.body);
    if (!recognized && !wroteSample) {
      wroteSample = true;
      try { writeFileSync(QN_SAMPLE_PATH, JSON.stringify(req.body, null, 2)); log(`[quicknode] unrecognized payload written to ${QN_SAMPLE_PATH}`); } catch {}
    }
    return { ok: true, matches: matches.length, inserted: ingest(matches, 'quicknode') };
  });

  if (cfg.DEV_TOOLS) {
    app.post('/dev/replay-tx', async (req, reply) => {
      const sig = String(bodyOf(req).signature ?? '');
      if (!sig) return reply.code(400).send({ error: 'signature required' });
      const tx = await fetchTxLogs(sig);
      if (!tx) return reply.code(404).send({ error: 'transaction not found' });
      return { ok: true, decoded: decodeSettlements(tx.logs).length, inserted: ingest([tx], 'dev-replay') };
    });
  }

  // ---------- status (Grok Bot reads) ----------
  const status = () => statusData(db, hub.onlineInfo(), currentDispatch());
  app.get('/status', async (_req, reply) => reply.type('text/html; charset=utf-8').send(statusHtml(status())));
  app.get('/status.json', async () => status());

  // ---------- admin pages ----------
  app.get('/admin/dispatch', async (req, reply) => {
    const t = String((req.query as any)?.token ?? '');
    if (t !== grokToken) return htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1><p>Pass ?token=GROK_TOKEN.</p>');
    const { storedAt: _s, ...cur } = currentDispatch();
    const example = { ...cur, source: 'grok-bot', date: new Date().toISOString().slice(0, 10) };
    const schema = `{
  "date": string,                       // YYYY-MM-DD
  "source": "grok-bot" | "default",     // use "grok-bot"
  "worldEvent": { "title": string (1-120 chars), "summary": string (1-600 chars) },
  "quests": [ { "npcId": "innkeeper" | "blacksmith" | "oracle", "title": string, "description": string } ],  // max 10
  "fallbackLines": { "innkeeper": string[], "blacksmith": string[], "oracle": string[] },  // max 20 each
  "area": { "theme": string, "seed": integer, "buildingTypes": string[] (at least 1) },
  "loreMentions": string[]              // max 3 helper display names to honor
}`;
    return htmlReply(reply, 200, 'Submit daily dispatch', `
<h1>Submit the daily dispatch</h1>
<p>Current dispatch source: <strong>${esc(cur.source)}</strong> (${esc(cur.date)}): ${esc(cur.worldEvent.title)}</p>
<form method="post" action="/api/dispatch">
  <input type="hidden" name="token" value="${esc(t)}">
  <label for="json">Dispatch JSON (prefilled with an example; edit and submit):</label>
  <textarea id="json" name="json">${esc(JSON.stringify(example, null, 2))}</textarea>
  <p><button type="submit">Submit dispatch</button></p>
</form>
<h2>Schema</h2><pre>${esc(schema)}</pre>
<h2>File a pause request</h2>
<form method="post" action="/api/pause-requests">
  <input type="hidden" name="token" value="${esc(t)}">
  <p><label>Helper display name or helper ID: <input name="displayName" required></label></p>
  <p><label>Reason: <input name="reason" size="60" required></label></p>
  <p><button type="submit">File pause request</button></p>
</form>`);
  });

  app.get('/admin', async (req, reply) => {
    const t = String((req.query as any)?.token ?? '');
    if (t !== adminToken) return htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1><p>Pass ?token=ADMIN_TOKEN.</p>');
    const d = status();
    const prs = db.prepare(`SELECT p.*, h.display_name FROM pause_requests p LEFT JOIN helpers h ON h.id = p.helper_id ORDER BY p.created_at DESC LIMIT 50`).all() as any[];
    const rooms = db.prepare('SELECT * FROM rooms ORDER BY created_at DESC LIMIT 20').all() as RoomRow[];
    const paused = db.prepare('SELECT * FROM helpers WHERE paused = 1').all() as HelperRow[];
    const hid = `<input type="hidden" name="token" value="${esc(t)}">`;
    return htmlReply(reply, 200, 'Sidekick admin', `
<h1>Sidekick admin</h1><p><a href="/status">/status</a> | <a href="/admin/dispatch?token=${esc(grokToken)}">dispatch form</a></p>
<h2>Active alerts</h2>
${d.alerts.length ? `<ul>${d.alerts.map((a) => `<li class="alert">[${esc(a.kind)}] ${esc(a.message)}</li>`).join('')}</ul>` : '<p class="ok">No active alerts.</p>'}
<h2>Pause requests</h2>
<table><tr><th>#</th><th>Helper</th><th>Reason</th><th>Filed</th><th>Status</th><th></th></tr>
${prs.map((p) => `<tr><td>${p.id}</td><td>${esc(p.display_name ?? p.helper_id)}</td><td>${esc(p.reason)}</td><td>${esc(new Date(p.created_at).toISOString())}</td><td>${esc(p.status)}</td>
<td>${p.status === 'pending' ? `<form class="inline" method="post" action="/api/pause-requests/${p.id}/approve">${hid}<button>Approve (pause helper)</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">none</td></tr>'}
</table>
<h2>Paused helpers</h2>
<table>${paused.map((h) => `<tr><td>${esc(h.display_name)}</td><td><form class="inline" method="post" action="/admin/helpers/${esc(h.id)}/unpause">${hid}<button>Unpause</button></form></td></tr>`).join('') || '<tr><td>none</td></tr>'}</table>
<h2>Sessions</h2>
<table><tr><th>Room</th><th>Status</th><th>Session id</th><th>Session PDA</th><th>Budget (USDC)</th><th></th></tr>
${rooms.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.status)}</td><td>${esc(r.session_id ?? '')}</td><td>${esc(r.session_pda ?? '')}</td><td>${r.budget ? (r.budget / 1e6).toFixed(2) : ''}</td>
<td><form class="inline" method="post" action="/admin/session/open">${hid}<input type="hidden" name="roomCode" value="${esc(r.code)}"><button>Open new session</button></form>
<form class="inline" method="post" action="/admin/session/close">${hid}<input type="hidden" name="roomCode" value="${esc(r.code)}"><button>Close session</button></form></td></tr>`).join('') || '<tr><td colspan="6">none</td></tr>'}
</table>
<p>Solana: ${solanaConfigured() ? 'configured' : 'not configured (session buttons only change local state)'}</p>`);
  });

  const adminForm = (req: FastifyRequest) => tokenFrom(req, 'x-admin-token') === adminToken;
  app.post('/admin/session/open', async (req, reply) => {
    if (!adminForm(req)) return htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1>');
    const code = String(bodyOf(req).roomCode ?? '').toUpperCase();
    try { await settler.withRoom(code, () => settler.openSession(code)); }
    catch (e) { return htmlReply(reply, 500, 'Error', `<h1>open_session failed</h1><p>${esc((e as Error).message)}</p>`); }
    return reply.redirect(`/admin?token=${encodeURIComponent(adminToken)}`, 303);
  });
  app.post('/admin/session/close', async (req, reply) => {
    if (!adminForm(req)) return htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1>');
    const code = String(bodyOf(req).roomCode ?? '').toUpperCase();
    try { await settler.closeSession(code); }
    catch (e) { return htmlReply(reply, 500, 'Error', `<h1>close_session failed</h1><p>${esc((e as Error).message)}</p>`); }
    return reply.redirect(`/admin?token=${encodeURIComponent(adminToken)}`, 303);
  });
  app.post('/admin/helpers/:id/unpause', async (req, reply) => {
    if (!adminForm(req)) return htmlReply(reply, 401, 'Unauthorized', '<h1>Unauthorized</h1>');
    hub.setPaused(String((req.params as any).id), false);
    return reply.redirect(`/admin?token=${encodeURIComponent(adminToken)}`, 303);
  });

  // ---------- static web app with SPA fallback ----------
  const hasDist = existsSync(resolve(WEB_DIST, 'index.html'));
  if (hasDist) await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/', wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && (path === '/' || path.startsWith('/play') || path.startsWith('/helper'))) {
      if (hasDist) return reply.type('text/html').sendFile('index.html');
      return htmlReply(reply, 200, 'Sidekick', '<h1>Sidekick server</h1><p>The web app is not built yet (run <code>pnpm build</code>). See <a href="/status">/status</a>.</p>');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  // ---------- boot ----------
  const host = opts.host ?? '0.0.0.0';
  await app.listen({ port: opts.port ?? cfg.PORT, host });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? cfg.PORT);
  ctx.baseUrl = cfg.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? (cfg.LAN_MODE ? `http://${lanIp() ?? 'localhost'}:${port}` : `http://localhost:${port}`);
  settler.start();

  log(`\nSidekick server listening on :${port} (public base ${ctx.baseUrl})\n`);
  log(formatIntegrationTable());
  if (generated.length) {
    log(`\nGenerated tokens for this run (set them in .env to keep them):`);
    if (generated.includes('ADMIN_TOKEN')) log(`  ADMIN_TOKEN=${adminToken}   -> ${ctx.baseUrl}/admin?token=${adminToken}`);
    if (generated.includes('GROK_TOKEN')) log(`  GROK_TOKEN=${grokToken}   -> ${ctx.baseUrl}/admin/dispatch?token=${grokToken}`);
  }
  log(`Web app: ${hasDist ? WEB_DIST : 'not built (apps/web/dist missing)'}\n`);

  return {
    app, io, hub, db, settler, port, baseUrl: ctx.baseUrl, adminToken, grokToken,
    async close() {
      settler.stop();
      for (const p of hub.pending.values()) clearTimeout(p.timer);
      io.close();
      await app.close().catch(() => {});
      db.close();
    },
  };
}

export type SidekickServer = Awaited<ReturnType<typeof startServer>>;
