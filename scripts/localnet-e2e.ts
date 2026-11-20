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
  console.log('\nlocalnet e2e passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
