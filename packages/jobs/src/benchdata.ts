// Synthetic inputs shared by bench.ts and tests.
import type { PathfindInput } from '@sidekick/shared';
import { bytesToB64, mulberry32, valueNoise2D } from './prng';

export function makePathfindInput(width = 384, height = 288, targetCount = 8, seed = 42): PathfindInput {
  const N = width * height;
  const walk = new Uint8Array(N);
  const dens = new Uint8Array(N);
  const rng = mulberry32(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      walk[i] = valueNoise2D(seed, x / 12, y / 12) > 0.22 ? 1 : 0;
      dens[i] = Math.floor(valueNoise2D(seed + 1, x / 8, y / 8) * 200 + rng() * 55);
    }
  }
  const targets = [];
  for (let t = 0; t < targetCount; t++) {
    let x = 0, y = 0;
    do { x = Math.floor(rng() * width); y = Math.floor(rng() * height); } while (!walk[y * width + x]);
    targets.push({ id: `t${t}`, x, y });
  }
  return { gridId: `bench-${width}x${height}`, width, height, walkableB64: bytesToB64(walk), densityB64: bytesToB64(dens), targets };
}
