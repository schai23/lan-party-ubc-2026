import type { PathfindInput, PathfindOutput } from '@sidekick/shared';
import { b64ToBytes, bytesToB64 } from './prng';
import { MinHeap } from './heap';

/** dir 0 = stay/unreachable, 1..8 = N, NE, E, SE, S, SW, W, NW (N = y-1). */
export const DIR_DX = new Int8Array([0, 0, 1, 1, 1, 0, -1, -1, -1]);
export const DIR_DY = new Int8Array([0, -1, -1, 0, 1, 1, 1, 0, -1]);
const DIAG = 1.414;

/**
 * Computes one flow field per target. If targetIds is given, only those targets are computed;
 * output fields always keep the input target order.
 */
export function computeFlowFields(input: PathfindInput, targetIds?: string[]): PathfindOutput {
  const { width: W, height: H } = input;
  const N = W * H;
  const walk = b64ToBytes(input.walkableB64);
  const dens = b64ToBytes(input.densityB64);
  // Per-cell entry cost factor: 1 + density/32.
  const cellCost = new Float32Array(N);
  const walkable = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    walkable[i] = i < walk.length && walk[i] ? 1 : 0;
    cellCost[i] = 1 + (i < dens.length ? dens[i] : 0) / 32;
  }
  const wanted = targetIds ? new Set(targetIds) : null;
  const dist = new Float32Array(N);
  const heap = new MinHeap(Math.max(1024, N));
  const fields: PathfindOutput['fields'] = [];

  for (const t of input.targets) {
    if (wanted && !wanted.has(t.id)) continue;
    const dirs = new Uint8Array(N);
    if (t.x >= 0 && t.y >= 0 && t.x < W && t.y < H) {
      dijkstra(W, H, walkable, cellCost, dist, heap, t.y * W + t.x);
      buildDirs(W, H, walkable, dist, dirs, t.y * W + t.x);
    }
    fields.push({ targetId: t.id, dirsB64: bytesToB64(dirs) });
  }
  return { gridId: input.gridId, fields };
}

function dijkstra(
  W: number, H: number, walkable: Uint8Array, cellCost: Float32Array,
  dist: Float32Array, heap: MinHeap, src: number,
): void {
  dist.fill(Infinity);
  heap.clear();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size > 0) {
    const u = heap.pop();
    const du = heap.lastKey;
    if (du > dist[u]) continue; // stale entry
    const ux = u % W;
    const uy = (u - ux) / W;
    const cu = cellCost[u];
    for (let d = 1; d <= 8; d++) {
      const dx = DIR_DX[d];
      const dy = DIR_DY[d];
      const vx = ux + dx;
      const vy = uy + dy;
      if (vx < 0 || vy < 0 || vx >= W || vy >= H) continue;
      const v = vy * W + vx;
      if (!walkable[v]) continue;
      let w: number;
      if (dx !== 0 && dy !== 0) {
        // No corner cutting: both orthogonal neighbours must be walkable.
        if (!walkable[uy * W + vx] || !walkable[vy * W + ux]) continue;
        w = DIAG * 0.5 * (cu + cellCost[v]);
      } else {
        w = 0.5 * (cu + cellCost[v]);
      }
      const nd = Math.fround(du + w);
      if (nd < dist[v]) {
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
  }
}

function buildDirs(W: number, H: number, walkable: Uint8Array, dist: Float32Array, dirs: Uint8Array, src: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (i === src || !walkable[i] || dist[i] === Infinity) continue;
      let best = 0;
      let bestD = dist[i];
      for (let d = 1; d <= 8; d++) {
        const dx = DIR_DX[d];
        const dy = DIR_DY[d];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (n !== src && !walkable[n]) continue;
        if (dx !== 0 && dy !== 0 && (!walkable[y * W + nx] || !walkable[ny * W + x])) continue;
        const nd = dist[n];
        if (nd < bestD) {
          bestD = nd;
          best = d;
        }
      }
      dirs[i] = best;
    }
  }
}
