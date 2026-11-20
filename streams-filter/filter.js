// QuickNode Streams filter for sidekick_pay (spec 12).
// Paste into the Stream's "Filter" editor after replacing PROGRAM_ID with the value in anchor/PROGRAM_ID.txt.
// Defensive about payload shape: stream.data may be a single block or an array of blocks; missing fields are skipped.
function main(stream) {
  const PROGRAM_ID = "REPLACE_WITH_PROGRAM_ID";
  const data = stream && stream.data;
  const blocks = Array.isArray(data) ? data : [data];
  const out = [];
  for (const block of blocks) {
    if (!block || !Array.isArray(block.transactions)) continue;
    for (const tx of block.transactions) {
      const meta = tx && tx.meta;
      if (!meta || meta.err) continue;
      const logs = Array.isArray(meta.logMessages) ? meta.logMessages : [];
      if (!logs.some((l) => typeof l === "string" && l.includes(PROGRAM_ID))) continue;
      const sigs = (tx.transaction && tx.transaction.signatures) || [];
      out.push({ signature: sigs[0], slot: block.slot, blockTime: block.blockTime, logs });
    }
  }
  return out.length ? { matches: out } : null;
}
