import type { AreagenInput, AreagenOutput } from '@sidekick/shared';
import { mulberry32, valueNoise2D } from './prng';
import { MinHeap } from './heap';

export const TILE = { GRASS: 0, WATER: 1, ROCK: 2, TREE: 3, PATH: 4, FLOOR: 5, WALL: 6, GATE: 7 } as const;

const LOOT_TABLES: Record<string, { item: string; w: number }[]> = {
  default: [
    { item: 'coin_pouch', w: 30 }, { item: 'bread', w: 20 }, { item: 'herbs', w: 18 },
    { item: 'iron_ore', w: 12 }, { item: 'potion', w: 10 }, { item: 'map_fragment', w: 6 },
    { item: 'crystal', w: 3 }, { item: 'relic', w: 1 },
  ],
  winter: [
    { item: 'fur_pelt', w: 25 }, { item: 'coin_pouch', w: 20 }, { item: 'ice_shard', w: 18 },
    { item: 'potion', w: 12 }, { item: 'iron_ore', w: 12 }, { item: 'frost_relic', w: 2 },
  ],
  harvest: [
    { item: 'pumpkin', w: 25 }, { item: 'grain_sack', w: 22 }, { item: 'cider', w: 15 },
    { item: 'coin_pouch', w: 15 }, { item: 'herbs', w: 12 }, { item: 'golden_scythe', w: 1 },
  ],
};

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickLootTable(theme: string) {
  const t = theme.toLowerCase();
  for (const k of Object.keys(LOOT_TABLES)) if (k !== 'default' && t.includes(k)) return LOOT_TABLES[k];
  return LOOT_TABLES.default;
}

export function generateArea(input: AreagenInput): AreagenOutput {
  const W = input.width;
  const H = input.height;
  const N = W * H;
  const seed = (input.seed ^ hashString(input.theme)) | 0;
  const rng = mulberry32(seed);
  let tiles = new Uint8Array(N);

  // 1. Terrain: 4-octave value noise (fbm) for elevation plus a vegetation channel.
  const baseScale = 1 / 48;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let e = 0;
      let amp = 1;
      let freq = baseScale;
      let norm = 0;
      for (let o = 0; o < 4; o++) {
        e += amp * valueNoise2D(seed + o * 1013, x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      e /= norm;
      const veg = 0.6 * valueNoise2D(seed + 7777, x / 20, y / 20) + 0.4 * valueNoise2D(seed + 8888, x / 6, y / 6);
      let t: number = TILE.GRASS;
      if (e < 0.3) t = TILE.WATER;
      else if (e > 0.72) t = TILE.ROCK;
      else if (veg > 0.62) t = TILE.TREE;
      tiles[y * W + x] = t;
    }
  }

  // 2. Cellular-automata smoothing: 6 passes of a 3x3 majority filter over terrain classes.
  let next = new Uint8Array(N);
  const counts = new Int32Array(4);
  for (let pass = 0; pass < 6; pass++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        counts[0] = counts[1] = counts[2] = counts[3] = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy < 0 ? 0 : y + dy >= H ? H - 1 : y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx < 0 ? 0 : x + dx >= W ? W - 1 : x + dx;
            counts[tiles[yy * W + xx]]++;
          }
        }
        const i = y * W + x;
        let best = tiles[i];
        let bc = 4;
        for (let k = 0; k < 4; k++) if (counts[k] > bc) { bc = counts[k]; best = k; }
        next[i] = best;
      }
    }
    const tmp = tiles; tiles = next; next = tmp;
  }

  // 3. Entry gate on the west edge, mid-height, with a cleared approach.
  const gateY = H >> 1;
  const gateIdx = gateY * W;
  for (let y = Math.max(0, gateY - 2); y <= Math.min(H - 1, gateY + 2); y++)
    for (let x = 0; x < Math.min(W, 4); x++) tiles[y * W + x] = TILE.GRASS;
  tiles[gateIdx] = TILE.GATE;

  // 4. Buildings via seeded rejection sampling.
  const types = input.buildingTypes.length ? input.buildingTypes : ['house'];
  const target = Math.max(types.length, Math.floor(N / 2500));
  const buildings: AreagenOutput['buildings'] = [];
  const doors: number[] = [];
  const occupied = new Uint8Array(N); // building footprint + margin
  const maxAttempts = target * 300;
  let attempts = 0;
  while (buildings.length < target && attempts < maxAttempts) {
    attempts++;
    const type = types[buildings.length % types.length];
    const w = 5 + Math.floor(rng() * 7);
    const h = 4 + Math.floor(rng() * 5);
    const x = 6 + Math.floor(rng() * Math.max(1, W - w - 9));
    const y = 2 + Math.floor(rng() * Math.max(1, H - h - 5));
    if (x + w + 1 >= W || y + h + 2 >= H) continue;
    // Reject overlaps (2-cell margin) and bad terrain (too much water/rock).
    let ok = true;
    let bad = 0;
    for (let yy = y - 2; yy <= y + h + 2 && ok; yy++) {
      for (let xx = x - 2; xx <= x + w + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx;
        if (occupied[i] || tiles[i] === TILE.GATE) { ok = false; break; }
        if (yy >= y && yy < y + h && xx >= x && xx < x + w) {
          const t = tiles[i];
          if (t === TILE.WATER || t === TILE.ROCK) bad++;
        }
      }
    }
    if (!ok || bad > (w * h) / 5) continue;
    const doorX = x + (w >> 1);
    const outside = (y + h) * W + doorX;
    if (tiles[outside] === TILE.WATER && rng() < 0.9) continue;
    for (let yy = y - 2; yy <= y + h + 1; yy++)
      for (let xx = x - 2; xx <= x + w + 1; xx++)
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) occupied[yy * W + xx] = 1;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const edge = yy === y || yy === y + h - 1 || xx === x || xx === x + w - 1;
        tiles[yy * W + xx] = edge ? TILE.WALL : TILE.FLOOR;
      }
    }
    tiles[(y + h - 1) * W + doorX] = TILE.FLOOR; // door gap in bottom wall
    buildings.push({ type, x, y, w, h });
    doors.push(outside);
  }

  // 5. A* paths from each door to the gate (4-neighbour, terrain-weighted, existing paths cheap).
  const g = new Float64Array(N);
  const came = new Int32Array(N);
  const stamp = new Int32Array(N);
  const closed = new Int32Array(N);
  const heap = new MinHeap(4096);
  const gx = 0;
  const gy = gateY;
  const NX = [0, 1, 0, -1];
  const NY = [-1, 0, 1, 0];
  for (let b = 0; b < doors.length; b++) {
    const run = b + 1;
    const start = doors[b];
    heap.clear();
    stamp[start] = run;
    g[start] = 0;
    came[start] = -1;
    const sx = start % W;
    const sy = (start - sx) / W;
    heap.push(0.5 * (Math.abs(sx - gx) + Math.abs(sy - gy)), start);
    let found = false;
    while (heap.size > 0) {
      const u = heap.pop();
      if (closed[u] === run) continue;
      closed[u] = run;
      if (u === gateIdx) { found = true; break; }
      const ux = u % W;
      const uy = (u - ux) / W;
      const gu = g[u];
      for (let k = 0; k < 4; k++) {
        const vx = ux + NX[k];
        const vy = uy + NY[k];
        if (vx < 0 || vy < 0 || vx >= W || vy >= H) continue;
        const v = vy * W + vx;
        if (closed[v] === run) continue;
        const t = tiles[v];
        let c: number;
        switch (t) {
          case TILE.PATH: c = 0.5; break;
          case TILE.GRASS: case TILE.GATE: c = 1; break;
          case TILE.TREE: c = 3; break;
          case TILE.ROCK: c = 6; break;
          case TILE.WATER: c = 10; break;
          default: continue; // WALL / FLOOR impassable
        }
        const ng = gu + c;
        if (stamp[v] !== run || ng < g[v]) {
          stamp[v] = run;
          g[v] = ng;
          came[v] = u;
          heap.push(ng + 0.5 * (Math.abs(vx - gx) + Math.abs(vy - gy)), v);
        }
      }
    }
    if (!found) continue;
    for (let c = came[gateIdx]; c !== -1; c = came[c]) {
      if (tiles[c] !== TILE.GATE) tiles[c] = TILE.PATH;
    }
  }

  // 6. Seeded loot from a weighted table.
  const table = pickLootTable(input.theme);
  let totalW = 0;
  for (const e of table) totalW += e.w;
  const lootCount = Math.max(1, Math.floor(N / 2500));
  const loot: AreagenOutput['loot'] = [];
  const taken = new Uint8Array(N);
  for (let tries = 0; loot.length < lootCount && tries < lootCount * 50; tries++) {
    const x = Math.floor(rng() * W);
    const y = Math.floor(rng() * H);
    const i = y * W + x;
    const t = tiles[i];
    if (taken[i] || !(t === TILE.GRASS || t === TILE.FLOOR || t === TILE.TREE)) continue;
    let r = rng() * totalW;
    let item = table[table.length - 1].item;
    for (const e of table) { r -= e.w; if (r < 0) { item = e.item; break; } }
    taken[i] = 1;
    loot.push({ x, y, item });
  }

  const paths: number[] = [];
  for (let i = 0; i < N; i++) if (tiles[i] === TILE.PATH) paths.push(i);
  return { tiles: Array.from(tiles), buildings, loot, paths };
}
