// Web Worker: runs @sidekick/jobs CPU jobs off the main thread on a phone / browser helper.
import { runJob } from '@sidekick/jobs';
import type { JobType } from '@sidekick/shared';
type ComputeJobType = Exclude<JobType, 'dialogue'>;

interface Req { jobId: string; type: ComputeJobType; input: unknown }

const ctx = self as unknown as { onmessage: ((e: MessageEvent<Req>) => void) | null; postMessage: (m: unknown) => void };

ctx.onmessage = (e) => {
  const { jobId, type, input } = e.data;
  try {
    const r = runJob(type, input);
    ctx.postMessage({ jobId, ok: true, output: r.output, outputHash: r.outputHash, computeMs: r.computeMs });
  } catch (err) {
    ctx.postMessage({ jobId, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
