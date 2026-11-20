# Status

Updated during the build on Nov 20, 2026. Legend: **done** (built and verified without keys), **stubbed** (code is real, switches on when keys arrive), **skipped** (not built, reason given).

| # | Milestone | State | Notes |
| --- | --- | --- | --- |
| 1 | Skeleton, shared contracts, config loader, `check:config` | done | `pnpm check:config` lists all 6 integrations as missing with an empty `.env` |
| 2 | Jobs package | done | `pnpm -F @sidekick/jobs test`: 11/11 pass. Bench (M-series Mac): pathfind 384x288 x 8 targets 156 to 228 ms, areagen 512x384 105 to 337 ms, simtick 2500 NPCs about 2 ms |
| 3 | Game local-only | in progress | |
| 4 | Pairing, relay, runner, phone worker | done (server + runner side) | Routing, deadlines, both signatures verified (`pnpm smoke`). Runner split pathfind across 4 threads matches single-thread hash |
| 5 | Dialogue and voice | in progress | |
| 6 | Solana program, tests, settlement loop | in progress | |
| 7 | QuickNode webhook, decoding, filter | done, stubbed until Stream exists | Webhook rejects calls without `x-qn-token`; decoding tested with a JobsSettled IDL event; only writer of `settlements` |
| 8 | Status, admin, dispatch | done | Plain HTML forms, no JS. Dispatch form post returns "Dispatch accepted" and broadcasts `dispatch:update` (smoke) |
| 9 | Privy | in progress | custodial fallback first |
| 10 | P1 items | pending | |
| 11 | Docs | done (draft) | README, architecture, contracts, runbook, Grok Bot routines |
| 12 | Smoke script | done | `pnpm smoke`: 37 checks pass with an empty `.env` |
