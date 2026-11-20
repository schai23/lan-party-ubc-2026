# QuickNode Stream: sidekick_pay settlements

The server learns about onchain settlements from a QuickNode Stream that pushes every devnet
transaction touching the `sidekick_pay` program to our webhook. The server then decodes the
`Program data:` log lines into Anchor events (`SessionOpened`, `JobsSettled`, `SessionClosed`).

## 1. Insert the program ID

Open `filter.js` and replace `REPLACE_WITH_PROGRAM_ID` with the program ID from
[`../anchor/PROGRAM_ID.txt`](../anchor/PROGRAM_ID.txt) (also `PROGRAM_ID` in `.env`):

```js
const PROGRAM_ID = "<contents of anchor/PROGRAM_ID.txt>";
```

## 2. Create the Stream (QuickNode dashboard -> Streams -> Create Stream)

| Setting | Value |
| --- | --- |
| Chain / network | Solana **Devnet** |
| Dataset | **Block** |
| Start | Start at the **current tip** (latest block) |
| Filter | Paste the edited `filter.js` (function `main(stream)`) |
| Destination | **Webhook** |
| Webhook URL | `POST ${PUBLIC_BASE_URL}/webhooks/quicknode` (e.g. `https://<railway-domain>/webhooks/quicknode`) |
| Custom header | `x-qn-token: ${QUICKNODE_STREAM_TOKEN}` (same value as `QUICKNODE_STREAM_TOKEN` in `.env`) |

Use the dashboard's "Test filter" with a recent block that contains a `sidekick_pay` transaction:
the output should be `{ "matches": [ { "signature", "slot", "blockTime", "logs": [...] } ] }`.
Blocks with no matching transactions return `null`, so nothing is delivered.

## 3. Verify

- Run a settlement (or `POST /dev/replay-tx {signature}` with `DEV_TOOLS=1` to test the decoder without the Stream).
- If the delivered payload shape differs from the above, save one raw delivery to
  `/docs/quicknode-sample.json` and adapt the filter / server decoder.
