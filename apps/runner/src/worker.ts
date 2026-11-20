// worker_threads entry: runs one CPU job (or one subset of flow-field targets) per message.
import { computeFlowFields, runJob } from '@sidekick/jobs';
import type { PathfindInput } from '@sidekick/shared';
import { parentPort } from 'node:worker_threads';

export type WorkerTask =
  | { id: number; kind: 'run'; type: 'pathfind' | 'areagen' | 'simtick'; input: unknown }
  | { id: number; kind: 'flow'; input: PathfindInput; targetIds: string[] };

parentPort!.on('message', (t: WorkerTask) => {
  try {
    if (t.kind === 'flow') {
      const t0 = performance.now();
      const out = computeFlowFields(t.input, t.targetIds);
      parentPort!.postMessage({ id: t.id, ok: true, output: out, computeMs: performance.now() - t0 });
    } else {
      const r = runJob(t.type, t.input);
      parentPort!.postMessage({ id: t.id, ok: true, output: r.output, outputHash: r.outputHash, computeMs: r.computeMs });
    }
  } catch (e) {
    parentPort!.postMessage({ id: t.id, ok: false, error: (e as Error).message });
  }
});
