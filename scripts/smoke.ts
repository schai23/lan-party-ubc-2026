// `pnpm smoke`: end-to-end check with no keys. Starts the server in-process (stub voice, stub Solana, temp DB),
// pairs a fake helper (runs @sidekick/jobs, signs receipts), joins as a fake game, submits one job of each type,
// countersigns, and verifies receipts are stored ready in SQLite. Also checks /status, /status.json,
// /admin/dispatch and a plain-HTML dispatch form post. Exits non-zero on any failure.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Empty-ish env BEFORE the config loader runs (dotenv never overrides existing vars; '' counts as missing).
for (const k of [
  'PUBLIC_BASE_URL', 'LAN_MODE', 'DEV_TOOLS', 'DB_PATH', 'SOLANA_RPC_URL', 'SOLANA_WS_URL', 'PROGRAM_ID', 'SETTLER_KEYPAIR',
  'TREASURY_KEYPAIR', 'ELEVENLABS_API_KEY', 'VOICE_ID_INNKEEPER', 'VOICE_ID_BLACKSMITH', 'VOICE_ID_ORACLE',
  'QUICKNODE_STREAM_TOKEN', 'ADMIN_TOKEN', 'GROK_TOKEN', 'PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'VITE_PRIVY_APP_ID',
]) process.env[k] = '';

const { startServer } = await import('../apps/server/src/app');
const { EV, WORK_UNITS, newKeypair, receiptMessage, signMessage, verifyMessage } = await import('@sidekick/shared');
const { bytesToB64, hashOutput, runJob } = await import('@sidekick/jobs');
const { io } = await import('socket.io-client');
type Job = import('@sidekick/shared').Job;
type JobResult = import('@sidekick/shared').JobResult;

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.error(`  FAIL ${msg}`); }
};
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms))]);

const dir = mkdtempSync(join(tmpdir(), 'sidekick-smoke-'));
const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'smoke.sqlite'), quiet: true });
const base = `http://127.0.0.1:${srv.port}`;
const sockets: { close(): void }[] = [];

async function main() {
  console.log(`Smoke: server on ${base}`);
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  // 1. Room + helper registration (custodial wallet fallback: no wallet, email only).
  const room = (await (await post('/api/rooms', {})).json()) as { roomCode: string; pairSecret: string; pairUrl: string };
  ok(/^[A-Z0-9]{6}$/.test(room.roomCode) && room.pairUrl.includes(room.roomCode), `room created ${room.roomCode}`);
  const hk = newKeypair();
  const reg = (await (await post('/api/helpers/register', {
    roomCode: room.roomCode, pairSecret: room.pairSecret, email: 'smoke@example.com', displayName: 'smoke-helper', kind: 'laptop', helperPubKey: hk.publicKey,
  })).json()) as { helperId: string; helperToken: string; wallet: string; runnerCommand: string };
  ok(reg.helperToken && reg.wallet && reg.runnerCommand.includes(reg.helperToken), `helper registered with custodial wallet ${reg.wallet}`);
  const me = (await (await fetch(`${base}/api/helpers/me?token=${reg.helperToken}`)).json()) as any;
  ok(me.helperId === reg.helperId && me.roomCode === room.roomCode, '/api/helpers/me');

  // 2. Fake helper socket (in-process; computes with @sidekick/jobs, canned dialogue since no Ollama).
  const helper = io(base, { transports: ['websocket'] });
  sockets.push(helper);
  helper.on(EV.JOB_ASSIGN, (job: Job) => {
    let output: unknown; let outputHash: string; let computeMs = 0;
    if (job.type === 'dialogue') {
      helper.emit(EV.JOB_CHUNK, { jobId: job.jobId, text: 'Well met, ' });
      helper.emit(EV.JOB_CHUNK, { jobId: job.jobId, text: 'traveler.' });
      output = { text: 'Well met, traveler.', model: 'smoke-canned' };
      outputHash = hashOutput(output);
    } else {
      const r = runJob(job.type, job.input);
      output = r.output; outputHash = r.outputHash; computeMs = r.computeMs;
    }
    const units = WORK_UNITS[job.type];
    const res: JobResult = {
      jobId: job.jobId, helperId: reg.helperId, type: job.type, ok: true, output, outputHash, workUnits: units, computeMs,
      helperSig: signMessage(receiptMessage(job.jobId, job.type, units, outputHash), hk.secretKey),
    };
    helper.emit(EV.JOB_RESULT, res);
  });
  const hello = await withTimeout(new Promise<any>((res) => helper.on('connect', () => helper.emit(EV.HELPER_HELLO, {
    helperToken: reg.helperToken,
    caps: { kind: 'laptop', jobTypes: ['dialogue', 'pathfind', 'areagen', 'simtick'], cpuThreads: 2, ollama: true, dialogueModel: 'smoke', displayName: 'smoke-helper' },
    helperPubKey: hk.publicKey,
  }, res))), 5000, 'helper:hello ack');
  ok(hello?.ok && hello.helperId === reg.helperId, 'helper:hello acked');

  // 3. Fake game socket.
  const gk = newKeypair();
  const game = io(base, { transports: ['websocket'] });
  sockets.push(game);
  const rosterP = new Promise<any>((res) => game.on(EV.ROOM_ROSTER, (r: any) => { if (r.helpers.length) res(r); }));
  const join = await withTimeout(new Promise<any>((res) => game.on('connect', () => game.emit(EV.ROOM_JOIN, { roomCode: room.roomCode, gamePubKey: gk.publicKey }, res))), 5000, 'room:join ack');
  ok(join?.ok, 'room:join acked');
  const roster = await withTimeout(rosterP, 5000, 'roster');
  ok(roster.helpers[0]?.displayName === 'smoke-helper', 'room:roster lists the helper');

  const results = new Map<string, (r: JobResult) => void>();
  const chunks = new Map<string, string>();
  game.on(EV.JOB_RESULT, (r: JobResult) => results.get(r.jobId)?.(r));
  game.on(EV.JOB_CHUNK, (c: { jobId: string; text: string }) => chunks.set(c.jobId, (chunks.get(c.jobId) ?? '') + c.text));
  game.on(EV.JOB_FAILED, (f: { jobId: string; reason: string }) => { failures++; console.error(`  FAIL job ${f.jobId} failed: ${f.reason}`); });

  // 4. One job of each type.
  const W = 48, H = 36;
  const walk = new Uint8Array(W * H).fill(1);
  for (let y = 5; y < 30; y++) walk[y * W + 20] = 0;
  const inputs: Record<string, unknown> = {
    dialogue: { npcId: 'innkeeper', persona: 'A warm innkeeper.', worldEvent: 'Fog', quest: 'Firewood', playerLine: 'Hello?', history: [] },
    pathfind: { gridId: 'smoke', width: W, height: H, walkableB64: bytesToB64(walk), densityB64: bytesToB64(new Uint8Array(W * H)), targets: [{ id: 'well', x: 3, y: 3 }, { id: 'gate', x: 44, y: 30 }, { id: 'forge', x: 30, y: 10 }] },
    areagen: { seed: 42, theme: 'ember marsh', width: 96, height: 72, buildingTypes: ['hut', 'shrine'] },
    simtick: { seed: 7, tick: 3, npcCount: 50, areaIds: ['village', 'marsh'] },
  };
  for (const type of ['dialogue', 'pathfind', 'areagen', 'simtick'] as const) {
    const job: Job = { jobId: randomUUID(), roomCode: room.roomCode, type, createdAt: Date.now(), deadlineMs: type === 'pathfind' ? 2000 : 8000, input: inputs[type] as any };
    const p = withTimeout(new Promise<JobResult>((res) => results.set(job.jobId, res)), 10_000, `${type} result`);
    game.emit(EV.JOB_SUBMIT, job);
    const r = await p;
    const msg = receiptMessage(r.jobId, r.type, r.workUnits, r.outputHash);
    ok(r.ok && r.helperId === reg.helperId && verifyMessage(msg, r.helperSig, hk.publicKey), `${type}: result relayed with valid helper signature`);
    ok(hashOutput(r.output) === r.outputHash, `${type}: outputHash matches output`);
    if (type === 'dialogue') ok(chunks.get(job.jobId) === 'Well met, traveler.', 'dialogue: chunks relayed');
    else ok(runJob(type, job.input).outputHash === r.outputHash, `${type}: deterministic (local recompute matches)`);
    game.emit(EV.RECEIPT_COUNTERSIGN, { jobId: r.jobId, gameSig: signMessage(msg, gk.secretKey) });
  }

  // 5. Receipts stored and ready (both signatures) in SQLite.
  let ready = 0;
  for (let i = 0; i < 50 && ready < 4; i++) {
    ready = (srv.db.prepare('SELECT COUNT(*) n FROM receipts WHERE helper_id = ? AND game_sig IS NOT NULL').get(reg.helperId) as any).n;
    if (ready < 4) await new Promise((r) => setTimeout(r, 50)); // polling the DB for the async countersign, not compute
  }
  ok(ready === 4, `4 receipts stored ready for settlement (found ${ready})`);
  const logged = (srv.db.prepare('SELECT COUNT(*) n FROM job_log WHERE ok = 1').get() as any).n;
  ok(logged === 4, `job_log has 4 ok rows (found ${logged})`);

  // 6. No-helper path fails fast.
  const nh = await withTimeout(new Promise<any>((res) => {
    const s = io(base, { transports: ['websocket'] });
    sockets.push(s);
    s.on(EV.JOB_FAILED, res);
    s.on('connect', () => s.emit(EV.JOB_SUBMIT, { jobId: 'nohelper', roomCode: 'ZZZZZZ', type: 'simtick', createdAt: Date.now(), deadlineMs: 4000, input: inputs.simtick }));
  }), 3000, 'no-helper job:failed');
  ok(nh.reason === 'no-helper', 'job with no eligible helper fails immediately with no-helper');

  // 7. Pages.
  const st = await fetch(`${base}/status`);
  const stHtml = await st.text();
  ok(st.status === 200 && stHtml.includes('Active alerts') && stHtml.includes('Last closed session'), '/status 200 with alerts + last session sections');
  const sj = await fetch(`${base}/status.json`);
  const sjj = (await sj.json()) as any;
  ok(sj.status === 200 && Array.isArray(sjj.integrations) && sjj.helpersOnline.length === 1, '/status.json 200');
  const ad = await fetch(`${base}/admin/dispatch?token=${srv.grokToken}`);
  const adHtml = await ad.text();
  ok(ad.status === 200 && adHtml.includes('name="json"') && adHtml.includes('File a pause request'), '/admin/dispatch 200 with dispatch + pause forms');
  ok((await fetch(`${base}/admin/dispatch?token=wrong`)).status === 401, '/admin/dispatch rejects bad token');
  ok((await fetch(`${base}/admin?token=${srv.adminToken}`)).status === 200, '/admin 200');

  // 8. Dispatch form post (plain urlencoded, like an agent filling the form).
  const before = (await (await fetch(`${base}/api/dispatch/current`)).json()) as any;
  ok(before.source === 'default', 'default dispatch in effect');
  const updP = withTimeout(new Promise<any>((res) => game.on(EV.DISPATCH_UPDATE, res)), 5000, 'dispatch:update');
  const newDispatch = { ...before, source: 'grok-bot', worldEvent: { title: 'Smoke Over the Marsh', summary: 'A smoke test rolls through the village.' } };
  const form = new URLSearchParams({ token: srv.grokToken, json: JSON.stringify(newDispatch) });
  const dp = await fetch(`${base}/api/dispatch`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  ok(dp.status === 200 && (await dp.text()).includes('Dispatch accepted'), 'dispatch form post accepted (HTML)');
  const upd = await updP;
  ok(upd.worldEvent.title === 'Smoke Over the Marsh', 'game received dispatch:update');
  const after = (await (await fetch(`${base}/api/dispatch/current`)).json()) as any;
  ok(after.worldEvent.title === 'Smoke Over the Marsh' && after.source === 'grok-bot', '/api/dispatch/current changed');
  const bad = await fetch(`${base}/api/dispatch`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'nope', json: '{}' }).toString() });
  ok(bad.status === 401, 'dispatch with bad token rejected');

  // 9. Pause request form + approve.
  const pr = await fetch(`${base}/api/pause-requests`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: srv.grokToken, displayName: 'smoke-helper', reason: 'smoke test' }).toString() });
  ok(pr.status === 200 && (await pr.text()).includes('Pause request filed'), 'pause request form post filed');
  const prId = (srv.db.prepare('SELECT id FROM pause_requests ORDER BY id DESC LIMIT 1').get() as any).id;
  const pausedP = withTimeout(new Promise<any>((res) => helper.on(EV.HELPER_PAUSED, (p: any) => { if (p.paused) res(p); })), 3000, 'helper:paused');
  const ap = await fetch(`${base}/api/pause-requests/${prId}/approve`, { method: 'POST', headers: { 'x-admin-token': srv.adminToken } });
  ok(ap.status === 200, 'pause request approved');
  ok((await pausedP).paused === true, 'helper received helper:paused');

  // 10. Stubs: TTS/STT report browser fallback, webhook rejects without token.
  ok((await post('/api/tts', { npcId: 'innkeeper', text: 'hi' })).status === 503, '/api/tts 503 fallback when ElevenLabs is not configured');
  ok((await post('/webhooks/quicknode', { matches: [] })).status === 401, '/webhooks/quicknode rejects unauthenticated calls');
  const earn = (await (await fetch(`${base}/api/earnings?room=${room.roomCode}`)).json()) as any;
  ok(earn.solanaConfigured === false && earn.helpers[0]?.usdc === 0, '/api/earnings shows 0 with Solana not configured');
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error('  FAIL', (e as Error).message);
  failures++;
} finally {
  for (const s of sockets) s.close();
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  code = failures ? 1 : 0;
  console.log(failures ? `\nSmoke FAILED (${failures} failures)` : '\nSmoke passed');
  process.exit(code);
}
