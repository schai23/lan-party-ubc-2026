// Single config loader for server, runner and scripts (spec 14a). Node only.
// Reads the ROOT .env. Every external value is optional so the code runs with an empty .env.
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { IntegrationStatus } from './types';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = resolve(REPO_ROOT, '.env');
if (existsSync(envPath)) loadDotenv({ path: envPath });

const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const ConfigSchema = z.object({
  PORT: opt.transform((v) => Number(v ?? 8787)),
  PUBLIC_BASE_URL: opt,
  LAN_MODE: opt.transform((v) => v === '1'),
  DEV_TOOLS: opt.transform((v) => v === '1'),
  DB_PATH: opt,
  SOLANA_RPC_URL: opt,
  SOLANA_WS_URL: opt,
  PROGRAM_ID: opt,
  USDC_MINT: opt.transform((v) => v ?? DEVNET_USDC_MINT),
  SETTLER_KEYPAIR: opt,
  TREASURY_KEYPAIR: opt,
  SESSION_BUDGET_USDC: opt.transform((v) => Number(v ?? 5)),
  ELEVENLABS_API_KEY: opt,
  ELEVENLABS_TTS_MODEL: opt.transform((v) => v ?? 'eleven_flash_v2_5'),
  ELEVENLABS_STT_MODEL: opt.transform((v) => v ?? 'scribe_v1'),
  VOICE_ID_INNKEEPER: opt,
  VOICE_ID_BLACKSMITH: opt,
  VOICE_ID_ORACLE: opt,
  QUICKNODE_STREAM_TOKEN: opt,
  ADMIN_TOKEN: opt,
  GROK_TOKEN: opt,
  PRIVY_APP_ID: opt,
  PRIVY_APP_SECRET: opt,
  VITE_SERVER_URL: opt,
  VITE_PRIVY_APP_ID: opt,
  VITE_LOCAL_OLLAMA_URL: opt.transform((v) => v ?? 'http://localhost:11434'),
  SIDEKICK_SERVER: opt,
  SIDEKICK_TOKEN: opt,
  OLLAMA_HOST: opt.transform((v) => v ?? 'http://127.0.0.1:11434'),
  DIALOGUE_MODEL: opt.transform((v) => v ?? 'llama3.1:8b'),
  EMBED_MODEL: opt.transform((v) => v ?? 'nomic-embed-text'),
});

export type SidekickConfig = z.infer<typeof ConfigSchema>;
export const cfg: SidekickConfig = ConfigSchema.parse(process.env);

export function parseKeypairJson(v: string | undefined): Uint8Array | undefined {
  if (!v) return undefined;
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length === 64) return Uint8Array.from(arr);
  } catch {}
  return undefined;
}

/** Integration table used by `pnpm check:config`, /status, /status.json and the load panel. */
export function integrationStatus(c: SidekickConfig = cfg): IntegrationStatus[] {
  const need = (keys: (keyof SidekickConfig)[]) => keys.filter((k) => !c[k]);
  const rows: { name: string; keys: (keyof SidekickConfig)[]; stub: string; extra?: string[] }[] = [
    {
      name: 'Solana (sidekick_pay settle)',
      keys: ['PROGRAM_ID', 'SOLANA_RPC_URL', 'SETTLER_KEYPAIR', 'TREASURY_KEYPAIR'],
      stub: 'Receipts verified and stored; settlement loop logs "would settle N units"; no txs sent',
      extra: [
        ...(c.SETTLER_KEYPAIR && !parseKeypairJson(c.SETTLER_KEYPAIR) ? ['SETTLER_KEYPAIR (invalid JSON array)'] : []),
        ...(c.TREASURY_KEYPAIR && !parseKeypairJson(c.TREASURY_KEYPAIR) ? ['TREASURY_KEYPAIR (invalid JSON array)'] : []),
      ],
    },
    {
      name: 'QuickNode Streams webhook',
      keys: ['QUICKNODE_STREAM_TOKEN'],
      stub: 'Webhook rejects all calls; earnings stay 0 (use POST /dev/replay-tx with DEV_TOOLS=1)',
    },
    {
      name: 'ElevenLabs (STT, TTS, SFX)',
      keys: ['ELEVENLABS_API_KEY', 'VOICE_ID_INNKEEPER', 'VOICE_ID_BLACKSMITH', 'VOICE_ID_ORACLE'],
      stub: 'Voice: browser fallback (Web Speech recognition + speechSynthesis)',
    },
    {
      name: 'Privy embedded wallets',
      keys: ['VITE_PRIVY_APP_ID'],
      stub: 'Demo custodial mode: server creates a devnet keypair per email',
    },
    {
      name: 'Grok Bot tokens',
      keys: ['GROK_TOKEN', 'ADMIN_TOKEN'],
      stub: 'Random tokens generated at startup and printed once to the server log',
    },
    {
      name: 'Public URL (Railway)',
      keys: ['PUBLIC_BASE_URL'],
      stub: 'Defaults to http://localhost:PORT (LAN IP if LAN_MODE=1)',
    },
  ];
  return rows.map((r) => {
    const missing = [...need(r.keys), ...(r.extra ?? [])];
    return { name: r.name, configured: missing.length === 0, missing, stub: missing.length ? r.stub : '' };
  });
}

export function formatIntegrationTable(rows = integrationStatus()): string {
  const w = [32, 11];
  const lines = [
    `${'Integration'.padEnd(w[0])} ${'Status'.padEnd(w[1])} Missing keys / stub behavior`,
    `${'-'.repeat(w[0])} ${'-'.repeat(w[1])} ${'-'.repeat(40)}`,
  ];
  for (const r of rows) {
    lines.push(`${r.name.padEnd(w[0])} ${(r.configured ? 'configured' : 'missing').padEnd(w[1])} ${r.missing.join(', ')}`);
    if (!r.configured) lines.push(`${''.padEnd(w[0] + w[1] + 2)}stub: ${r.stub}`);
  }
  return lines.join('\n');
}
