// `pnpm e2e:localnet`: drives the SERVER's own Solana client (apps/server/src/solana.ts) against a local
// validator running sidekick_pay, with a mock USDC mint: initialize_config, open_session, register_helper,
// settle, then decodes the settle tx logs with the same decoder the QuickNode webhook uses, then close_session.
// Start the validator first:
//   solana-test-validator --reset --bpf-program $(cat anchor/PROGRAM_ID.txt) anchor/target/deploy/sidekick_pay.so
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';

const RPC = process.env.LOCALNET_RPC ?? 'http://127.0.0.1:8899';
const root = resolve(import.meta.dirname, '..');
const PROGRAM_ID = readFileSync(resolve(root, 'anchor/PROGRAM_ID.txt'), 'utf8').trim();

function check(cond: unknown, msg: string) {
  if (!cond) { console.error(`  FAIL ${msg}`); process.exit(1); }
  console.log(`  ok   ${msg}`);
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const settler = Keypair.generate();
  const treasury = Keypair.generate();
  const helper = Keypair.generate();
  for (const kp of [settler, treasury]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  const mint = await createMint(conn, settler, settler.publicKey, null, 6);
  const treasuryAta = await getOrCreateAssociatedTokenAccount(conn, settler, mint, treasury.publicKey);
  await mintTo(conn, settler, mint, treasuryAta.address, settler, 100_000_000);
  check(true, `mock USDC mint ${mint.toBase58()}, treasury funded with 100 USDC`);

  // Configure the shared loader BEFORE importing server code (cfg is parsed at import time).
  Object.assign(process.env, {
    SOLANA_RPC_URL: RPC,
    DEV_TOOLS: '1',
    PROGRAM_ID,
    USDC_MINT: mint.toBase58(),
    SETTLER_KEYPAIR: JSON.stringify(Array.from(settler.secretKey)),
    TREASURY_KEYPAIR: JSON.stringify(Array.from(treasury.secretKey)),
  });
  const { solana, decodeSettlements, fetchTxLogs } = await import('../apps/server/src/solana');
  const { merkleRoot, receiptMessage, bytesToHex } = await import('../packages/shared/src/index');
  const client = solana();
  check(client, 'server Solana client is configured');
  const c = client!;

  // initialize_config (admin = treasury, as scripts/devnet-setup.ts does)
  const anchorMod: any = await import('@coral-xyz/anchor');
  const BN = anchorMod.BN ?? anchorMod.default?.BN;
  await (c.program.methods as any)
    .initializeConfig(new BN(1000), [10, 20, 2, 1], settler.publicKey)
    .accountsPartial({ admin: treasury.publicKey, usdcMint: mint })
    .signers([treasury])
    .rpc();
  check(true, 'initialize_config');

  const sessionId = BigInt(Date.now());
  const opened = await c.openSession(sessionId, 5_000_000);
  check(opened.sig, `open_session ${opened.sig.slice(0, 16)}...`);

  await c.registerHelper(helper.publicKey.toBase58());
  check(true, 'register_helper + helper USDC ATA created by settler');

  const leaves = [receiptMessage('job-1', 'areagen', 20, 'aa'), receiptMessage('job-2', 'pathfind', 2, 'bb')];
  const root32 = merkleRoot(leaves);
  const sig = await c.settle(sessionId, helper.publicKey.toBase58(), 22, root32);
  check(sig, `settle ${sig.slice(0, 16)}...`);

  const tx = await fetchTxLogs(sig);
  const logs: string[] = (tx as any)?.logs ?? (tx as any)?.meta?.logMessages ?? (tx as any) ?? [];
  const events = decodeSettlements(Array.isArray(logs) ? logs : []);
  check(events.length === 1, 'webhook decoder finds one JobsSettled event in the settle tx logs');
  const e = events[0];
  check(e.units === 22 && e.amount === 22_000, `event units=${e.units} amount=${e.amount} (22 units x 1000)`);
  check(e.helperWallet === helper.publicKey.toBase58(), 'event helper wallet matches');
  check(e.receiptsRoot === bytesToHex(root32), 'event receipts_root matches Merkle root');

  const helperAta = await getOrCreateAssociatedTokenAccount(conn, settler, mint, helper.publicKey);
  const bal = await getAccount(conn, helperAta.address);
  check(bal.amount === 22_000n, `helper USDC balance ${bal.amount} base units`);

  const closeSig = await c.closeSession(sessionId);
  check(closeSig, 'close_session refunded the vault');

  // ---------- Phase 2: the real server, settlement loop and webhook decoder on localnet ----------
  console.log('\nPhase 2: server settlement loop -> settle tx -> /dev/replay-tx -> settlements -> /api/earnings');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { startServer } = await import('../apps/server/src/app');
  const { EV, WORK_UNITS, newKeypair, signMessage } = await import('../packages/shared/src/index');
  const { runJob } = await import('../packages/jobs/src/index');
  const { io } = await import('socket.io-client');
  const srv = await startServer({ port: 0, host: '127.0.0.1', dbPath: join(mkdtempSync(join(tmpdir(), 'sk-e2e-')), 'e2e.sqlite'), quiet: true });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const room = (await (await post('/api/rooms', {})).json()) as any;
  const hk = newKeypair();
  const reg = (await (await post('/api/helpers/register', {
    roomCode: room.roomCode, pairSecret: room.pairSecret, email: 'e2e@example.com', displayName: 'e2e-helper', kind: 'laptop', helperPubKey: hk.publicKey,
  })).json()) as any;
  check(reg.wallet, `helper registered, custodial wallet ${reg.wallet}`);

  const helperSock = io(base, { transports: ['websocket'] });
  helperSock.on(EV.JOB_ASSIGN, (job: any) => {
    const r = runJob(job.type, job.input);
    const units = WORK_UNITS[job.type as 'simtick'];
    helperSock.emit(EV.JOB_RESULT, { jobId: job.jobId, helperId: reg.helperId, type: job.type, ok: true, output: r.output, outputHash: r.outputHash,
      workUnits: units, computeMs: r.computeMs, helperSig: signMessage(receiptMessage(job.jobId, job.type, units, r.outputHash), hk.secretKey) });
  });
  await new Promise((res) => helperSock.on('connect', () => helperSock.emit(EV.HELPER_HELLO, { helperToken: reg.helperToken,
    caps: { kind: 'laptop', jobTypes: ['simtick'], cpuThreads: 1, ollama: false, displayName: 'e2e-helper' }, helperPubKey: hk.publicKey }, res)));
  const gk = newKeypair();
  const game = io(base, { transports: ['websocket'] });
  await new Promise((res) => game.on('connect', () => game.emit(EV.ROOM_JOIN, { roomCode: room.roomCode, gamePubKey: gk.publicKey }, res)));
  game.on(EV.JOB_RESULT, (r: any) => game.emit(EV.RECEIPT_COUNTERSIGN, { jobId: r.jobId, gameSig: signMessage(receiptMessage(r.jobId, r.type, r.workUnits, r.outputHash), gk.secretKey) }));
  for (let i = 0; i < 10; i++) {
    game.emit(EV.JOB_SUBMIT, { jobId: randomUUID(), roomCode: room.roomCode, type: 'simtick', createdAt: Date.now(), deadlineMs: 4000, input: { seed: 1, tick: i, npcCount: 100, areaIds: ['village'] } });
  }
  // Wait (event-driven polling of the DB, not compute) for the settlement loop to send settle.
  let settledTx: string | undefined;
  for (let i = 0; i < 60 && !settledTx; i++) {
    settledTx = (srv.db.prepare('SELECT settled_tx FROM receipts WHERE settled_tx IS NOT NULL AND settled_tx NOT LIKE \'pending%\' LIMIT 1').get() as any)?.settled_tx;
    if (!settledTx) await new Promise((r) => setTimeout(r, 500));
  }
  check(settledTx, `settlement loop sent settle for 10 receipts: ${settledTx}`);
  const before = (srv.db.prepare('SELECT COUNT(*) n FROM settlements').get() as any).n;
  check(before === 0, 'settlement loop wrote no settlements rows (only the webhook path may)');
  const rep = await post('/dev/replay-tx', { signature: settledTx });
  check(rep.ok, `/dev/replay-tx ${rep.status}`);
  const earn = (await (await fetch(`${base}/api/earnings?room=${room.roomCode}`)).json()) as any;
  const h = earn.helpers?.find((x: any) => x.helperId === reg.helperId);
  check(h && h.units === 10, `/api/earnings shows ${h?.units} units, ${h?.usdc} USDC for e2e-helper (from settlements table)`);
  helperSock.close(); game.close(); await srv.close?.();
  console.log('\nlocalnet e2e passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
