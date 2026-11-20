// pnpm setup:devnet
// One-shot devnet bootstrap for sidekick_pay (spec 11):
//   - loads SETTLER_KEYPAIR / TREASURY_KEYPAIR from the root .env
//   - prints addresses and SOL / USDC balances (with faucet links when empty)
//   - creates the treasury USDC ATA
//   - initializes the Config PDA if it does not exist yet
//   - prints the explorer link for the program
// Safe to run with an empty .env: it prints what is missing and exits 0.
import * as anchorNs from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg, parseKeypairJson, REPO_ROOT } from '../packages/shared/src/config';

// @coral-xyz/anchor is CommonJS: under ESM some exports (e.g. BN) only exist on the default export.
const anchor = ((anchorNs as { default?: typeof anchorNs }).default ?? anchorNs) as typeof anchorNs;

const UNIT_PRICE = 1_000; // 0.001 USDC per work unit
const JOB_WEIGHTS = [10, 20, 2, 1]; // dialogue, areagen, pathfind, simtick
const IDL_PATH = resolve(REPO_ROOT, 'apps/server/src/idl/sidekick_pay.json');
const PROGRAM_ID_FILE = resolve(REPO_ROOT, 'anchor/PROGRAM_ID.txt');
const SOL_FAUCET = 'https://faucet.solana.com';
const USDC_FAUCET = 'https://faucet.circle.com';

const explorer = (kind: 'address' | 'tx', id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;

function programIdOrUndefined(): string | undefined {
  if (cfg.PROGRAM_ID) return cfg.PROGRAM_ID;
  if (existsSync(PROGRAM_ID_FILE)) return readFileSync(PROGRAM_ID_FILE, 'utf8').trim() || undefined;
  return undefined;
}

function walletFor(kp: Keypair): anchorNs.Wallet {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([kp]);
    else tx.partialSign(kp);
    return tx;
  };
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  } as anchorNs.Wallet;
}

async function usdcBalance(conn: Connection, mint: PublicKey, owner: PublicKey): Promise<number | null> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  try {
    const bal = await conn.getTokenAccountBalance(ata, 'confirmed');
    return bal.value.uiAmount ?? 0;
  } catch {
    return null; // ATA does not exist
  }
}

async function main() {
  const settler = parseKeypairJson(cfg.SETTLER_KEYPAIR);
  const treasury = parseKeypairJson(cfg.TREASURY_KEYPAIR);
  const programIdStr = programIdOrUndefined();

  if (!settler || !treasury) {
    console.log('sidekick devnet setup: keys missing, nothing to do yet.\n');
    if (!settler) console.log(`  - SETTLER_KEYPAIR ${cfg.SETTLER_KEYPAIR ? 'is not a valid 64-byte JSON array' : 'is not set'}`);
    if (!treasury) console.log(`  - TREASURY_KEYPAIR ${cfg.TREASURY_KEYPAIR ? 'is not a valid 64-byte JSON array' : 'is not set'}`);
    console.log(`
Create them with the Solana CLI and paste the JSON arrays into the root .env:
  solana-keygen new --no-bip39-passphrase -o settler.json   # SETTLER_KEYPAIR=$(cat settler.json)
  solana-keygen new --no-bip39-passphrase -o treasury.json  # TREASURY_KEYPAIR=$(cat treasury.json)
Optional: SOLANA_RPC_URL (QuickNode devnet endpoint; defaults to ${clusterApiUrl('devnet')}),
          PROGRAM_ID (defaults to anchor/PROGRAM_ID.txt${programIdStr ? ` = ${programIdStr}` : ''}).
Then fund them: SOL from ${SOL_FAUCET}, devnet USDC (treasury) from ${USDC_FAUCET}, and re-run pnpm setup:devnet.`);
    return;
  }
  if (!programIdStr) {
    console.log('PROGRAM_ID is not set and anchor/PROGRAM_ID.txt is missing. Run `anchor keys sync` in /anchor first.');
    return;
  }

  const settlerKp = Keypair.fromSecretKey(settler);
  const treasuryKp = Keypair.fromSecretKey(treasury);
  const programId = new PublicKey(programIdStr);
  const mint = new PublicKey(cfg.USDC_MINT);
  const rpc = cfg.SOLANA_RPC_URL ?? clusterApiUrl('devnet');
  const conn = new Connection(rpc, { commitment: 'confirmed', wsEndpoint: cfg.SOLANA_WS_URL });

  console.log(`RPC:        ${rpc}`);
  console.log(`Program:    ${programId.toBase58()}  ${explorer('address', programId.toBase58())}`);
  console.log(`USDC mint:  ${mint.toBase58()}`);

  const rows: { name: string; kp: Keypair }[] = [
    { name: 'settler', kp: settlerKp },
    { name: 'treasury', kp: treasuryKp },
  ];
  const sol: Record<string, number> = {};
  const usdc: Record<string, number | null> = {};
  for (const r of rows) {
    sol[r.name] = (await conn.getBalance(r.kp.publicKey)) / LAMPORTS_PER_SOL;
    usdc[r.name] = await usdcBalance(conn, mint, r.kp.publicKey);
    console.log(
      `${r.name.padEnd(10)}  ${r.kp.publicKey.toBase58()}  SOL ${sol[r.name].toFixed(4)}  USDC ${
        usdc[r.name] === null ? '(no ATA)' : usdc[r.name]
      }`,
    );
  }

  const todo: string[] = [];
  if (sol.settler === 0) todo.push(`Fund the settler with devnet SOL: ${SOL_FAUCET} -> ${settlerKp.publicKey.toBase58()}`);
  if (sol.treasury === 0) todo.push(`Fund the treasury with devnet SOL: ${SOL_FAUCET} -> ${treasuryKp.publicKey.toBase58()}`);
  if (!usdc.treasury)
    todo.push(
      `Fund the treasury with devnet USDC (budget ${cfg.SESSION_BUDGET_USDC} USDC per session): ${USDC_FAUCET} (Solana Devnet) -> ${treasuryKp.publicKey.toBase58()}`,
    );

  // Treasury USDC ATA (treasury pays rent).
  if (usdc.treasury === null) {
    if (sol.treasury > 0) {
      const ata = await getOrCreateAssociatedTokenAccount(conn, treasuryKp, mint, treasuryKp.publicKey, false, 'confirmed');
      console.log(`Created treasury USDC ATA ${ata.address.toBase58()}`);
    } else {
      todo.push('Re-run after funding the treasury with SOL to create its USDC ATA.');
    }
  } else {
    console.log(`Treasury USDC ATA ${getAssociatedTokenAddressSync(mint, treasuryKp.publicKey).toBase58()} exists`);
  }

  // Program + Config.
  const programInfo = await conn.getAccountInfo(programId);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  if (!programInfo?.executable) {
    todo.push(
      'Deploy the program (needs ~3 SOL on the deployer wallet): cd anchor && anchor build && ' +
        'anchor deploy --provider.cluster devnet --provider.wallet <funded keypair.json> ' +
        '(uses anchor/target/deploy/sidekick_pay-keypair.json so the program ID stays the same). Then re-run.',
    );
  } else if (await conn.getAccountInfo(configPda)) {
    console.log(`Config ${configPda.toBase58()} already initialized`);
  } else if (sol.treasury === 0) {
    todo.push('Re-run after funding the treasury with SOL to initialize Config.');
  } else if (!existsSync(IDL_PATH)) {
    todo.push(`IDL missing at ${IDL_PATH}; run anchor build and copy target/idl/sidekick_pay.json there.`);
  } else {
    const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8'));
    idl.address = programId.toBase58();
    const provider = new anchor.AnchorProvider(conn, walletFor(treasuryKp), { commitment: 'confirmed' });
    const program = new anchor.Program(idl, provider);
    const sig = await program.methods
      .initializeConfig(new anchor.BN(UNIT_PRICE), JOB_WEIGHTS, settlerKp.publicKey)
      .accountsPartial({ admin: treasuryKp.publicKey, config: configPda, usdcMint: mint })
      .rpc();
    console.log(`Initialized Config ${configPda.toBase58()} (admin=treasury, settler=${settlerKp.publicKey.toBase58()})`);
    console.log(`  tx ${explorer('tx', sig)}`);
  }

  console.log(`\nExplorer: ${explorer('address', programId.toBase58())}`);
  if (todo.length) {
    console.log('\nNext steps:');
    for (const t of todo) console.log(`  - ${t}`);
  } else {
    console.log('\nDevnet setup complete.');
  }
}

main().catch((e) => {
  console.error('devnet setup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
