# Sidekick build plan (Nov 20, 2026, started 08:37 CST)

Source of truth: `SIDEKICK_BUILD_SPEC.md`. This file records the order of work and the decisions made where the spec left room.

## Milestone order (spec section 15)

1. Skeleton: pnpm workspaces, `packages/shared` contracts (zod types, socket event names, receipt helpers, config loader), `pnpm check:config`, `.env.example`.
2. Jobs package: prng, flowfield, areagen, simtick, determinism tests, bench.
3. Game local-only: village, crowd, NPCs, gate, second area, load panel.
4. Pairing, relay, runner, phone worker, receipts with both signatures.
5. Dialogue and voice: STT, dialogue via runner, streamed TTS, local Ollama, fallback lines.
6. Solana: Anchor program, localnet tests, devnet setup script, settlement loop.
7. QuickNode: webhook, event decoding, settlements table, earnings UI, `filter.js`.
8. Status, admin, dispatch pages for Grok Bot.
9. Privy (behind `VITE_PRIVY_APP_ID`; custodial fallback first).
10. P1: memory embeddings, SFX, recap, polish.
11. Docs: README (spec 16), architecture, runbook, Grok Bot routines.
12. `pnpm smoke`.

## Work split

Contracts were written first by the integrator and frozen (`packages/shared/src`, `docs/agent-brief.md`). Then four parallel workers, each in its own directory:

| Worker | Directory | Milestones |
| --- | --- | --- |
| jobs | `packages/jobs` | 2 |
| anchor | `anchor`, `streams-filter`, `scripts/devnet-setup.ts` | 6 (program + tests), 7 (filter) |
| web | `apps/web` | 3, 4 (game + helper side), 5 (browser side), 9 |
| server + runner | `apps/server`, `apps/runner`, `scripts/smoke.ts` | 4, 5, 6 (loop), 7 (webhook), 8, 12 |

The integrator writes docs and STATUS.md, runs every check, and commits.

## Ambiguities and decisions

| Question | Decision |
| --- | --- |
| Build output for packages | Packages export TypeScript source. Server and runner run with `tsx`. `pnpm build` = typecheck every package + `vite build`. One less build step to break on demo day. |
| How the helper page sees earnings in laptop mode (it does no work itself) | Added socket event `helper:watch {helperToken}`. It joins the helper's earnings channel without taking jobs. |
| How the web app learns which integrations are stubbed | Added `GET /api/integrations` (same data as `check:config`). |
| Runner's own ed25519 key vs the key registered on `/helper` | Runner sends an optional `helperPubKey` in `helper:hello`; the server updates the stored key for that token. The token is the authority. |
| Custodial fallback wallet | `RegisterHelperRequest` carries an optional `email`; with no Privy wallet the server creates and stores a devnet keypair per email. |
| Flow field payload size (8 targets x 110k cells per result) | Socket.IO `perMessageDeflate` on (direction grids compress well) and `maxHttpBufferSize` raised. Router keeps at most one pathfind in flight and skips ticks while one is outstanding, so it adapts to bandwidth honestly. |
| Merkle root with odd leaf count | Odd node is carried up unchanged. |
| `settle` needs the treasury to derive the Session PDA | Treasury is passed as an account to `settle` and `close_session`. |
| ElevenLabs model defaults | `eleven_flash_v2_5` (low-latency streaming TTS), `scribe_v1` (STT). Overridable in `.env`; confirm against the ElevenLabs docs when keys arrive. |
| Default port | 8787. |
