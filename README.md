# LANlord: Shared Compute for Games

![LANlord](docs/lanlord-logo.png)

> **AI is eating all the RAM, so your crew fights back with AI.** Pool your laptops, phones and iPads into one rig, play bigger games smoother, and earn for every frame you share.

## 🚀 Overview
**LANlord** lets your friends' laptops and phones carry the heavy, delay-tolerant work of a game you are playing, and pays them devnet USDC for every unit of work. Our demo game, **Lanternfall**, is a browser village with talking NPCs, a crowd of 2,500 villagers and a gate to a procedurally generated area. Unlinked, the gaming laptop does everything and stutters. Scan a QR code with a MacBook or phone, log in with an email, and crowd pathfinding, area generation, town simulation and NPC dialogue move to that helper. The game gets smoother, the helper earns USDC settled by our **Solana** program, and a **QuickNode Stream** turns every settlement into the numbers on screen. Players talk to NPCs out loud through **ElevenLabs**, **Grok Bot** writes the world and watches the network, and **Privy** gives every helper a wallet they never have to think about.

Codebase name: Sidekick. Hackathon: University Blockchain Conference 2026, Consumer Applications track, Best use of Solana, with the QuickNode Streams, ElevenLabs and Grok Bot bounties.

![Lanternfall screenshot](docs/screenshot.png) <!-- TODO: add screenshot or GIF -->

**Demo video:** TODO

---

## ⚙️ Core Features

### 🖥️ Shared Compute Across Your Devices
- The game's router (`apps/web/src/sidekick/router.ts`) sends each job to a linked helper, or runs it on the main thread when no helper is linked.
- Helpers join from a QR code. Laptops run a Node runner, phones run the jobs in a Web Worker straight from the browser.
- Rendering, input and anything needed this frame always stay on the host.
- Press `L` in the game to force local mode and compare the two live.

### 🧮 Deterministic Jobs That Run Anywhere
| Job | Work units | What it does | Code |
| --- | --- | --- | --- |
| `dialogue` | 10 | NPC reply from Ollama (`llama3.1:8b`) on a helper laptop, streamed token by token | `apps/runner/src` |
| `areagen` | 20 | The area beyond the gate: 4-octave noise, cellular automata, building placement, A* paths, loot | `packages/jobs/src/areagen.ts` |
| `pathfind` | 2 | Crowd flow fields: Dijkstra per point of interest over the whole village, weighted by crowd density | `packages/jobs/src/flowfield.ts` |
| `simtick` | 1 | Off-screen simulation: prices, NPC schedules, weather | `packages/jobs/src/simtick.ts` |

- The CPU jobs in `packages/jobs` are pure and seeded, so the host main thread, runner `worker_threads` and a phone Web Worker produce identical output hashes (unit tested).
- Measured on an M-series MacBook: unlinked p95 frame time about 134 ms with about 540 ms of job work on the main thread every second; linked to one browser helper, 60 FPS, p95 16.8 ms, no job work on the main thread.

### 💸 Pay-Per-Work USDC on Solana
- Helpers sign a receipt for every job (ed25519) and the game countersigns it.
- Every 5 s the server batches a helper's ready receipts (10 receipts, or the oldest at 60 s) into one `settle` transaction.
- Our Anchor program pays `units × 0.001 USDC` from the session's escrow vault and records the receipts' Merkle root in the `JobsSettled` event.
- The server pays every fee, so a helper only needs an address.

### 📡 Earnings Straight From the Chain
- A **QuickNode Stream** watches our program on Solana devnet and posts each settlement to our webhook.
- The webhook is the only code that writes settlements. Helper earnings, the leaderboard, the in-game payout ticker and `/status` all read from it.
- If a transaction fails or is dropped, nobody is shown money they did not get.

### 🎙️ Talk to Your NPCs
- Hold Space and speak. **ElevenLabs** Speech to Text turns it into the player's line.
- Each sentence of the NPC's reply is voiced as it streams in with streaming Text to Speech, one voice per NPC, cached on disk.
- Sound Effects generate the coin chime on each payout and the tavern ambience.

### 🤖 Grok Bot Runs the World
- **Daily Dispatch:** reads `/status` and recent #Lanternfall posts on X, writes the world event, quests, NPC lines, the theme and seed of the area beyond the gate, and shout-outs to top helpers, then submits it through the plain HTML form at `/admin/dispatch`.
- **Network Watch:** every 30 minutes checks `/status` for alerts and files pause requests for failing helpers.
- **Party Recap:** after a session closes, posts a recap on X.

### 🛡 Invisible Wallets
- Helpers log in on `/helper` with an email through **Privy**, which creates a Solana embedded wallet on login.
- No seed phrase, no SOL balance, no signing prompt.
- Without a Privy app ID, the server runs a clearly labeled demo custodial mode with one devnet keypair per email.

### 🌐 Lanternfall and the Load Panel
- Phaser 3 village with three NPCs, 2,500 villagers and a generated second area.
- A live load panel: FPS, frame time average and p95, main-thread job time, JS heap, jobs offloaded vs local, linked helpers, settlements and the current dispatch.
- Every integration that isn't configured is listed as a stub on screen, on `/status` and on `/status.json`.

---

## 🧭 How It Works

```
[Host Chrome /play] --socket.io--> [Server (Railway, public HTTPS)] <--socket.io-- [Runner on M3]
        |                                  |     |   |                    <--socket.io-- [Runner on M2]
   ElevenLabs via server proxy             |     |   +--> Solana devnet (sidekick_pay) --> QuickNode Stream
                                           |     |                                              |
   [Phone /helper Web Worker] --socket.io--+     +<---------- POST /webhooks/quicknode ---------+
                                           |
   Grok Bot (on X) reads /status, /status.json; writes /admin/dispatch, /api/pause-requests
```

More detail: [docs/architecture.md](docs/architecture.md), [docs/contracts.md](docs/contracts.md).

---

## 🛠 Tech Stack

### Blockchain
- Solana devnet, Anchor program `sidekick_pay`
- Program ID: `GDJD4wtm4dU3Zg9gzW2HyTziwswq84yqjCWceLPQEKqs`
- Circle devnet USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- Sample `settle` tx: TODO
- QuickNode Streams (Solana devnet, Block dataset, [streams-filter/filter.js](streams-filter/filter.js))
- Accounts:
  - `Config` PDA `["config"]`: admin, settler, USDC mint, unit price, job weights
  - `Session` PDA `["session", treasury, session_id]`: budget, spent, units paid, open flag, USDC vault
  - `HelperStats` PDA `["helper", helper_wallet]`: lifetime units, earnings, settlement count
- Instructions:
  - `initialize_config`: sets settler, mint, unit price and job weights
  - `open_session`: moves the USDC budget into the session vault, emits `SessionOpened`
  - `register_helper`: creates `HelperStats` for a helper wallet
  - `settle`: pays the helper, records the receipts Merkle root, emits `JobsSettled`
  - `close_session`: refunds the remaining budget, emits `SessionClosed`

### Server + Helpers
- TypeScript, Node.js 20, Fastify, Socket.IO, SQLite (better-sqlite3)
- `@coral-xyz/anchor` (`BorshCoder` + `EventParser`) for decoding settlements from Stream logs
- Helper runner with Ollama (`llama3.1:8b`, `nomic-embed-text` for NPC memory) and `worker_threads`
- ElevenLabs Speech to Text, streaming Text to Speech, Sound Effects
- tweetnacl (ed25519 receipts), zod contracts in `packages/shared`

### Frontend
- React, Vite, Phaser 3
- Privy embedded Solana wallets
- Web Workers for phone helpers
- Server-rendered `/status` and `/admin/dispatch` pages that work without JavaScript, for Grok Bot

---

## 🏎 Running the Project

### 1. Install Dependencies
```bash
npm i -g pnpm@9
pnpm install
```

### 2. Configure Environment
```bash
cp .env.example .env        # optional: everything runs with an empty .env, stubbed honestly
pnpm check:config           # shows which integrations are live and which are stubbed
```

### 3. Build and Start
```bash
pnpm build
pnpm start                  # http://localhost:8787/play and /helper
```
Development: `pnpm dev` (server on 8787, Vite on 5173 with a proxy).

### 4. Run a Helper Laptop
Open the QR link from the game, log in, then run the command the page shows:
```bash
pnpm runner --server https://<host> --token <helperToken> --jobs dialogue,areagen          # M3, with Ollama
pnpm runner --server https://<host> --token <helperToken> --jobs pathfind,simtick,areagen  # M2
```

## Optional

### Checks That Need No Keys
```bash
pnpm test                   # packages/jobs determinism tests
pnpm -F @sidekick/jobs bench
pnpm smoke                  # in-process server, fake helper and fake game, one job of each type
pnpm e2e:localnet           # Solana client, settlement loop and webhook decoder on a local validator
```

### Program Tests
```bash
cd anchor && pnpm install --ignore-workspace && anchor test --validator legacy
```
Open, settle twice, close; settle over budget fails; non-settler settle fails.

### Calibrate the World Size
`/play?villagers=2500&grid=384x288&targets=8&recomputeMs=250&areaSize=512x384&model=llama3.1:8b`

### Deploy
One Railway service, `pnpm build` then `pnpm start`, with a volume for SQLite. Full steps, including the program deploy and Stream setup: [docs/demo-runbook.md](docs/demo-runbook.md).

---

## 🤝 Why Solana
Helpers earn fractions of a cent per job, many times a minute. That only works with fees and confirmation times small enough to settle in batches every few seconds. Solana gives us that, USDC as a real unit of account, and PDAs that hold each session's budget with no custodian.

## 📡 Why QuickNode Streams
The settlement loop never writes earnings. Every number a helper sees comes from what the chain confirmed, pushed by the Stream within seconds, with no polling loop and no indexer to run.

## 🎙 Why ElevenLabs
Voice is how you play: you speak to NPCs and they answer in their own voices, with streaming speech so replies start before the full text arrives.

## 🤖 Why Grok Bot
Grok Bot writes the content every NPC conversation is built on and keeps an eye on the payment network, using the same plain web pages a person would.

## 🧩 Why Privy
Privy gives every helper a Solana wallet from an email login, so earning USDC feels like signing up for an app.

## 📝 Honest Notes
- Devnet only. USDC is Circle's devnet USDC.
- The performance difference comes from the size of the world, set by URL parameters and measured live in the load panel. There are no sleeps, busy loops or throttling anywhere in the local path. Unlinked, the host runs the same `packages/jobs` functions synchronously on its main thread, the way a naive game would.
- Every integration that isn't configured is listed as a stub on `/status`, `/status.json` and in the load panel.
- [STATUS.md](STATUS.md) lists what is done, stubbed or skipped.

## 👥 Team
Zayaan, Seamus, Marcus
