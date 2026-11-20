import type {
  AreagenInput, AreagenOutput, JobType, PathfindInput, PathfindOutput, SimtickInput, SimtickOutput,
} from '@sidekick/shared';
import { computeFlowFields } from './flowfield';
import { generateArea } from './areagen';
import { simTick } from './simtick';
import { hashOutput } from './prng';

export type ComputeJobType = Exclude<JobType, 'dialogue'>;
export interface JobRunResult<T = unknown> { output: T; outputHash: string; computeMs: number }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function runJob(type: 'pathfind', input: PathfindInput): JobRunResult<PathfindOutput>;
export function runJob(type: 'areagen', input: AreagenInput): JobRunResult<AreagenOutput>;
export function runJob(type: 'simtick', input: SimtickInput): JobRunResult<SimtickOutput>;
export function runJob(type: ComputeJobType, input: unknown): JobRunResult;
export function runJob(type: ComputeJobType, input: unknown): JobRunResult {
  const t0 = now();
  let output: unknown;
  switch (type) {
    case 'pathfind': output = computeFlowFields(input as PathfindInput); break;
    case 'areagen': output = generateArea(input as AreagenInput); break;
    case 'simtick': output = simTick(input as SimtickInput); break;
    default: throw new Error(`runJob: unsupported job type ${String(type)}`);
  }
  const computeMs = now() - t0;
  return { output, outputHash: hashOutput(output), computeMs };
}
