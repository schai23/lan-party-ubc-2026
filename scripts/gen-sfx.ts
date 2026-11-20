// `pnpm gen:sfx`: generates the game's sound effects once with the ElevenLabs Sound Effects API
// and writes them to apps/web/public/sfx/. Commit the output files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg, REPO_ROOT } from '../packages/shared/src/config';

const OUT_DIR = resolve(REPO_ROOT, 'apps/web/public/sfx');

const EFFECTS = [
  { file: 'coin.mp3', text: 'A single bright fantasy gold coin chime, short and satisfying', duration_seconds: 1.2 },
  { file: 'tavern-ambience.mp3', text: 'Cozy medieval tavern ambience, quiet crowd murmur, crackling fireplace, soft mugs clinking, seamless loop', duration_seconds: 20 },
];

async function main() {
  if (!cfg.ELEVENLABS_API_KEY) {
    console.log('ELEVENLABS_API_KEY is not set. Add it to the root .env and rerun `pnpm gen:sfx`.');
    console.log('Until then the game uses a WebAudio beep for the coin and no ambience.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const fx of EFFECTS) {
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': cfg.ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: fx.text, duration_seconds: fx.duration_seconds, prompt_influence: 0.5 }),
    });
    if (!res.ok) {
      console.error(`${fx.file}: ElevenLabs returned ${res.status} ${await res.text()}`);
      process.exitCode = 1;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(resolve(OUT_DIR, fx.file), buf);
    console.log(`wrote apps/web/public/sfx/${fx.file} (${buf.length} bytes)`);
  }
}

main();
