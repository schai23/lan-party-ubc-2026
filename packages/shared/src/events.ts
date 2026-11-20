// Socket.IO event names. Spec section 6. Keep exactly these names.
import type { Dispatch, EarningsUpdate, HelperCaps, Job, JobResult, RosterEntry } from './types';

export const EV = {
  // Game -> server
  ROOM_JOIN: 'room:join',
  JOB_SUBMIT: 'job:submit',
  RECEIPT_COUNTERSIGN: 'receipt:countersign',
  // Server -> game
  ROOM_ROSTER: 'room:roster',
  JOB_CHUNK: 'job:chunk',
  JOB_RESULT: 'job:result',
  JOB_FAILED: 'job:failed',
  EARNINGS_UPDATE: 'earnings:update',
  DISPATCH_UPDATE: 'dispatch:update',
  // Helper -> server
  HELPER_HELLO: 'helper:hello',
  // Server -> helper
  JOB_ASSIGN: 'job:assign',
  HELPER_PAUSED: 'helper:paused',
} as const;

export interface RoomJoinPayload { roomCode: string; gamePubKey: string }
export interface CountersignPayload { jobId: string; gameSig: string }
export interface JobChunkPayload { jobId: string; text: string }
export interface JobFailedPayload { jobId: string; reason: 'no-helper' | 'timeout' | 'error' | string }
export interface HelperHelloPayload { helperToken: string; caps: HelperCaps }
export interface HelperHelloAck { ok: boolean; helperId?: string; error?: string }

export interface ServerToGameEvents {
  'room:roster': (p: { helpers: RosterEntry[] }) => void;
  'job:chunk': (p: JobChunkPayload) => void;
  'job:result': (p: JobResult) => void;
  'job:failed': (p: JobFailedPayload) => void;
  'earnings:update': (p: EarningsUpdate) => void;
  'dispatch:update': (p: Dispatch) => void;
}
export interface GameToServerEvents {
  'room:join': (p: RoomJoinPayload, ack?: (r: { ok: boolean; error?: string }) => void) => void;
  'job:submit': (p: Job) => void;
  'receipt:countersign': (p: CountersignPayload) => void;
}
export interface HelperToServerEvents {
  'helper:hello': (p: HelperHelloPayload, ack?: (r: HelperHelloAck) => void) => void;
  'job:chunk': (p: JobChunkPayload) => void;
  'job:result': (p: JobResult) => void;
}
export interface ServerToHelperEvents {
  'job:assign': (p: Job) => void;
  'earnings:update': (p: EarningsUpdate) => void;
  'helper:paused': (p: { paused: boolean }) => void;
}
