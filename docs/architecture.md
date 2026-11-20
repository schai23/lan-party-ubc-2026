# Architecture

```
[Host Chrome /play] --socket.io--> [Server (Railway, public HTTPS)] <--socket.io-- [Runner on M3]
        |                                  |     |   |                    <--socket.io-- [Runner on M2]
   ElevenLabs via server proxy             |     |   +--> Solana devnet (sidekick_pay) --> QuickNode Stream
                                           |     |                                              |
   [Phone /helper Web Worker] --socket.io--+     +<---------- POST /webhooks/quicknode ---------+
                                           |
   Grok Bot (on X) reads /status, /status.json; writes /admin/dispatch, /api/pause-requests
```

## Components

| Component | Path | Role |
| --- | --- | --- |
| Shared contracts | `packages/shared` | zod schemas, TS types, socket event names, receipt signing, Merkle root, the single `.env` loader |
| Job functions | `packages/jobs` | Deterministic flow fields, area generation, simulation tick. Same code on the host main thread, runner `worker_threads` and phone Web Worker |
| Server | `apps/server` | Fastify + Socket.IO + SQLite. Rooms, pairing, job routing, receipts, settlement loop, QuickNode webhook, ElevenLabs proxy, `/status`, `/admin` |
| Game + helper page | `apps/web` | Phaser 3 game at `/play`, helper page at `/helper` (Privy login, phone Web Worker) |
| Runner | `apps/runner` | Node CLI for helper laptops: Ollama dialogue, CPU jobs in a thread pool, signs every result |
| Program | `anchor/programs/sidekick_pay` | Anchor program: sessions funded with devnet USDC, per-helper settlement, events |
| Stream filter | `streams-filter/filter.js` | QuickNode Streams filter that keeps only `sidekick_pay` transactions |

## Job lifecycle

1. The game builds a job (for example a flow field request with the current crowd density) and its router decides: remote if a helper with that job type is linked and force-local is off, local otherwise.
2. Remote: `job:submit` → server picks the least-loaded eligible helper → `job:assign` → helper computes → `job:result` with `helperSig` → server verifies and relays → game applies the output and sends `receipt:countersign` with `gameSig` → server verifies and marks the receipt ready.
3. Local (no helper, timeout, or `L` pressed): the game runs the same `@sidekick/jobs` function synchronously on the main thread. That is the honest naive baseline and its duration is shown in the load panel.
4. Every 5 s the settlement loop batches a helper's ready receipts (10 or more, or the oldest is 60 s old), computes `units` and the Merkle root, and sends `settle` signed by the settler key. It stores the tx signature on the receipts and nothing else.
5. The QuickNode Stream sees the `sidekick_pay` transaction, the filter forwards it, and `POST /webhooks/quicknode` decodes the `JobsSettled` event and inserts the settlement row. Earnings, leaderboard and `/status` read only that table.

## Why the host gets faster when linked

Flow fields (Dijkstra per target over the whole grid, every `recomputeMs`), area generation (noise, cellular automata, A* paths) and the simulation tick are real CPU work. Unlinked, they run on the host's main thread between frames, so frames stall. Linked, the host only builds a density grid, steers agents along received direction grids and renders. The workload is sized by URL parameters; nothing is slowed down artificially.
