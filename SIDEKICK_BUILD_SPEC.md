# Sidekick: Build Spec (for the coding agent)

Hackathon: UBC 2026, Consumer Applications track, Best use of Solana, bounties: QuickNode Streams, ElevenLabs, Grok Bot.
Deadline: submission Fri Nov 20, 12:00 PM CST. Live demo Sat Nov 21.

## 0. Mission and priorities

Build a demo-grade product, not a production system. Judges will run the demo and read the repo. Optimize for:

1. **The live demo works reliably on our exact hardware** (section 2).
2. **Every sponsor technology is real, load-bearing, and easy to find in the repo**: Solana program (Anchor), QuickNode Streams filter + webhook, ElevenLabs STT/TTS/SFX, Grok Bot integration points, Privy embedded wallets.
3. **Honest performance difference.** The game must run visibly worse when everything runs on the host laptop and visibly better when the two MacBooks take work. Achieve this only by giving the host real work (a big world). **Never add artificial delays, sleeps, busy loops or throttling to the local path.** Judges will read the code.

Non-goals: auth beyond tokens, multi-room scale, retries beyond one, mainnet, mobile apps, perfect security, edge cases outside the demo path.

Priorities are marked **P0** (must ship) and **P1** (ship if P0 is done). Build P0 end to end before any P1.

## 1. What the product does (one paragraph)

Lanternfall is a browser game: a large village with talking NPCs, a crowd of thousands of villagers, and a gate to a procedurally generated area. Sidekick is the system that moves delay-tolerant work (NPC dialogue, crowd pathfinding, area generation, off-screen simulation) from the gaming device to helper devices. Helpers pair by scanning a QR code, log in with email (Privy embedded Solana wallet, invisible to them), and earn devnet USDC per unit of work, settled by our Anchor program. A QuickNode Stream watches the program and drives every earnings number in the UI. Grok Bot on X writes the daily world content and monitors the network through our public status page and admin endpoints. ElevenLabs gives the player a voice interface and the NPCs voices.

## 2. Demo hardware (design for this)

| Device | Role | Runs |
| --- | --- | --- |
| Windows 11 laptop, i9 13th gen, RTX 4070 laptop GPU, 16 GB RAM | **Host**: plays the game on the projector | Chrome (game at `/play`), Ollama (for unlinked mode) |
| MacBook M3, 24 GB | **Helper A** | Node runner + Ollama: dialogue, NPC memory embeddings, area generation |
| MacBook M2, 16 GB | **Helper B** | Node runner: pathfinding, simulation, area generation (multi-threaded) |
| Phones (optional, judges) | Extra helpers | Browser helper page (`/helper`), CPU jobs in a Web Worker |

All devices connect to the public server (section 4). Venue Wi-Fi with a phone hotspot as backup.

### How the slow/fast difference is produced (honestly)

- **Unlinked (0 helpers)**: the host does everything itself, the way a normal game would: crowd flow fields recomputed on the main thread, area generation on the main thread when the player reaches the gate, simulation on the main thread, and NPC dialogue through the host's own Ollama (same model as Helper A) competing with the game for the GPU and CPU.
- **Linked (2 helpers)**: those jobs run on the Macs in parallel; the host only renders, steers agents along received direction grids, and plays audio.
- The world size is set by URL parameters (section 9.4) so we can calibrate on the host until unlinked is clearly worse. Target after calibration: unlinked p95 frame time above 50 ms with visible hitches and a loading pause at the gate; linked p95 under 20 ms and a seamless gate.
- A key toggle (`L`) forces local mode live, so the A/B can be shown without restarting anything.

## 3. Hackathon requirements this repo must satisfy

- Public GitHub repo, setup instructions, README with architecture overview (section 13).
- Consumer track: working web frontend; blockchain used; no seed phrase, gas or wallet popup for users.
- Solana: core onchain logic on devnet; README lists program ID, USDC mint, how Solana is used.
- QuickNode: at least one Stream with a filter and a destination; README explains network, dataset, filter, destination, why.
- ElevenLabs: used as a core feature; README names the products used.
- Grok Bot: Grok Bot does real work; repo contains `/docs/grok-bot/` with chat exports (added by humans) and a 3 to 4 sentence README section.

## 4. Architecture

```
[Host Chrome /play] --socket.io--> [Server (Railway, public HTTPS)] <--socket.io-- [Runner on M3]
        |                                  |     |   |                    <--socket.io-- [Runner on M2]
   ElevenLabs via server proxy             |     |   +--> Solana devnet (sidekick_pay) --> QuickNode Stream
                                           |     |                                              |
   [Phone /helper Web Worker] --socket.io--+     +<---------- POST /webhooks/quicknode ---------+
                                           |
   Grok Bot (on X) reads /status, /status.json; writes /admin/dispatch, /api/pause-requests
```

One Node server does everything server-side: HTTP API, Socket.IO relay, static hosting of the built web app, server-rendered status and admin pages, settlement loop, ElevenLabs proxy, QuickNode webhook. SQLite for storage. One deploy target.

## 5. Repo layout (pnpm workspaces, TypeScript everywhere except the program)

```
/apps/server        Fastify + Socket.IO + better-sqlite3; serves /apps/web/dist
/apps/web           Vite + React + Phaser 3; routes: /play, /helper
/apps/runner        Node CLI for laptop helpers (Ollama + worker_threads)
/packages/shared    zod schemas + TS types for jobs, results, receipts, dispatch, socket events
/packages/jobs      Pure deterministic job functions: flowfield, areagen, simtick, prng
/anchor             Anchor workspace: programs/sidekick_pay, tests, Anchor.toml
/streams-filter     filter.js (QuickNode Streams) + README snippet
/scripts            devnet-setup.ts, gen-sfx.ts, smoke.ts
/docs               architecture.md, contracts.md, grok-bot/ (exports), demo-runbook.md
.env.example        every variable from section 14, no secrets
```

Root scripts: `pnpm dev` (server + vite), `pnpm build`, `pnpm start` (production server), `pnpm runner` (runner CLI), `pnpm setup:devnet`, `pnpm gen:sfx`, `pnpm smoke`.

## 6. Shared contracts (`/packages/shared`)

Use zod for runtime validation; export inferred TS types.

```ts
type JobType = 'dialogue' | 'pathfind' | 'areagen' | 'simtick';
const WORK_UNITS: Record<JobType, number> = { dialogue: 10, areagen: 20, pathfind: 2, simtick: 1 };

interface Job {
  jobId: string;            // uuid
  roomCode: string;
  type: JobType;
  createdAt: number;        // ms
  deadlineMs: number;       // dialogue 8000, pathfind 400, areagen 6000, simtick 4000
  input: DialogueInput | PathfindInput | AreagenInput | SimtickInput;
}

interface DialogueInput { npcId: 'innkeeper' | 'blacksmith' | 'oracle'; persona: string; worldEvent: string; quest: string;
  playerLine: string; history: { role: 'player' | 'npc'; text: string }[]; }
interface PathfindInput { gridId: string; width: number; height: number; walkableB64: string; // 1 byte per cell, 0/1
  densityB64: string;       // 1 byte per cell, crowd density 0..255 (cost modifier)
  targets: { id: string; x: number; y: number }[]; }
interface AreagenInput { seed: number; theme: string; width: number; height: number; buildingTypes: string[]; }
interface SimtickInput { seed: number; tick: number; npcCount: number; areaIds: string[]; }

interface JobResult { jobId: string; helperId: string; type: JobType; ok: boolean; error?: string;
  output?: unknown; outputHash: string; workUnits: number; computeMs: number;
  helperSig: string; }       // ed25519 over receiptMessage (below)

// receiptMessage = sha256(`${jobId}|${type}|${workUnits}|${outputHash}`)
interface Receipt { jobId: string; helperId: string; type: JobType; workUnits: number; outputHash: string;
  helperSig: string; gameSig: string; createdAt: number; settledTx?: string; }

interface Dispatch { date: string; source: 'grok-bot' | 'default';
  worldEvent: { title: string; summary: string };
  quests: { npcId: string; title: string; description: string }[];
  fallbackLines: Record<'innkeeper' | 'blacksmith' | 'oracle', string[]>;  // up to 20 each
  area: { theme: string; seed: number; buildingTypes: string[] };
  loreMentions: string[]; }  // helper display names Grok chose to honor

interface HelperCaps { kind: 'laptop' | 'phone'; jobTypes: JobType[]; cpuThreads: number;
  ollama: boolean; dialogueModel?: string; displayName: string; }
```

Socket events (namespaced, keep exactly these names):

- Game → server: `room:join {roomCode, gamePubKey}`, `job:submit Job`, `receipt:countersign {jobId, gameSig}`
- Server → game: `room:roster {helpers: {helperId, displayName, caps, busy, paused}[]}`, `job:chunk {jobId, text}` (dialogue only), `job:result JobResult`, `job:failed {jobId, reason}`, `earnings:update {...}`, `dispatch:update Dispatch`
- Helper → server: `helper:hello {helperToken, caps}`, `job:chunk`, `job:result`
- Server → helper: `job:assign Job`, `earnings:update {...}`, `helper:paused {paused}`

Write `/docs/contracts.md` documenting these (generated from the types is fine).

## 7. Job functions (`/packages/jobs`)

Pure, deterministic, no I/O, no `Math.random` (use `mulberry32(seed)`). Same code runs on the host main thread (unlinked), in Node `worker_threads` (runner), and in a Web Worker (phone). Unit tests assert identical `outputHash` across runs.

- `prng.ts`: `mulberry32`, value noise 2D (seeded), `hashOutput(obj) -> hex sha256` (use `@noble/hashes`, works in browser and Node).
- `flowfield.ts`: `computeFlowFields(input: PathfindInput) -> { gridId, fields: {targetId, dirsB64}[] }`. Dijkstra (binary heap) from each target over walkable cells, cost = 1 + density/32 (diagonal × 1.414), then per cell store the direction (0..8) to the lowest-cost neighbor. Output 1 byte per cell per target, base64.
- `areagen.ts`: `generateArea(input: AreagenInput) -> { tiles: number[] (width*height), buildings: {type,x,y,w,h}[], loot: {x,y,item}[], paths: number[] }`. Steps: 4-octave value noise terrain, 6 passes of cellular-automata smoothing, place buildings by seeded rejection sampling, A* paths connecting buildings to the entry gate, seeded loot table. This should take real time at large sizes (hundreds of ms on the host main thread at 512×384). Do not pad it artificially; size is the knob.
- `simtick.ts`: `simTick(input: SimtickInput) -> { prices: Record<string, number>, schedules: {npc, areaId, activity}[], weather: string }`. Deterministic from `seed + tick`.

Runner and phone split pathfinding across threads by target: each thread computes a subset of targets; results merged.

## 8. Server (`/apps/server`)

### 8.1 Storage (SQLite, `better-sqlite3`, file at `DB_PATH`)

Tables: `rooms(code, pair_secret, game_pubkey, created_at, session_id, session_pda, budget, status)`, `helpers(id, room_code, display_name, wallet, helper_pubkey, token, kind, caps_json, paused, created_at)`, `receipts(job_id, helper_id, type, work_units, output_hash, helper_sig, game_sig, created_at, settled_tx)`, `settlements(signature PRIMARY KEY, slot, block_time, session, helper_wallet, units, amount, receipts_root, source)` (**rows written only by the QuickNode webhook**), `dispatches(id, json, source, created_at)`, `pause_requests(id, helper_id, reason, created_at, status)`, `job_log(job_id, type, helper_id, ok, compute_ms, latency_ms, created_at)`.

### 8.2 HTTP routes

- `POST /api/rooms` → `{roomCode (6 chars), pairSecret, pairUrl}`; `pairUrl = ${PUBLIC_BASE_URL}/helper?room=CODE&s=SECRET`.
- `POST /api/helpers/register` `{roomCode, pairSecret, wallet, displayName, kind, helperPubKey}` → `{helperId, helperToken, runnerCommand}`. On the first helper in a room: kick off (async, non-blocking) `open_session`; for every new helper: `register_helper` + create the helper's USDC ATA (payer = settler).
- `POST /api/stt` (multipart audio) → ElevenLabs speech-to-text → `{text}`.
- `POST /api/tts` `{npcId, text}` → streams ElevenLabs TTS audio (mp3) back. Voice per NPC from env. Cache by `sha1(npcId+text)` on disk.
- `GET /api/dispatch/current` → newest valid dispatch (grok-bot preferred over default).
- `POST /api/dispatch` (header `x-grok-token` or form field) → validate with zod, store, broadcast `dispatch:update`, pre-generate TTS for the first 5 fallback lines per NPC.
- `POST /api/pause-requests` (grok token) `{helperId|displayName, reason}`; `POST /api/pause-requests/:id/approve` (admin token) → set helper paused, stop routing.
- `POST /webhooks/quicknode` (check `x-qn-token` header against `QUICKNODE_STREAM_TOKEN`) → decode Anchor events from `logs` with `@coral-xyz/anchor` `EventParser`/`BorshCoder` using the IDL; insert into `settlements`; broadcast `earnings:update` to the room and helper sockets. **The UI's earnings, leaderboard and status page read only from `settlements`.**
- `GET /status` → **server-rendered plain HTML** (no client JS required, readable by Grok Bot): dispatch in effect (source shown honestly), helpers online with job counts, work units by type in the last hour, last 20 settlements with devnet explorer links (`https://explorer.solana.com/tx/<sig>?cluster=devnet`), leaderboard, active alerts (8.4), last closed session recap.
- `GET /status.json` → same data as JSON.
- `GET /admin/dispatch?token=GROK_TOKEN` → server-rendered page: textarea + submit (posts to `/api/dispatch`), shows the JSON schema and an example. Must work with a plain HTML form post (no JS) so an agent can fill it.
- `GET /admin?token=ADMIN_TOKEN` → alerts, pause requests with approve buttons, buttons to open/close session manually.
- Static: serve `/apps/web/dist` with SPA fallback for `/play` and `/helper`.

### 8.3 Job routing

- Server keeps an in-memory map of connected helpers per room with `inflight` counts.
- On `job:submit`: pick a helper whose `caps.jobTypes` includes the type and that is not paused: dialogue → laptop with `ollama: true`, least inflight; others → least inflight among all eligible (laptops before phones on ties). If none: emit `job:failed {reason: 'no-helper'}` immediately (the game runs it locally).
- Start a timer at `deadlineMs`; on expiry emit `job:failed {reason: 'timeout'}` and ignore any late result. One retry is not required.
- Relay `job:chunk` and `job:result` to the game. On `job:result`: verify `helperSig` (tweetnacl), store receipt without `gameSig`, wait for `receipt:countersign`, verify, then mark receipt ready for settlement.
- Write every job to `job_log`.

### 8.4 Settlement loop and alerts

- Every 5 s, per helper: if ready receipts ≥ 10 or the oldest is ≥ 60 s old → compute `units = Σ workUnits`, `receiptsRoot` = Merkle root (sha256, pairwise, sorted leaves = receipt messages), send `settle(session_id, units, receipts_root)` signed by the settler keypair (server pays fees), store the tx signature on the receipts. Do not write `settlements` here; the webhook does.
- If the session vault would be exceeded, top up by calling `open_session` again with a new session id (simple) and log it.
- Alerts computed for `/status`: helper with ≥ 2 timeouts in the last 5 min; session vault below 10% of budget; open session with ready receipts but no settlement in 15 min; any settlement > 5 USDC. These are exactly what Grok Bot's Network Watch checks.

### 8.5 ElevenLabs

- Keys and model IDs come from env (`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`); confirm current model names in the ElevenLabs docs and put defaults in `.env.example`.
- TTS: use the streaming text-to-speech endpoint with a low-latency model; return audio as it arrives.
- STT: speech-to-text endpoint with the webm/opus blob from `MediaRecorder`.
- `scripts/gen-sfx.ts`: call the sound effects endpoint once to generate `coin.mp3` and `tavern-ambience.mp3` into `/apps/web/public/sfx/`; commit the files.

## 9. Web app (`/apps/web`)

### 9.1 `/play` (host, P0)

Phaser 3 (WebGL) inside a React shell. No external art needed: draw tiles and agents procedurally (colored rects/circles, simple palette from the dispatch theme).

- **Village scene**: grid sized from URL params (default 384×288 tiles, rendered with a camera and culling), 3 NPCs (innkeeper, blacksmith, oracle) at fixed spots, a gate on the east edge, `villagers` agents (default 2500) each assigned one of `targets` points of interest (default 8: well, market, tavern, forge, temple, gate, farm, dock). Every `recomputeMs` (default 250) the crowd density grid is rebuilt and new flow fields are requested. Agents steer by reading their target's direction grid each frame (cheap); this per-frame part always runs on the host.
- **Second area**: when the player is within 40 tiles of the gate, request `areagen` using the dispatch's `area.seed` and `theme`. If the result arrives before the player crosses, the transition is instant. If not, the game generates it locally on the main thread at the crossing (this naturally shows a pause).
- **Simulation**: every 5 s request `simtick`; show prices and weather in a small HUD.
- **Dialogue**: walk up to an NPC, hold `Space` (or the mic button) to talk; `MediaRecorder` → `/api/stt` → `dialogue` job. Stream the reply text into a speech bubble; send each completed sentence to `/api/tts` and queue playback. Unlinked mode: send the same prompt to the host's own Ollama (`VITE_LOCAL_OLLAMA_URL`, default `http://localhost:11434`, same model as Helper A) from the browser with streaming. If local Ollama is unreachable, use a fallback line from the dispatch (with cached audio).
- **Local execution**: when `job:failed` arrives or there are no helpers or `L` mode is on, run the same `/packages/jobs` function **synchronously on the main thread** (this is how the unlinked baseline behaves; it is the honest naive implementation). Measure and display its duration.
- **Router** (`src/sidekick/router.ts`): decides remote vs local per job, submits jobs, handles chunks/results/failures, countersigns receipts with a room ed25519 keypair (tweetnacl, generated on load), and tracks per-type counts and latency.
- **Load panel** (always visible on the right, large enough for a projector): FPS, frame time avg and p95 (rolling 5 s) with a sparkline, main-thread job ms in the last second, `performance.memory.usedJSHeapSize` if available, linked helpers (name, kind, current job types, inflight), jobs offloaded vs local by type, dialogue time-to-first-audio, "Powered by …" badge, live settlement ticker (from `earnings:update`, with explorer links), and the current mode: `LINKED (n helpers)` or `LOCAL ONLY`.
- **QR panel**: on load, `POST /api/rooms`, render the pair URL as a QR (`qrcode` package) plus the 6-char room code.
- **Keys**: `L` toggle force-local, `P` toggle load panel, `G` teleport near the gate, `R` reset the second area (to replay the gate moment), `1/2/3` jump to an NPC.
- **Audio**: coin chime on each `earnings:update`; tavern ambience loop at low volume.

### 9.2 `/helper` (helpers and phones, P0)

- Reads `room` and `s` from the query string.
- Privy login (email). Use `@privy-io/react-auth` with Solana embedded wallets created on login; read the wallet address. **Fallback**: if `VITE_PRIVY_APP_ID` is empty, the server creates and stores a devnet keypair per email (demo custodial mode) and returns its address. Users never see a seed phrase, a SOL balance or a signing prompt.
- Generates an ed25519 helper keypair (stored in localStorage), registers via `/api/helpers/register`.
- Shows: display name, live work units and USDC earned (from `earnings:update`, sourced from the webhook), rank on the leaderboard, jobs done by type, and a big "Helping Lanternfall" status.
- **Phone/browser mode** (button "Use this device as a helper"): starts a Web Worker running `/packages/jobs` for `pathfind`, `areagen`, `simtick`; connects with `helper:hello` (`kind: 'phone'`, `cpuThreads: navigator.hardwareConcurrency`); requests a Screen Wake Lock.
- **Laptop mode**: shows the exact runner command with the helper token, e.g. `pnpm runner --server https://<host> --token <helperToken> --jobs dialogue,areagen`.

### 9.3 Styling

Clean, readable on a projector: dark background, large type in the load panel, one accent color. Keep it simple; correctness over polish.

### 9.4 URL parameters for calibration (P0)

`/play?villagers=2500&grid=384x288&targets=8&recomputeMs=250&areaSize=512x384&model=llama3.1:8b`. Defaults as listed. Document in `/docs/demo-runbook.md` how to tune them on the host until unlinked p95 frame time is above 50 ms and the gate shows a pause, while linked stays under 20 ms.

## 10. Runner (`/apps/runner`, P0)

Node 20 CLI: `pnpm runner --server URL --token TOKEN --jobs dialogue,areagen,pathfind,simtick [--model llama3.1:8b] [--threads N]`.

- Connects with `socket.io-client`, sends `helper:hello` with caps (detects Ollama by calling `GET {OLLAMA_HOST}/api/tags` and checks the model is present; prints a clear error with the `ollama pull` command if not).
- `dialogue`: build a system prompt from persona, world event, quest and retrieved memory; call Ollama chat with streaming via the `ollama` npm package (`num_predict: 90`, `temperature: 0.8`); instruct the model to reply in at most 2 short sentences, in character. Emit `job:chunk` per token batch and `job:result` at the end.
- NPC memory (P1): after each exchange, embed it with `nomic-embed-text` via Ollama and keep an in-memory list per `roomCode+npcId`; retrieve the top 3 by cosine similarity for the next prompt.
- CPU jobs run in a `worker_threads` pool (`--threads`, default `os.cpus().length - 2`); pathfinding splits targets across threads.
- Signs every result with its ed25519 key (generated on first run, stored in `~/.sidekick/helper-key.json`; registers the public key through the token).
- Prints a one-line log per job: type, compute ms, work units.

Recommended demo assignment (document in the runbook): M3 runs `--jobs dialogue,areagen`, M2 runs `--jobs pathfind,simtick,areagen`.

## 11. Solana program (`/anchor/programs/sidekick_pay`, P0)

Anchor (use the installed CLI's current version). Devnet. USDC mint (devnet): `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

Accounts:

- `Config` PDA `["config"]`: `admin: Pubkey, settler: Pubkey, usdc_mint: Pubkey, unit_price: u64 (1_000 = 0.001 USDC), job_weights: [u16; 4] (dialogue, areagen, pathfind, simtick = 10, 20, 2, 1), bump`.
- `Session` PDA `["session", treasury, session_id.to_le_bytes()]`: `treasury, session_id: u64, budget: u64, spent: u64, units_paid: u64, open: bool, bump`; vault = associated token account of `usdc_mint` with authority = the session PDA.
- `HelperStats` PDA `["helper", helper_wallet]`: `wallet, total_units: u64, total_earned: u64, settlements: u32, bump`.

Instructions:

- `initialize_config(unit_price, job_weights)`: signer admin; sets settler.
- `open_session(session_id, budget)`: signer treasury; creates Session + vault; transfers `budget` USDC from the treasury ATA to the vault; emits `SessionOpened {session, treasury, budget}`.
- `register_helper(helper_wallet)`: signer settler (payer); creates HelperStats.
- `settle(session_id, units, receipts_root: [u8; 32])`: signer settler; requires `session.open`; `amount = units * unit_price`; requires `spent + amount <= budget`; CPI transfer vault → helper USDC ATA with PDA signer seeds; updates Session and HelperStats; emits `JobsSettled {session, helper: helper_wallet, units, amount, receipts_root, total_units, total_earned}`.
- `close_session(session_id)`: signer settler; refunds the vault balance to the treasury ATA; sets `open = false`; emits `SessionClosed {session, refunded}`.

Helper USDC ATAs are created off-chain by the server (`getOrCreateAssociatedTokenAccount`, payer settler) before the first settle, so the program needs no `init_if_needed`.

Tests (`anchor test` against localnet with a mock mint): open → settle twice → close; settle over budget fails; non-settler settle fails.

`scripts/devnet-setup.ts`: loads `SETTLER_KEYPAIR` and `TREASURY_KEYPAIR`, prints addresses and SOL/USDC balances, initializes Config if missing, creates the treasury USDC ATA, and prints the explorer link for the program. Commit the IDL to `/apps/server/src/idl/sidekick_pay.json` after deploy.

## 12. QuickNode Stream (`/streams-filter`, P0)

Stream settings (configured by a human in the QuickNode dashboard): network Solana Devnet, dataset Block, start at the current tip, destination webhook `POST ${PUBLIC_BASE_URL}/webhooks/quicknode` with header `x-qn-token: ${QUICKNODE_STREAM_TOKEN}`.

`filter.js` (replace `PROGRAM_ID` before pasting; keep it defensive about payload shape):

```js
function main(stream) {
  const PROGRAM_ID = "REPLACE_WITH_PROGRAM_ID";
  const blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  const out = [];
  for (const block of blocks) {
    if (!block || !Array.isArray(block.transactions)) continue;
    for (const tx of block.transactions) {
      const meta = tx && tx.meta;
      if (!meta || meta.err) continue;
      const logs = meta.logMessages || [];
      if (!logs.some((l) => l.includes(PROGRAM_ID))) continue;
      const sigs = (tx.transaction && tx.transaction.signatures) || [];
      out.push({ signature: sigs[0], slot: block.slot, blockTime: block.blockTime, logs });
    }
  }
  return out.length ? { matches: out } : null;
}
```

The server decodes `Program data:` lines into Anchor events (8.2). If the payload shape differs, log one raw delivery to `/docs/quicknode-sample.json` and adapt.

## 13. Grok Bot support (P0 for the endpoints; the routines are set up by humans)

The code provides everything Grok Bot needs; humans configure Grok Bot itself and export the chats into `/docs/grok-bot/`.

- `/status` and `/status.json` (8.2) for reading onchain activity and alerts.
- `/admin/dispatch` form (plain HTML) and `POST /api/dispatch` for writing the daily dispatch.
- `POST /api/pause-requests` for Network Watch.
- `/docs/grok-bot/routines.md`: the exact prompts for the three routines (write them):
  1. **Daily Dispatch**: read `/status`, read recent X posts tagged #Lanternfall, write a dispatch JSON matching the schema shown on `/admin/dispatch`, honor up to 3 top helpers in `loreMentions`, submit it on the form, then post the world event on our X account.
  2. **Network Watch** (every 30 min): read `/status`; for each alert, file a pause request for failing helpers via the admin page, and email the team a summary.
  3. **Party Recap** (after a session closes): read the "last session" section of `/status` and post a recap on X.
- `apps/server/data/default-dispatch.json` is used only until Grok Bot submits one; `/status` and the game HUD show the dispatch source so this is transparent.

## 14. Environment variables (`.env.example`)

Server: `PORT`, `PUBLIC_BASE_URL`, `DB_PATH`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PROGRAM_ID`, `USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, `SETTLER_KEYPAIR` (JSON array), `TREASURY_KEYPAIR` (JSON array), `SESSION_BUDGET_USDC=5`, `ELEVENLABS_API_KEY`, `ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL`, `VOICE_ID_INNKEEPER`, `VOICE_ID_BLACKSMITH`, `VOICE_ID_ORACLE`, `QUICKNODE_STREAM_TOKEN`, `ADMIN_TOKEN`, `GROK_TOKEN`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET` (optional).

Web (build-time): `VITE_SERVER_URL`, `VITE_PRIVY_APP_ID`, `VITE_LOCAL_OLLAMA_URL=http://localhost:11434`.

Runner: `SIDEKICK_SERVER`, `SIDEKICK_TOKEN`, `OLLAMA_HOST=http://127.0.0.1:11434`, `DIALOGUE_MODEL=llama3.1:8b`, `EMBED_MODEL=nomic-embed-text`.

Note for the host's unlinked mode: the browser calls the local Ollama directly, so Ollama on Windows must allow the page's origin (`OLLAMA_ORIGINS=*` or the server origin). Document this in the runbook.

## 14a. Config-later mode (build everything before any keys exist)

The humans will fill in keys after the code is written. The code must build, run and pass its tests with an **empty `.env`**, and switch each integration on automatically once its values are present.

- **One config file.** All three apps read a single root `.env` through one loader, `packages/shared/src/config.ts` (zod, every external value optional). Web build-time values are injected by Vite from the same file (`envDir` = repo root).
- **`.env.example`** is grouped by integration with a comment on each line saying where the value comes from (QuickNode dashboard, ElevenLabs settings, Privy dashboard, `solana-keygen`, Railway domain, etc.).
- **`pnpm check:config`** prints a table: integration, status (`configured` / `missing`), missing keys, and what stays stubbed. Run it at server startup too and log the result once.
- **Honest stub badge.** `/status`, `/status.json` and the load panel list every integration running in stub mode, so nothing pretends to be live.

Behavior when values are missing:

| Missing | Behavior |
| --- | --- |
| `PROGRAM_ID`, `SETTLER_KEYPAIR`, `TREASURY_KEYPAIR`, RPC URLs | Receipts still recorded and verified; the settlement loop logs "would settle N units" and stores the batch as pending. No rows are written to `settlements`. Earnings UI shows 0 with "Solana not configured". |
| Program ID itself | Generate it locally with `anchor keys sync` during the build (no SOL needed) and write it into `.env.example` and the README; only deployment needs SOL later. |
| `QUICKNODE_STREAM_TOKEN` | Webhook route exists and rejects unauthenticated calls. A dev-only route `POST /dev/replay-tx {signature}` (enabled only when `DEV_TOOLS=1`) fetches a transaction by signature over RPC and feeds its logs through the same decoder, so settlement display can be tested before the Stream exists. |
| `ELEVENLABS_API_KEY` or voice IDs | Browser fallback: Web Speech API recognition for input and `speechSynthesis` for NPC voices, labeled "Voice: browser fallback" in the load panel. |
| `PRIVY_APP_ID` | Server-created devnet keypair per email (demo custodial mode), as in 9.2. |
| Ollama unreachable (host or runner) | Host uses dispatch fallback lines; runner refuses to advertise `dialogue` and prints the `ollama pull` command. |
| `ADMIN_TOKEN`, `GROK_TOKEN` | Generate random tokens at startup, print them once to the server log, and use them until real ones are set. |
| `PUBLIC_BASE_URL` | Default to `http://localhost:PORT`; QR codes then use the machine's LAN IP if `PUBLIC_BASE_URL` is unset and `LAN_MODE=1`. |

Everything that can be verified without keys must be: unit tests for `/packages/jobs`, `anchor test` on localnet with a mock mint, and `pnpm smoke` (in-process fake helper, stubbed voice, stubbed Solana). Steps that genuinely need keys (devnet deploy, Stream delivery, ElevenLabs audio, Privy login, Grok Bot form submission) are listed in `/docs/demo-runbook.md` as a "connect the real services" checklist with the exact command or dashboard step for each.

## 15. Build order with acceptance checks

1. **Skeleton (P0)**: workspaces, shared types, the config loader and `pnpm check:config` (14a), server boots, web builds and is served by the server, `.env.example`. Check: with an empty `.env`, `pnpm build && pnpm start` serves `/play` and `/helper`, and `check:config` lists every integration as missing.
2. **Jobs package (P0)**: flowfield, areagen, simtick, prng, hashing, unit tests for determinism. Check: `pnpm -F jobs test` passes; benchmark script prints ms for default sizes.
3. **Game local-only (P0)**: village, crowd, NPCs, gate, second area, load panel, all jobs local. Check: runs at the default size with visible hitches and a gate pause on the host.
4. **Pairing + relay + runner + phone worker (P0)**: rooms, QR, register (with Privy fallback mode first), helper hello, routing, deadlines, local fallback, receipts with both signatures. Check: two runners connected, crowd and areagen jobs offloaded, frame time improves, `L` toggles back.
5. **Dialogue + voice (P0)**: STT, dialogue via runner, streamed TTS, local Ollama in unlinked mode, fallback lines. Check: a spoken question gets a voiced in-character reply via Helper A.
6. **Solana (P0)**: program, tests, deploy to devnet, setup script, settlement loop. Check: a settle tx appears on the devnet explorer after 10 jobs.
7. **QuickNode (P0)**: webhook route, event decoding, settlements table, earnings UI wired only to it, filter.js. Check: dashboards update within seconds of a settle.
8. **Status + admin + dispatch (P0)**: `/status`, `/status.json`, `/admin/dispatch`, `/admin`, pause requests, default dispatch, dispatch drives NPC prompts, fallback lines and area seed/theme. Check: posting a new dispatch changes the world event in-game without reload.
9. **Privy (P0 if time, else stay on fallback mode)**: real embedded wallets on `/helper`.
10. **P1**: NPC memory embeddings, SFX generation, last-session recap section, polish.
11. **Docs**: README (section 16), `/docs/architecture.md` (include the ASCII diagram), `/docs/demo-runbook.md` (device setup, commands per device, calibration, demo script, recovery steps).
12. **Smoke script**: `pnpm smoke` starts a fake helper in-process, submits one job of each type, and checks results and receipt verification.

## 16. README outline (judges read this)

1. One-paragraph pitch and a GIF/screenshot placeholder.
2. Demo video link (placeholder `TODO`).
3. How it works (diagram) and the four shared job types.
4. **Solana**: program ID, USDC mint, instructions, accounts, link to a sample `settle` tx, why Solana.
5. **QuickNode Streams**: network, dataset, filter logic (link to `streams-filter/filter.js`), destination, why Streams.
6. **ElevenLabs**: speech-to-text, streaming text-to-speech, sound effects; where in the code.
7. **Grok Bot**: the 3 to 4 sentence paragraph, link to `/docs/grok-bot/`.
8. **Privy**: invisible embedded wallets; no seed phrases, no gas for users.
9. Run locally, deploy, and run a helper (exact commands).
10. Honest notes: devnet only; performance difference comes from world size, measured live in the load panel; no artificial delays.
