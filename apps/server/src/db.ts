// SQLite storage (spec 8.1). One file at DB_PATH. Tables match the spec; `custodial_wallets`
// backs the demo custodial mode when Privy is not configured (spec 9.2 / 14a).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, pair_secret TEXT NOT NULL, game_pubkey TEXT, created_at INTEGER NOT NULL,
      session_id TEXT, session_pda TEXT, budget INTEGER, status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE TABLE IF NOT EXISTS helpers (
      id TEXT PRIMARY KEY, room_code TEXT NOT NULL, display_name TEXT NOT NULL, wallet TEXT NOT NULL,
      helper_pubkey TEXT NOT NULL, token TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, caps_json TEXT,
      paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      job_id TEXT PRIMARY KEY, helper_id TEXT NOT NULL, type TEXT NOT NULL, work_units INTEGER NOT NULL,
      output_hash TEXT NOT NULL, helper_sig TEXT NOT NULL, game_sig TEXT, created_at INTEGER NOT NULL, settled_tx TEXT
    );
    CREATE TABLE IF NOT EXISTS settlements (
      signature TEXT PRIMARY KEY, slot INTEGER, block_time INTEGER, session TEXT, helper_wallet TEXT,
      units INTEGER, amount INTEGER, receipts_root TEXT, source TEXT
    );
    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pause_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, helper_id TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS job_log (
      job_id TEXT, type TEXT, helper_id TEXT, ok INTEGER, compute_ms REAL, latency_ms REAL, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS custodial_wallets (
      email TEXT PRIMARY KEY, pubkey TEXT NOT NULL, secret_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_helper ON receipts(helper_id);
    CREATE INDEX IF NOT EXISTS idx_job_log_created ON job_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_settlements_wallet ON settlements(helper_wallet);
  `);
  return db;
}

export interface RoomRow {
  code: string; pair_secret: string; game_pubkey: string | null; created_at: number;
  session_id: string | null; session_pda: string | null; budget: number | null; status: string;
}
export interface HelperRow {
  id: string; room_code: string; display_name: string; wallet: string; helper_pubkey: string; token: string;
  kind: 'laptop' | 'phone'; caps_json: string | null; paused: number; created_at: number;
}
export interface ReceiptRow {
  job_id: string; helper_id: string; type: string; work_units: number; output_hash: string; helper_sig: string;
  game_sig: string | null; created_at: number; settled_tx: string | null;
}
export interface SettlementDbRow {
  signature: string; slot: number; block_time: number | null; session: string; helper_wallet: string;
  units: number; amount: number; receipts_root: string; source: string;
}
