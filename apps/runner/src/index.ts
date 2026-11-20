// Sidekick laptop runner (spec 10).
//   pnpm runner --server URL --token TOKEN --jobs dialogue,areagen,pathfind,simtick [--model llama3.1:8b] [--threads N]
import { hashOutput } from '@sidekick/jobs';
import {
  EV, JOB_TYPES, WORK_UNITS, newKeypair, receiptMessage, signMessage,
  type DialogueInput, type HelperCaps, type Job, type JobResult, type JobType, type PathfindInput, type PathfindOutput,
} from '@sidekick/shared';
import { cfg } from '@sidekick/shared/config';
import { Ollama } from 'ollama';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { NpcMemory } from './memory';
import { Pool } from './pool';

// ---------- args (tolerates the `--` that pnpm inserts when passing args through) ----------
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const a = argv.filter((x) => x !== '--');
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const [k, v] = a[i].slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (a[i + 1] && !a[i + 1].startsWith('--')) out[k] = a[++i];
    else out[k] = 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const server = (args.server ?? cfg.SIDEKICK_SERVER ?? '').replace(/\/$/, '');
const token = args.token ?? cfg.SIDEKICK_TOKEN ?? '';
const model = args.model ?? cfg.DIALOGUE_MODEL;
const threads = Math.max(1, Number(args.threads) || cpus().length - 2);
let jobTypes = (args.jobs ?? JOB_TYPES.join(','))
  .split(',').map((s) => s.trim()).filter((s): s is JobType => (JOB_TYPES as readonly string[]).includes(s));

if (!server || !token) {
  console.error('Usage: pnpm runner --server URL --token TOKEN --jobs dialogue,areagen,pathfind,simtick [--model llama3.1:8b] [--threads N]');
  console.error('(or set SIDEKICK_SERVER and SIDEKICK_TOKEN in .env)');
  process.exit(1);
}

// ---------- helper key (~/.sidekick/helper-key.json) ----------
function loadKey(): { publicKey: string; secretKey: string } {
  const dir = join(homedir(), '.sidekick');
  const path = join(dir, 'helper-key.json');
  if (existsSync(path)) {
    try {
      const k = JSON.parse(readFileSync(path, 'utf8'));
      if (k.publicKey && k.secretKey) return k;
    } catch {}
  }
  mkdirSync(dir, { recursive: true });
  const k = newKeypair();
  writeFileSync(path, JSON.stringify(k, null, 2), { mode: 0o600 });
  console.log(`Generated helper key at ${path}`);
  return k;
}
const key = loadKey();

// ---------- Ollama detection ----------
const ollama = new Ollama({ host: cfg.OLLAMA_HOST });
const memory = new NpcMemory(ollama, cfg.EMBED_MODEL);
async function detectOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.OLLAMA_HOST.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { models?: { name: string; model?: string }[] };
    const names = (j.models ?? []).flatMap((m) => [m.name, m.model ?? '']);
    const has = names.some((n) => n === model || n === `${model}:latest` || n.replace(/:latest$/, '') === model);
    if (!has) {
      console.error(`\nOllama is running but model "${model}" is missing. Run:\n\n  ollama pull ${model}\n\nDialogue jobs disabled for this run.\n`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`\nOllama not reachable at ${cfg.OLLAMA_HOST} (${(e as Error).message}). Install/start Ollama, then:\n\n  ollama pull ${model}\n\nDialogue jobs disabled for this run.\n`);
    return false;
  }
}

const hasOllama = jobTypes.includes('dialogue') ? await detectOllama() : false;
if (!hasOllama) jobTypes = jobTypes.filter((t) => t !== 'dialogue');
const cpuTypes = jobTypes.filter((t) => t !== 'dialogue');
const pool = cpuTypes.length ? new Pool(threads) : null;

// ---------- display name ----------
let displayName = hostname();
try {
  const me = await fetch(`${server}/api/helpers/me?token=${encodeURIComponent(token)}`);
  if (me.ok) displayName = ((await me.json()) as { displayName: string }).displayName;
  else console.warn(`Server did not recognize the token (HTTP ${me.status}); continuing, hello will fail if it is wrong.`);
} catch (e) {
  console.warn(`Could not reach ${server}: ${(e as Error).message}`);
}

const caps: HelperCaps = {
  kind: 'laptop', jobTypes, cpuThreads: threads, ollama: hasOllama, dialogueModel: hasOllama ? model : undefined, displayName,
};

// ---------- jobs ----------
function sign(jobId: string, type: JobType, outputHash: string) {
  return signMessage(receiptMessage(jobId, type, WORK_UNITS[type], outputHash), key.secretKey);
}

async function runPathfind(input: PathfindInput): Promise<{ output: PathfindOutput; computeMs: number }> {
  const t0 = performance.now();
  const ids = input.targets.map((t) => t.id);
  const n = Math.min(pool!.size, ids.length) || 1;
  const parts: string[][] = Array.from({ length: n }, () => []);
  ids.forEach((id, i) => parts[i % n].push(id));
  const results = await Promise.all(parts.map((targetIds) => pool!.run({ kind: 'flow', input, targetIds })));
  const byId = new Map<string, { targetId: string; dirsB64: string }>();
  for (const r of results) for (const f of (r.output as PathfindOutput).fields) byId.set(f.targetId, f);
  // Merge in input target order so the hash matches a single-threaded run.
  const output: PathfindOutput = { gridId: input.gridId, fields: ids.map((id) => byId.get(id)!).filter(Boolean) };
  return { output, computeMs: performance.now() - t0 };
}

function systemPrompt(d: DialogueInput, memories: string[] = []): string {
  return [
    `You are the ${d.npcId} of Lanternfall village. ${d.persona}`,
    `Today's world event: ${d.worldEvent}`,
    d.quest ? `Your current quest for travelers: ${d.quest}` : '',
    memories.length ? `Things you remember from earlier conversations:\n- ${memories.join('\n- ')}` : '',
    'Stay in character. Reply in at most 2 short sentences. No stage directions, no emojis, no lists.',
  ].filter(Boolean).join('\n');
}

async function runDialogue(job: Job, emitChunk: (text: string) => void): Promise<{ output: { text: string; model: string }; computeMs: number }> {
  const d = job.input as DialogueInput;
  const t0 = performance.now();
  const memories = await memory.recall(job.roomCode, d.npcId, d.playerLine);
  const messages = [
    { role: 'system', content: systemPrompt(d, memories) },
    ...d.history.slice(-8).map((h) => ({ role: h.role === 'player' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: d.playerLine },
  ];
  const stream = await ollama.chat({ model, messages, stream: true, options: { num_predict: 90, temperature: 0.8 } });
  let text = '';
  let buf = '';
  for await (const part of stream) {
    const t = part.message?.content ?? '';
    if (!t) continue;
    text += t;
    buf += t;
    if (buf.length >= 12 || /[.!?,;:]\s*$/.test(buf)) { emitChunk(buf); buf = ''; }
  }
  if (buf) emitChunk(buf);
  void memory.remember(job.roomCode, d.npcId, d.playerLine, text.trim());
  return { output: { text: text.trim(), model }, computeMs: performance.now() - t0 };
}

// ---------- socket ----------
const socket = io(server, { transports: ['websocket'], reconnection: true, perMessageDeflate: { threshold: 1024 } } as any);

socket.on('connect', () => {
  socket.emit(EV.HELPER_HELLO, { helperToken: token, caps, helperPubKey: key.publicKey } as any, (ack: { ok: boolean; helperId?: string; error?: string }) => {
    if (!ack?.ok) {
      console.error(`helper:hello rejected: ${ack?.error ?? 'unknown error'}`);
      return;
    }
    console.log(`Connected to ${server} as "${displayName}" (helper ${ack.helperId}); jobs: ${jobTypes.join(', ') || 'none'}; threads: ${threads}${hasOllama ? `; model: ${model}` : ''}`);
  });
});
socket.on('disconnect', (r) => console.warn(`Disconnected (${r}); reconnecting...`));
socket.on('connect_error', (e) => console.warn(`Connect error: ${e.message}`));
socket.on(EV.HELPER_PAUSED, (p: { paused: boolean }) => { if (p.paused) console.warn('This helper has been PAUSED by an admin; the server will not route jobs.'); });
socket.on(EV.EARNINGS_UPDATE, (u: any) => {
  if (u?.latest?.displayName === displayName) console.log(`Settled on-chain: ${u.latest.units} units, ${(u.latest.amount / 1e6).toFixed(3)} USDC (${u.latest.explorerUrl})`);
});

socket.on(EV.JOB_ASSIGN, async (job: Job) => {
  const type = job.type;
  const base = { jobId: job.jobId, helperId: '', type, workUnits: WORK_UNITS[type] };
  try {
    let output: unknown;
    let computeMs: number;
    let outputHash: string;
    if (type === 'dialogue') {
      const r = await runDialogue(job, (text) => socket.emit(EV.JOB_CHUNK, { jobId: job.jobId, text }));
      output = r.output; computeMs = r.computeMs; outputHash = hashOutput(output);
    } else if (type === 'pathfind') {
      const r = await runPathfind(job.input as PathfindInput);
      output = r.output; computeMs = r.computeMs; outputHash = hashOutput(output);
    } else {
      const r = await pool!.run({ kind: 'run', type, input: job.input });
      output = r.output; computeMs = r.computeMs; outputHash = r.outputHash;
    }
    const result: JobResult = { ...base, ok: true, output, outputHash, computeMs, helperSig: sign(job.jobId, type, outputHash) };
    socket.emit(EV.JOB_RESULT, result);
    console.log(`${type.padEnd(8)} ${computeMs.toFixed(1).padStart(8)} ms  +${WORK_UNITS[type]} units`);
  } catch (e) {
    const outputHash = '';
    socket.emit(EV.JOB_RESULT, { ...base, ok: false, error: (e as Error).message, outputHash, computeMs: 0, helperSig: sign(job.jobId, type, outputHash) });
    console.error(`${type.padEnd(8)} FAILED: ${(e as Error).message}`);
  }
});

const shutdown = async () => { socket.close(); await pool?.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
