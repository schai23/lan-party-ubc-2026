// Shared contracts for Sidekick. Spec section 6. These are FROZEN: every app imports from here.
import { z } from 'zod';

export const JOB_TYPES = ['dialogue', 'pathfind', 'areagen', 'simtick'] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

/** Work units credited per job. Must match on-chain Config.job_weights. */
export const WORK_UNITS: Record<JobType, number> = { dialogue: 10, areagen: 20, pathfind: 2, simtick: 1 };

/** Routing deadline per job type (ms). */
export const DEADLINES_MS: Record<JobType, number> = { dialogue: 8000, pathfind: 400, areagen: 6000, simtick: 4000 };

/** Order of job_weights in the on-chain Config account: [dialogue, areagen, pathfind, simtick]. */
export const ONCHAIN_WEIGHT_ORDER: JobType[] = ['dialogue', 'areagen', 'pathfind', 'simtick'];

export const NPC_IDS = ['innkeeper', 'blacksmith', 'oracle'] as const;
export const NpcIdSchema = z.enum(NPC_IDS);
export type NpcId = z.infer<typeof NpcIdSchema>;

export const DialogueInputSchema = z.object({
  npcId: NpcIdSchema,
  persona: z.string(),
  worldEvent: z.string(),
  quest: z.string(),
  playerLine: z.string(),
  history: z.array(z.object({ role: z.enum(['player', 'npc']), text: z.string() })),
});
export type DialogueInput = z.infer<typeof DialogueInputSchema>;

export const PathfindInputSchema = z.object({
  gridId: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  walkableB64: z.string(), // 1 byte per cell, 0/1
  densityB64: z.string(), // 1 byte per cell, 0..255
  targets: z.array(z.object({ id: z.string(), x: z.number().int(), y: z.number().int() })),
});
export type PathfindInput = z.infer<typeof PathfindInputSchema>;

export const AreagenInputSchema = z.object({
  seed: z.number().int(),
  theme: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  buildingTypes: z.array(z.string()),
});
export type AreagenInput = z.infer<typeof AreagenInputSchema>;

export const SimtickInputSchema = z.object({
  seed: z.number().int(),
  tick: z.number().int(),
  npcCount: z.number().int().nonnegative(),
  areaIds: z.array(z.string()),
});
export type SimtickInput = z.infer<typeof SimtickInputSchema>;

export const JobSchema = z.object({
  jobId: z.string(),
  roomCode: z.string(),
  type: JobTypeSchema,
  createdAt: z.number(),
  deadlineMs: z.number(),
  input: z.union([DialogueInputSchema, PathfindInputSchema, AreagenInputSchema, SimtickInputSchema]),
});
export type Job = z.infer<typeof JobSchema>;

// ---------- Job outputs (produced by packages/jobs) ----------
export interface DialogueOutput { text: string; model: string }
export interface PathfindOutput { gridId: string; fields: { targetId: string; dirsB64: string }[] }
export interface AreagenOutput {
  tiles: number[];
  buildings: { type: string; x: number; y: number; w: number; h: number }[];
  loot: { x: number; y: number; item: string }[];
  paths: number[]; // flat cell indices that are path tiles
}
export interface SimtickOutput {
  prices: Record<string, number>;
  schedules: { npc: string; areaId: string; activity: string }[];
  weather: string;
}

export const JobResultSchema = z.object({
  jobId: z.string(),
  helperId: z.string(),
  type: JobTypeSchema,
  ok: z.boolean(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  outputHash: z.string(),
  workUnits: z.number().int(),
  computeMs: z.number(),
  helperSig: z.string(), // hex ed25519 signature over receiptMessage
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const ReceiptSchema = z.object({
  jobId: z.string(),
  helperId: z.string(),
  type: JobTypeSchema,
  workUnits: z.number().int(),
  outputHash: z.string(),
  helperSig: z.string(),
  gameSig: z.string(),
  createdAt: z.number(),
  settledTx: z.string().optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const DispatchSchema = z.object({
  date: z.string(),
  source: z.enum(['grok-bot', 'default']),
  worldEvent: z.object({ title: z.string().min(1).max(120), summary: z.string().min(1).max(600) }),
  quests: z.array(z.object({ npcId: z.string(), title: z.string(), description: z.string() })).max(10),
  fallbackLines: z.object({
    innkeeper: z.array(z.string()).max(20),
    blacksmith: z.array(z.string()).max(20),
    oracle: z.array(z.string()).max(20),
  }),
  area: z.object({ theme: z.string(), seed: z.number().int(), buildingTypes: z.array(z.string()).min(1) }),
  loreMentions: z.array(z.string()).max(3),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

export const HelperCapsSchema = z.object({
  kind: z.enum(['laptop', 'phone']),
  jobTypes: z.array(JobTypeSchema),
  cpuThreads: z.number().int().positive(),
  ollama: z.boolean(),
  dialogueModel: z.string().optional(),
  displayName: z.string(),
});
export type HelperCaps = z.infer<typeof HelperCapsSchema>;

// ---------- HTTP payloads ----------
export const CreateRoomResponseSchema = z.object({ roomCode: z.string(), pairSecret: z.string(), pairUrl: z.string() });
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const RegisterHelperRequestSchema = z.object({
  roomCode: z.string(),
  pairSecret: z.string(),
  wallet: z.string().optional(), // Privy embedded wallet address; empty => server custodial fallback
  email: z.string().optional(), // used for custodial fallback keypair
  displayName: z.string().min(1).max(40),
  kind: z.enum(['laptop', 'phone']),
  helperPubKey: z.string(), // hex ed25519 public key
});
export type RegisterHelperRequest = z.infer<typeof RegisterHelperRequestSchema>;

export const RegisterHelperResponseSchema = z.object({
  helperId: z.string(),
  helperToken: z.string(),
  wallet: z.string(),
  runnerCommand: z.string(),
});
export type RegisterHelperResponse = z.infer<typeof RegisterHelperResponseSchema>;

export interface RosterEntry { helperId: string; displayName: string; caps: HelperCaps; busy: boolean; paused: boolean; inflight: number }

/** Settlement row as decoded from the QuickNode webhook (the only source of earnings). */
export interface SettlementRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  session: string;
  helperWallet: string;
  units: number;
  amount: number; // USDC base units (6 decimals)
  receiptsRoot: string;
  source: string; // 'quicknode' | 'dev-replay'
}

export interface EarningsUpdate {
  roomCode?: string;
  latest?: SettlementRow & { explorerUrl: string; displayName?: string };
  helpers: { helperId: string; displayName: string; wallet: string; units: number; usdc: number; rank: number }[];
  solanaConfigured: boolean;
}

export interface IntegrationStatus { name: string; configured: boolean; missing: string[]; stub: string }
