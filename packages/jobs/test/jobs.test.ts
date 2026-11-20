import { describe, expect, it } from 'vitest';
import type { PathfindInput, PathfindOutput } from '@sidekick/shared';
import {
  b64ToBytes, bytesToB64, computeFlowFields, DIR_DX, DIR_DY, generateArea, hashOutput, mulberry32,
  runJob, simTick, TILE, valueNoise2D,
} from '../src/index';
import { makePathfindInput } from '../src/benchdata';

describe('prng + utils', () => {
  it('mulberry32 is deterministic and in [0,1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
  it('valueNoise2D in [0,1) and continuous', () => {
    for (let i = 0; i < 500; i++) {
      const v = valueNoise2D(3, i * 0.37, i * 0.11);
      expect(v >= 0 && v < 1).toBe(true);
    }
    expect(Math.abs(valueNoise2D(1, 2.5, 3.5) - valueNoise2D(1, 2.5001, 3.5))).toBeLessThan(0.01);
  });
  it('hashOutput uses sorted keys', () => {
    expect(hashOutput({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(hashOutput({ b: [1, { c: 3, d: 2 }], a: 1 }));
    expect(hashOutput({ a: 1 })).not.toBe(hashOutput({ a: 2 }));
    expect(hashOutput({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('base64 round-trips all lengths', () => {
    const r = mulberry32(1);
    for (let n = 0; n < 50; n++) {
      const u = new Uint8Array(n).map(() => Math.floor(r() * 256));
      expect(Array.from(b64ToBytes(bytesToB64(u)))).toEqual(Array.from(u));
    }
    expect(bytesToB64(new Uint8Array([104, 105]))).toBe('aGk=');
  });
});

describe('pathfind', () => {
  const input = makePathfindInput(96, 64, 6, 5);
  it('identical hash across runs', () => {
    const h1 = runJob('pathfind', input).outputHash;
    const h2 = runJob('pathfind', input).outputHash;
    expect(h1).toBe(h2);
  });
  it('merging target subsets in input order equals full run', () => {
    const full = computeFlowFields(input);
    const ids = input.targets.map((t) => t.id);
    const a = computeFlowFields(input, [ids[4], ids[0], ids[2]]);
    const b = computeFlowFields(input, [ids[5], ids[1], ids[3]]);
    const byId = new Map([...a.fields, ...b.fields].map((f) => [f.targetId, f]));
    const merged: PathfindOutput = { gridId: input.gridId, fields: ids.map((id) => byId.get(id)!) };
    expect(a.fields.map((f) => f.targetId)).toEqual([ids[0], ids[2], ids[4]]);
    expect(hashOutput(merged)).toBe(hashOutput(full));
    expect(hashOutput(merged)).toBe(runJob('pathfind', input).outputHash);
  });
  it('directions on a tiny grid are valid and lead to the target', () => {
    // 5x4 grid, '#' unwalkable. Target at (4,0).
    const rows = ['....T', '.##..', '.#...', '.....'];
    const W = 5, H = 4;
    const walk = new Uint8Array(W * H), dens = new Uint8Array(W * H);
    let tx = 0, ty = 0;
    rows.forEach((r, y) => [...r].forEach((c, x) => {
      walk[y * W + x] = c === '#' ? 0 : 1;
      if (c === 'T') { tx = x; ty = y; }
    }));
    const inp: PathfindInput = { gridId: 'tiny', width: W, height: H, walkableB64: bytesToB64(walk), densityB64: bytesToB64(dens), targets: [{ id: 'T', x: tx, y: ty }] };
    const dirs = b64ToBytes(computeFlowFields(inp).fields[0].dirsB64);
    expect(dirs.length).toBe(W * H);
    expect(dirs[ty * W + tx]).toBe(0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = dirs[i];
      expect(d >= 0 && d <= 8).toBe(true);
      if (!walk[i]) { expect(d).toBe(0); continue; }
      if (i === ty * W + tx) continue;
      expect(d).toBeGreaterThan(0);
      // Follow the field; must reach target without stepping on walls or cutting corners.
      let cx = x, cy = y, steps = 0;
      while (!(cx === tx && cy === ty)) {
        const dd = dirs[cy * W + cx];
        const nx = cx + DIR_DX[dd], ny = cy + DIR_DY[dd];
        expect(walk[ny * W + nx]).toBe(1);
        if (DIR_DX[dd] && DIR_DY[dd]) {
          expect(walk[cy * W + nx]).toBe(1);
          expect(walk[ny * W + cx]).toBe(1);
        }
        cx = nx; cy = ny;
        expect(++steps).toBeLessThan(W * H);
      }
    }
    // Cell (0,0) should head East along the top row.
    expect(dirs[0]).toBe(3);
  });
});

describe('areagen', () => {
  const input = { seed: 77, theme: 'winter market', width: 128, height: 96, buildingTypes: ['inn', 'forge', 'shrine'] };
  it('identical hash across runs', () => {
    expect(runJob('areagen', input).outputHash).toBe(runJob('areagen', input).outputHash);
  });
  it('produces sensible structure', () => {
    const out = generateArea(input);
    expect(out.tiles.length).toBe(128 * 96);
    expect(out.tiles[(96 >> 1) * 128]).toBe(TILE.GATE);
    expect(out.buildings.length).toBeGreaterThanOrEqual(3);
    expect(out.paths.length).toBeGreaterThan(0);
    for (const p of out.paths) expect(out.tiles[p]).toBe(TILE.PATH);
    expect(out.loot.length).toBeGreaterThan(0);
    expect(runJob('areagen', { ...input, seed: 78 }).outputHash).not.toBe(runJob('areagen', input).outputHash);
  });
});

describe('simtick', () => {
  const input = { seed: 5, tick: 42, npcCount: 500, areaIds: ['a', 'b', 'c'] };
  it('identical hash across runs', () => {
    expect(runJob('simtick', input).outputHash).toBe(runJob('simtick', input).outputHash);
  });
  it('caps schedules and varies by tick', () => {
    const out = simTick(input);
    expect(out.schedules.length).toBe(200);
    expect(Object.keys(out.prices).length).toBeGreaterThanOrEqual(3);
    expect(typeof out.weather).toBe('string');
    expect(simTick({ ...input, npcCount: 10 }).schedules.length).toBe(10);
    expect(hashOutput(simTick({ ...input, tick: 43 }))).not.toBe(hashOutput(out));
  });
});
