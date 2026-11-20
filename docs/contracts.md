# Shared contracts

Source: `packages/shared/src/types.ts` (zod schemas + inferred types), `packages/shared/src/events.ts` (socket event names), `packages/shared/src/receipt.ts` (signing, Merkle root). Every app imports these; nothing redefines them.

## Job types

| Type | Work units | Deadline | Runs on | Input |
| --- | --- | --- | --- | --- |
| `dialogue` | 10 | 8000 ms | laptop helper with Ollama, else host Ollama | `DialogueInput` (npcId, persona, worldEvent, quest, playerLine, history) |
| `areagen` | 20 | 6000 ms | any helper, else host main thread | `AreagenInput` (seed, theme, width, height, buildingTypes) |
| `pathfind` | 2 | 400 ms | any helper, else host main thread | `PathfindInput` (gridId, width, height, walkableB64, densityB64, targets) |
| `simtick` | 1 | 4000 ms | any helper, else host main thread | `SimtickInput` (seed, tick, npcCount, areaIds) |

On-chain `Config.job_weights` uses the order `[dialogue, areagen, pathfind, simtick]` = `[10, 20, 2, 1]`.

## Receipts

```
receiptMessage = sha256(`${jobId}|${type}|${workUnits}|${outputHash}`)
helperSig = ed25519(helper key, receiptMessage)     // set by the helper in JobResult
gameSig   = ed25519(room key,   receiptMessage)     // set by the game via receipt:countersign
receiptsRoot = Merkle root, sha256 pairwise over sorted receipt messages (odd node carried up)
```

The server verifies both signatures before a receipt is ready for settlement.

## Socket events

| Direction | Event | Payload |
| --- | --- | --- |
| game → server | `room:join` | `{ roomCode, gamePubKey }` |
| game → server | `job:submit` | `Job` |
| game → server | `receipt:countersign` | `{ jobId, gameSig }` |
| server → game | `room:roster` | `{ helpers: { helperId, displayName, caps, busy, paused, inflight }[] }` |
| server → game | `job:chunk` | `{ jobId, text }` (dialogue only) |
| server → game | `job:result` | `JobResult` |
| server → game | `job:failed` | `{ jobId, reason: 'no-helper' \| 'timeout' \| 'error' }` |
| server → game | `earnings:update` | `EarningsUpdate` (from the `settlements` table only) |
| server → game | `dispatch:update` | `Dispatch` |
| helper → server | `helper:hello` | `{ helperToken, caps: HelperCaps, helperPubKey? }` |
| helper → server | `helper:watch` | `{ helperToken }` (helper page in laptop mode, earnings only) |
| helper → server | `job:chunk` | `{ jobId, text }` |
| helper → server | `job:result` | `JobResult` |
| server → helper | `job:assign` | `Job` |
| server → helper | `earnings:update` | `EarningsUpdate` |
| server → helper | `helper:paused` | `{ paused }` |

`helper:watch` and `helperPubKey` are additions to the spec; see `PLAN.md`.

## HTTP

| Route | Purpose |
| --- | --- |
| `POST /api/rooms` | `{ roomCode, pairSecret, pairUrl }` |
| `POST /api/helpers/register` | `RegisterHelperRequest` → `{ helperId, helperToken, wallet, runnerCommand }` |
| `GET /api/helpers/me?token=` | helper profile |
| `POST /api/stt` | multipart `audio` → `{ text }` (ElevenLabs speech-to-text) |
| `POST /api/tts` | `{ npcId, text }` → streamed mp3 (ElevenLabs TTS), disk cached |
| `GET /api/dispatch/current` | newest dispatch, Grok Bot preferred over default |
| `POST /api/dispatch` | Grok token; JSON body or form field `json` |
| `POST /api/pause-requests` | Grok token; `{ helperId \| displayName, reason }` |
| `POST /api/pause-requests/:id/approve` | admin token |
| `GET /api/integrations` | which integrations are live vs stubbed |
| `GET /api/earnings?room=` | `EarningsUpdate` |
| `POST /webhooks/quicknode` | QuickNode Stream destination, header `x-qn-token` |
| `POST /dev/replay-tx` | `{ signature }`, only with `DEV_TOOLS=1` |
| `GET /status`, `GET /status.json` | public network status (plain HTML / JSON) |
| `GET /admin/dispatch?token=` | plain HTML dispatch form for Grok Bot |
| `GET /admin?token=` | alerts, pause requests, session controls |

## Dispatch

See `DispatchSchema` in `packages/shared/src/types.ts` and the example on `/admin/dispatch`. Fields: `date`, `source` (`grok-bot` | `default`), `worldEvent {title, summary}`, `quests[] {npcId, title, description}`, `fallbackLines {innkeeper[], blacksmith[], oracle[]}` (up to 20 each), `area {theme, seed, buildingTypes[]}`, `loreMentions[]` (up to 3 helper display names).
