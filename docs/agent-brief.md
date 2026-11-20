# Integration contract for parallel build (internal)

Read SIDEKICK_BUILD_SPEC.md (source of truth) and packages/shared/src/*.ts (FROZEN contracts; do not edit, ask the integrator via your final report if something is missing).

## Conventions
- pnpm workspaces. Packages export TypeScript source directly (`main: src/index.ts`). No build step for packages.
- Server and runner run with `tsx` (`tsx src/index.ts`). `pnpm build` = `tsc --noEmit` typecheck per package + `vite build` for web.
- Node-only config: `import { cfg, integrationStatus } from '@sidekick/shared/config'`. Browser code must NOT import `@sidekick/shared/config`.
- Server port default 8787. Vite dev server port 5173 proxies `/api`, `/socket.io` (ws), `/status`, `/status.json`, `/admin`, `/webhooks`, `/dev` to 8787.
- Web reads build-time env from repo root (`envDir: '../..'`). Server URL in browser = `import.meta.env.VITE_SERVER_URL || window.location.origin`.
- Signatures: hex strings. Keys: hex ed25519 (tweetnacl). Helpers sign `receiptMessage(jobId,type,workUnits,outputHash)`; game countersigns the same message with its room keypair.
- NEVER add sleeps, busy loops, setTimeout-based delays or throttling to slow anything down. Performance differences come only from real workload size.

## @sidekick/jobs API (packages/jobs/src/index.ts)
- `mulberry32(seed: number): () => number` in [0,1)
- `valueNoise2D(seed: number, x: number, y: number): number` in [0,1), smooth-interpolated lattice noise
- `hashOutput(obj: unknown): string` hex sha256 of canonical JSON (sorted object keys)
- `bytesToB64(u8: Uint8Array): string`, `b64ToBytes(s: string): Uint8Array` (no Buffer; browser + node)
- `computeFlowFields(input: PathfindInput, targetIds?: string[]): PathfindOutput` (if targetIds given, compute only those; fields keep input target order)
- `DIR_DX`, `DIR_DY`: Int8Array(9). dir 0 = stay/unreachable, 1..8 = N, NE, E, SE, S, SW, W, NW (N = y-1)
- `generateArea(input: AreagenInput): AreagenOutput`; `TILE` = { GRASS:0, WATER:1, ROCK:2, TREE:3, PATH:4, FLOOR:5, WALL:6, GATE:7 }
- `simTick(input: SimtickInput): SimtickOutput`
- `runJob(type: Exclude<JobType,'dialogue'>, input): { output, outputHash, computeMs }` (computeMs measured with performance.now())
- outputHash for a pathfind job = hashOutput(PathfindOutput) with fields in input target order (so a runner merging thread results gets the same hash).

## Extra endpoints/events beyond the spec (agreed)
- `GET /api/integrations` -> `{ integrations: IntegrationStatus[], voice: 'elevenlabs' | 'browser', solanaConfigured: boolean, programId?: string, usdcMint: string }`
- `GET /api/earnings?room=CODE` -> `EarningsUpdate` (from settlements table only)
- `GET /api/helpers/me?token=TOKEN` -> `{ helperId, displayName, wallet, roomCode, kind }`
- Socket `helper:watch {helperToken}` (helper page in laptop mode): joins the helper's earnings channel without taking jobs.
- Register request may carry `email` (custodial fallback when no Privy wallet) — see RegisterHelperRequestSchema.
- Server must set Socket.IO `maxHttpBufferSize: 50e6` and `perMessageDeflate: { threshold: 1024 }` (flow fields are large but very compressible).
- Router (game) keeps at most ONE pathfind job in flight; if a recompute tick fires while one is outstanding remotely, skip that tick (agents keep the previous fields). Local mode computes synchronously every tick.
