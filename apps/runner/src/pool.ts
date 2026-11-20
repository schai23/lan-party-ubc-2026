// A small worker_threads pool. Each task goes to the next idle worker; tasks queue when all are busy.
import { Worker } from 'node:worker_threads';
import type { WorkerTask } from './worker';

type Pending = { task: WorkerTask; resolve: (v: any) => void; reject: (e: Error) => void };
type Distribute<T> = T extends any ? Omit<T, 'id'> : never;

export class Pool {
  private workers: { w: Worker; busy: Pending | null }[] = [];
  private queue: Pending[] = [];
  private nextId = 1;
  private closing = false;
  private crashes = 0;

  constructor(public size: number) {
    for (let i = 0; i < size; i++) this.spawn();
  }

  private spawn() {
    {
      // Workers load TypeScript through a JS bootstrap that registers tsx inside the worker thread.
      const w = new Worker(new URL('./worker-boot.mjs', import.meta.url), { execArgv: [] });
      const slot = { w, busy: null as Pending | null };
      w.on('message', (m: any) => {
        const p = slot.busy;
        slot.busy = null;
        if (p) (m.ok ? p.resolve(m) : p.reject(new Error(m.error)));
        this.pump();
      });
      w.on('error', (e) => {
        const p = slot.busy;
        slot.busy = null;
        p?.reject(e);
      });
      w.on('exit', (code) => {
        // Replace a crashed worker so queued jobs keep flowing.
        slot.busy?.reject(new Error(`worker exited with code ${code}`));
        slot.busy = null;
        this.workers = this.workers.filter((s) => s !== slot);
        if (!this.closing && ++this.crashes <= this.size * 3) this.spawn();
        if (!this.workers.length) for (const q of this.queue.splice(0)) q.reject(new Error('no worker threads available'));
        this.pump();
      });
      this.workers.push(slot);
    }
  }

  run(task: Distribute<WorkerTask>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task: { ...task, id: this.nextId++ } as WorkerTask, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const p = this.queue.shift();
      if (!p) return;
      slot.busy = p;
      slot.w.postMessage(p.task);
    }
  }

  async close() {
    this.closing = true;
    await Promise.all(this.workers.map((s) => s.w.terminate()));
  }
}
