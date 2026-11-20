// QuickNode Streams filter for sidekick_pay (spec 12).
// Paste into the Stream's "Filter" editor. PROGRAM_ID is pre-filled from anchor/PROGRAM_ID.txt; check it matches PROGRAM_ID in .env.
// Defensive about payload shape: stream.data may be a single block or an array of blocks; missing fields are skipped.
function main(stream) {
  const PROGRAM_ID = "GDJD4wtm4dU3Zg9gzW2HyTziwswq84yqjCWceLPQEKqs"; // = anchor/PROGRAM_ID.txt; change if you redeploy with a new ID
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
