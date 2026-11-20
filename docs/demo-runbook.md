# Demo runbook

## 0. Prerequisites

- Node 20+ and pnpm 9 on every laptop (`npm i -g pnpm@9`).
- `git clone` the repo and `pnpm install` on every laptop.
- Ollama on the host (Windows) and on the M3: `ollama pull llama3.1:8b` (and `ollama pull nomic-embed-text` on the M3).
- Host Ollama must accept requests from the game page. On Windows, set a user environment variable `OLLAMA_ORIGINS=*` (System Properties > Environment Variables), then quit Ollama from the tray and start it again.

## 1. Connect the real services (in this order)

Everything below goes into one root `.env` (copy `.env.example`). Run `pnpm check:config` after each step; the row for that integration should flip to `configured`.

### 1.1 Keys and wallets (5 min)

```bash
solana-keygen new --no-bip39-passphrase -o ~/sidekick-settler.json
solana-keygen new --no-bip39-passphrase -o ~/sidekick-treasury.json
solana config set --url devnet
solana airdrop 2 $(solana-keygen pubkey ~/sidekick-settler.json)   # or https://faucet.solana.com (more SOL with GitHub login)
```

| `.env` key | Value |
| --- | --- |
| `SETTLER_KEYPAIR` | contents of `~/sidekick-settler.json` (the JSON array, one line) |
| `TREASURY_KEYPAIR` | contents of `~/sidekick-treasury.json` |
| `ADMIN_TOKEN`, `GROK_TOKEN`, `QUICKNODE_STREAM_TOKEN` | `openssl rand -hex 16` each |

Fund the treasury: send it a little SOL (`solana transfer <treasury> 0.2 --keypair ~/sidekick-settler.json --allow-unfunded-recipient`) and get devnet USDC at https://faucet.circle.com (Solana Devnet, treasury address).

### 1.2 Deploy the program (10 min, needs about 3 devnet SOL on the deployer)

The program ID was generated at build time with `anchor keys sync`; it is in `anchor/PROGRAM_ID.txt` and the deploy keypair is `anchor/target/deploy/sidekick_pay-keypair.json` on the build Mac. Deploy from that Mac (or copy that keypair file) so the ID matches the code.

```bash
cd anchor
anchor build
anchor deploy --provider.cluster devnet --provider.wallet ~/sidekick-settler.json
cd ..
```

Set in `.env`: `PROGRAM_ID=<anchor/PROGRAM_ID.txt>`, `SOLANA_RPC_URL=<QuickNode devnet HTTP URL>` (or `https://api.devnet.solana.com`), `SOLANA_WS_URL=<QuickNode devnet WSS URL>`.

Copy the IDL if you rebuilt: `cp anchor/target/idl/sidekick_pay.json apps/server/src/idl/sidekick_pay.json`.

### 1.3 Initialize on devnet

```bash
pnpm setup:devnet
```

It prints settler and treasury addresses and balances, initializes `Config` if missing, creates the treasury USDC account, and prints the program explorer link. Rerun until it shows a non-zero treasury USDC balance.

### 1.4 Deploy the server (Railway, 10 min)

1. Railway > New Project > Deploy from GitHub repo.
2. Add a Volume mounted at `/data`.
3. Variables: everything from `.env`, plus `DB_PATH=/data/sidekick.sqlite`. Set `PUBLIC_BASE_URL` to the Railway domain (Settings > Networking > Generate Domain).
4. Build command `pnpm install --frozen-lockfile && pnpm build`, start command `pnpm start`.
5. Open `<PUBLIC_BASE_URL>/status`. The stub badge lists what is still missing.

`VITE_*` values are read at build time, so redeploy after changing them.

### 1.5 QuickNode Stream (5 min)

1. QuickNode dashboard > Streams > Create Stream.
2. Network **Solana Devnet**, dataset **Block**, start at the **latest block**.
3. Filter: paste `streams-filter/filter.js` and replace `REPLACE_WITH_PROGRAM_ID` with the value of `PROGRAM_ID`.
4. Destination: Webhook, `POST <PUBLIC_BASE_URL>/webhooks/quicknode`, custom header `x-qn-token: <QUICKNODE_STREAM_TOKEN>`.
5. Start the stream. After the first `settle`, `/status` shows the settlement within seconds. If nothing appears, check the server log for "unrecognized QuickNode payload"; the raw body is written to `docs/quicknode-sample.json`.

### 1.6 ElevenLabs (5 min)

Set `ELEVENLABS_API_KEY` and pick three voices (Voices > copy Voice ID) for `VOICE_ID_INNKEEPER`, `VOICE_ID_BLACKSMITH`, `VOICE_ID_ORACLE`. Then generate the sound effects once and commit them:

```bash
pnpm gen:sfx        # writes apps/web/public/sfx/coin.mp3 and tavern-ambience.mp3
git add apps/web/public/sfx && git commit -m "Add ElevenLabs SFX"
```

### 1.7 Privy (5 min)

dashboard.privy.io > create app > enable Email login and Solana embedded wallets (create on login). Add the Railway domain and `http://localhost:5173` to allowed origins. Set `PRIVY_APP_ID` and `VITE_PRIVY_APP_ID` to the App ID. Redeploy.

### 1.8 Grok Bot

Give Grok Bot `<PUBLIC_BASE_URL>` and `GROK_TOKEN`, then set up the three routines from `docs/grok-bot/routines.md`. Run Daily Dispatch once and check that the game HUD shows `dispatch: grok-bot`. Export the chats into `docs/grok-bot/`.

## 2. Commands per device

| Device | Commands |
| --- | --- |
| Host (Windows, Chrome) | Ollama running with `OLLAMA_ORIGINS=*`. Open `<PUBLIC_BASE_URL>/play?villagers=2500&grid=384x288&targets=8&recomputeMs=250&areaSize=512x384&model=llama3.1:8b` in Chrome, full screen. |
| Helper A (M3) | `ollama serve` (or the app), then scan the QR, log in, copy the command shown, which looks like: `pnpm runner --server <PUBLIC_BASE_URL> --token <helperToken> --jobs dialogue,areagen` |
| Helper B (M2) | Scan the QR, log in, run: `pnpm runner --server <PUBLIC_BASE_URL> --token <helperToken> --jobs pathfind,simtick,areagen` |
| Phones (optional) | Scan the QR, log in, tap "Use this device as a helper". |

Each runner prints one line per job (type, compute ms, work units). The host load panel switches from `LOCAL ONLY` to `LINKED (2 helpers)`.

## 3. Calibration (on the host, before the demo)

Goal: unlinked p95 frame time above 50 ms with a visible pause at the gate; linked p95 under 20 ms with a seamless gate. Read the numbers off the load panel (p95 frame time, main-thread job ms).

1. Start unlinked (no runners, or press `L`). Load the default URL. Walk around for 10 s and read p95.
2. If unlinked p95 is under 50 ms, raise the per-tick work, one knob at a time:
   - `targets=10` or `12` (flow field cost grows linearly with targets),
   - `grid=448x336` or `512x384` (cost grows with cells),
   - `recomputeMs=150` (more recomputes per second).
3. Gate pause: press `G` to teleport near the gate, walk east. If the crossing is not a visible pause, raise `areaSize` (`640x480`, then `768x576`). Press `R` to reset the area and try again.
4. Link both Macs and check linked p95. If linked p95 is above 20 ms, the host is spending too long on rendering or steering: lower `villagers` (for example `2000`), since per-frame steering and drawing always run on the host. Check that `pathfind` shows as offloaded in the panel.
5. If linked flow fields arrive late (pathfind latency above `recomputeMs` in the panel), raise `recomputeMs` slightly; the router keeps one pathfind in flight and reuses the last fields meanwhile.
6. Write the final URL here: `__________________________________________`

## 4. Demo script (3 minutes)

1. Host is unlinked: point out `LOCAL ONLY`, p95 frame time, main-thread job ms, crowd hitching.
2. Walk to the gate (`G`, then east): visible pause while the area generates on the main thread.
3. Talk to the innkeeper (`1`, hold Space): reply comes from the host's own Ollama, competing with the game.
4. Scan the QR with the M3 and M2, log in with email (no wallet popup, no seed phrase), start the runners.
5. Panel switches to `LINKED (2 helpers)`; p95 drops; jobs show as offloaded. Press `R`, walk to the gate again: seamless.
6. Talk to the blacksmith (`2`): reply streams from the M3, voiced by ElevenLabs.
7. Wait for the coin chime: a `settle` tx lands, QuickNode delivers it, the ticker and `/helper` earnings update. Click the explorer link.
8. Press `L`: back to local, frame time jumps. Press `L` again.
9. Open `/status`: the same settlements, the Grok Bot dispatch in effect, alerts.

## 5. Recovery

| Problem | Fix |
| --- | --- |
| Venue Wi-Fi drops | Switch all devices to the phone hotspot; runners reconnect automatically. |
| Runner says Ollama model missing | `ollama pull llama3.1:8b` on that Mac. |
| Host dialogue silent in unlinked mode | Check `OLLAMA_ORIGINS=*` and restart Ollama; the game falls back to dispatch lines. |
| No settlement after 60 s | `/status` alerts; check settler SOL balance and treasury USDC (`pnpm setup:devnet`). |
| Settlements sent but not shown | QuickNode Stream paused or wrong token. Check the Stream's delivery log. |
| Voice silent | Load panel shows `Voice: browser fallback` when ElevenLabs is not configured; check the key and voice IDs. |
| Server down | Run it locally on the M3: `pnpm build && LAN_MODE=1 pnpm start`, open `http://<M3 LAN IP>:8787/play` on the host. The QuickNode webhook needs a public URL, so earnings stop updating in this mode. |
