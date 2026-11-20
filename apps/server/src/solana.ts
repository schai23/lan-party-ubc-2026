// Solana integration for the sidekick_pay Anchor program (spec 11).
// The IDL is loaded lazily from src/idl/sidekick_pay.json; if it (or any key) is missing, Solana is
// treated as not configured and the server runs in stub mode (spec 14a).
import anchorPkg from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { bytesToHex } from '@sidekick/shared';
import { cfg, integrationStatus, parseKeypairJson } from '@sidekick/shared/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { AnchorProvider, BN, BorshCoder, EventParser, Program, Wallet } = anchorPkg;

const IDL_PATH = process.env.SIDEKICK_IDL_PATH || resolve(dirname(fileURLToPath(import.meta.url)), 'idl/sidekick_pay.json');
export const DEFAULT_RPC = 'https://api.devnet.solana.com';

let idlCache: Idl | null | undefined;
/** Load the IDL lazily (it is written by the Anchor build in parallel). Returns null if absent/invalid. */
export function loadIdl(): Idl | null {
  if (idlCache) return idlCache;
  if (!existsSync(IDL_PATH)) return null; // re-check on every call until it shows up
  try {
    const idl = JSON.parse(readFileSync(IDL_PATH, 'utf8')) as Idl & { address?: string; metadata?: { address?: string } };
    if (!idl.address) idl.address = cfg.PROGRAM_ID ?? idl.metadata?.address ?? '';
    if (cfg.PROGRAM_ID) idl.address = cfg.PROGRAM_ID;
    idlCache = idl;
    return idl;
  } catch (e) {
    console.warn('[solana] failed to parse IDL:', (e as Error).message);
    idlCache = null;
    return null;
  }
}

export function programIdString(): string | undefined {
  return cfg.PROGRAM_ID ?? (loadIdl() as any)?.address ?? undefined;
}

/** True when keys + IDL are present, so the server sends real transactions. */
export function solanaConfigured(): boolean {
  const row = integrationStatus().find((r) => r.name.startsWith('Solana'));
  return !!row?.configured && !!loadIdl();
}

// ---------- event decoding (used by the QuickNode webhook and /dev/replay-tx) ----------
export interface DecodedSettlement {
  session: string;
  helperWallet: string;
  units: number;
  amount: number;
  receiptsRoot: string;
  totalUnits: number;
  totalEarned: number;
}

const toStr = (v: any) => (v && typeof v.toBase58 === 'function' ? v.toBase58() : String(v));
const toNum = (v: any) => (v == null ? 0 : typeof v === 'number' ? v : Number(v.toString()));
const toHex = (v: any) => (v == null ? '' : typeof v === 'string' ? v : bytesToHex(Uint8Array.from(v)));

/** Decode `Program data:` log lines into JobsSettled events. Returns [] if the IDL/program id is unknown. */
export function decodeSettlements(logs: string[]): DecodedSettlement[] {
  const idl = loadIdl();
  const pid = programIdString();
  if (!idl || !pid) return [];
  const out: DecodedSettlement[] = [];
  try {
    const parser = new EventParser(new PublicKey(pid), new BorshCoder(idl));
    for (const ev of parser.parseLogs(logs, false)) {
      if (ev.name !== 'JobsSettled' && ev.name !== 'jobsSettled') continue;
      const d = ev.data as any;
      out.push({
        session: toStr(d.session),
        helperWallet: toStr(d.helper ?? d.helper_wallet ?? d.helperWallet),
        units: toNum(d.units),
        amount: toNum(d.amount),
        receiptsRoot: toHex(d.receipts_root ?? d.receiptsRoot),
        totalUnits: toNum(d.total_units ?? d.totalUnits),
        totalEarned: toNum(d.total_earned ?? d.totalEarned),
      });
    }
  } catch (e) {
    console.warn('[solana] event decode failed:', (e as Error).message);
  }
  return out;
}

export function connection(): Connection {
  return new Connection(cfg.SOLANA_RPC_URL ?? DEFAULT_RPC, { commitment: 'confirmed', wsEndpoint: cfg.SOLANA_WS_URL });
}

// ---------- transaction client ----------
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

class SolanaClient {
  conn = connection();
  settler = Keypair.fromSecretKey(parseKeypairJson(cfg.SETTLER_KEYPAIR)!);
  treasury = Keypair.fromSecretKey(parseKeypairJson(cfg.TREASURY_KEYPAIR)!);
  mint = new PublicKey(cfg.USDC_MINT);
  idl = loadIdl()!;
  programId = new PublicKey(programIdString()!);
  provider = new AnchorProvider(this.conn, new Wallet(this.settler), { commitment: 'confirmed' });
  program = new Program(this.idl, this.provider);
  unitPrice: number | null = null;

  configPda() { return PublicKey.findProgramAddressSync([Buffer.from('config')], this.programId)[0]; }
  sessionPda(sessionId: bigint) {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(sessionId);
    return PublicKey.findProgramAddressSync([Buffer.from('session'), this.treasury.publicKey.toBuffer(), le], this.programId)[0];
  }
  helperPda(wallet: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from('helper'), wallet.toBuffer()], this.programId)[0]; }

  /** Fill the accounts the IDL asks for by name (we do not hard-code the program's account names). */
  accountsFor(ixName: string, ctx: { sessionId?: bigint; helperWallet?: PublicKey }): Record<string, PublicKey> {
    const ix = (this.idl.instructions as any[]).find((i) => i.name === ixName || camel(i.name) === camel(ixName));
    if (!ix) throw new Error(`instruction ${ixName} not in IDL`);
    const session = ctx.sessionId != null ? this.sessionPda(ctx.sessionId) : undefined;
    const map: Record<string, PublicKey> = {};
    const pick = (name: string): PublicKey | undefined => {
      const n = name.toLowerCase().replace(/_/g, '');
      if (n === 'config') return this.configPda();
      if (n === 'session') return session;
      if (n.includes('vault')) return session && getAssociatedTokenAddressSync(this.mint, session, true);
      if (n === 'helperstats' || n === 'stats') return ctx.helperWallet && this.helperPda(ctx.helperWallet);
      if (n.startsWith('helper') && (n.includes('ata') || n.includes('token') || n.includes('usdc')))
        return ctx.helperWallet && getAssociatedTokenAddressSync(this.mint, ctx.helperWallet, true);
      if (n === 'helper' || n === 'helperwallet') return ctx.helperWallet;
      if (n.startsWith('treasury') && (n.includes('ata') || n.includes('token') || n.includes('usdc')))
        return getAssociatedTokenAddressSync(this.mint, this.treasury.publicKey);
      if (n === 'treasury') return this.treasury.publicKey;
      if (n === 'settler' || n === 'payer' || n === 'admin' || n === 'authority') return this.settler.publicKey;
      if (n === 'usdcmint' || n === 'mint') return this.mint;
      if (n === 'tokenprogram') return TOKEN_PROGRAM_ID;
      if (n === 'associatedtokenprogram') return ASSOCIATED_TOKEN_PROGRAM_ID;
      if (n === 'systemprogram') return SystemProgram.programId;
      if (n === 'rent') return SYSVAR_RENT_PUBKEY;
      return undefined;
    };
    for (const a of ix.accounts ?? []) {
      const pk = pick(a.name);
      if (pk) map[camel(a.name)] = pk;
    }
    return map;
  }

  async getUnitPrice(): Promise<number> {
    if (this.unitPrice != null) return this.unitPrice;
    try {
      const acc: any = await (this.program.account as any).config.fetch(this.configPda());
      this.unitPrice = toNum(acc.unitPrice ?? acc.unit_price);
    } catch {
      this.unitPrice = 1_000;
    }
    return this.unitPrice!;
  }

  async openSession(sessionId: bigint, budget: number): Promise<{ sig: string; sessionPda: string }> {
    const sig = await (this.program.methods as any)
      .openSession(new BN(sessionId.toString()), new BN(budget))
      .accountsPartial(this.accountsFor('open_session', { sessionId }))
      .signers([this.treasury])
      .rpc();
    return { sig, sessionPda: this.sessionPda(sessionId).toBase58() };
  }

  async registerHelper(wallet: string): Promise<void> {
    const w = new PublicKey(wallet);
    await getOrCreateAssociatedTokenAccount(this.conn, this.settler, this.mint, w, true);
    const stats = await this.conn.getAccountInfo(this.helperPda(w));
    if (stats) return;
    await (this.program.methods as any)
      .registerHelper(w)
      .accountsPartial(this.accountsFor('register_helper', { helperWallet: w }))
      .rpc();
  }

  async settle(sessionId: bigint, helperWallet: string, units: number, root: Uint8Array): Promise<string> {
    const w = new PublicKey(helperWallet);
    return (this.program.methods as any)
      .settle(new BN(sessionId.toString()), new BN(units), Array.from(root))
      .accountsPartial(this.accountsFor('settle', { sessionId, helperWallet: w }))
      .rpc();
  }

  async closeSession(sessionId: bigint): Promise<string> {
    return (this.program.methods as any)
      .closeSession(new BN(sessionId.toString()))
      .accountsPartial(this.accountsFor('close_session', { sessionId }))
      .rpc();
  }
}

let client: SolanaClient | null = null;
/** The tx client, or null when Solana is not configured. */
export function solana(): SolanaClient | null {
  if (!solanaConfigured()) return null;
  if (!client) {
    try {
      client = new SolanaClient();
    } catch (e) {
      console.warn('[solana] client init failed:', (e as Error).message);
      return null;
    }
  }
  return client;
}

export async function fetchTxLogs(signature: string) {
  const tx = await connection().getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta?.logMessages ?? [] };
}
