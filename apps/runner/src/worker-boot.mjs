// Plain-JS worker bootstrap: registers tsx's loader inside this worker thread, then loads the TS worker.
import { register } from 'tsx/esm/api';
register();
await import('./worker.ts');
