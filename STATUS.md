# Status

Updated during the build on Nov 20, 2026. Legend: **done** (built and verified without keys), **stubbed** (code is real, switches on when keys arrive), **skipped** (not built, reason given).

| # | Milestone | State | Notes |
| --- | --- | --- | --- |
| 1 | Skeleton, shared contracts, config loader, `check:config` | done | `pnpm check:config` lists all 6 integrations as missing with an empty `.env` |
| 2 | Jobs package | done | `pnpm -F @sidekick/jobs test`: 11/11 pass. Bench (M-series Mac): pathfind 384x288 x 8 targets 156 to 228 ms, areagen 512x384 105 to 337 ms, simtick 2500 NPCs about 2 ms |
| 3 | Game local-only | done | Headless Chrome (SwiftShader) on a Mac: forced local p95 about 134 ms, about 540 ms/s main-thread job time; gate generates locally in about 158 ms. Host calibration still to do on the Windows laptop |
| 4 | Pairing, relay, runner, phone worker | done | Linked with one browser helper: 60 FPS, p95 16.8 ms, 0 ms/s main-thread jobs. | Routing, deadlines, both signatures verified (`pnpm smoke`). Runner split pathfind across 4 threads matches single-thread hash |
| 5 | Dialogue and voice | done, stubbed until keys | Fallback line + browser speech verified. ElevenLabs STT/TTS, host Ollama streaming and runner Ollama not exercised (no keys, no Ollama on build Mac) |
| 6 | Solana program, tests, settlement loop | done on localnet, devnet deploy pending SOL | `anchor test --validator legacy`: 4 passing. `pnpm e2e:localnet`: server client open/register/settle/close, settlement loop settles 10 receipts. Program ID GDJD4wtm4dU3Zg9gzW2HyTziwswq84yqjCWceLPQEKqs |
| 7 | QuickNode webhook, decoding, filter | done, stubbed until Stream exists | `pnpm e2e:localnet`: real settle tx logs decoded via /dev/replay-tx into `settlements`, `/api/earnings` shows 10 units. filter.js pre-filled with the program ID. Webhook rejects calls without `x-qn-token`; decoding tested with a JobsSettled IDL event; only writer of `settlements` |
| 8 | Status, admin, dispatch | done | Plain HTML forms, no JS. Dispatch form post returns "Dispatch accepted" and broadcasts `dispatch:update` (smoke) |
| 9 | Privy | built, untested | Lazy-loaded when `VITE_PRIVY_APP_ID` is set (`@privy-io/react-auth` 2.25, Solana embedded wallet on login). Custodial fallback verified |
| 10 | P1 items | partial | NPC memory (nomic-embed-text, top-3 recall) built, untested (no Ollama on build Mac). `pnpm gen:sfx` built, needs ElevenLabs key; until then a WebAudio beep and no ambience. Last-session recap on `/status` done. Visual polish skipped |
| 11 | Docs | done (draft) | README, architecture, contracts, runbook, Grok Bot routines |
| 12 | Smoke script | done | `pnpm smoke`: 37 checks pass with an empty `.env` |

## Verification commands (all run with an empty `.env`, last run 09:05 CST)

| Command | Result |
| --- | --- |
| `pnpm build` | typecheck of shared, jobs, server, runner + `vite build`: OK |
| `pnpm test` | 11/11 pass |
| `pnpm smoke` | 37 checks pass |
| `pnpm -F @sidekick/jobs bench` | pathfind 153 ms, areagen 161 ms, simtick 2 ms (M-series Mac) |
| `cd anchor && anchor test --validator legacy` | 4 passing |
| `pnpm e2e:localnet` (validator running) | open, register, settle, decode, close; settlement loop settles 10 receipts; replay into `settlements`; earnings 10 units |
| `pnpm check:config` | 0/6 integrations configured, every stub listed |

## Known risks

- Pathfind results are about 1.3 MB of JSON per 8-target pass before compression. On localhost the round trip was about 200 to 330 ms. On venue Wi-Fi through Railway it may be slower; watch the "Pathfind round trip" row and the failover count during calibration.
- Privy login, ElevenLabs audio and both Ollama paths have not run against real services.
- The program deploy keypair exists only on the build Mac (`anchor/target/deploy/sidekick_pay-keypair.json`, gitignored).
