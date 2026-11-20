// Bench: `pnpm -F @sidekick/jobs bench`. Default sizes from the spec.
import { makePathfindInput } from './benchdata';
import { runJob } from './run';


function bench(label: string, fn: () => { computeMs: number; outputHash: string }, reps = 3): void {
  const times: number[] = [];
  let hash = '';
  for (let r = 0; r < reps; r++) {
    const res = fn();
    times.push(res.computeMs);
    hash = res.outputHash;
  }
  const best = Math.min(...times);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${label.padEnd(36)} best ${best.toFixed(1).padStart(7)} ms  avg ${avg.toFixed(1).padStart(7)} ms  hash ${hash.slice(0, 12)}`);
}

const pf = makePathfindInput();
bench('pathfind 384x288, 8 targets', () => runJob('pathfind', pf));
bench('areagen 512x384', () => runJob('areagen', { seed: 1234, theme: 'harvest festival', width: 512, height: 384, buildingTypes: ['inn', 'forge', 'shrine', 'house', 'market'] }));
bench('simtick 2500 npcs', () => runJob('simtick', { seed: 99, tick: 1000, npcCount: 2500, areaIds: ['square', 'market', 'forge', 'inn', 'fields'] }));
