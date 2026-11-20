/** Min binary heap of (key, node) pairs using typed arrays. Lazy deletion is done by callers. */
export class MinHeap {
  keys: Float64Array;
  nodes: Int32Array;
  size = 0;
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.nodes = new Int32Array(capacity);
  }
  clear(): void {
    this.size = 0;
  }
  private grow(): void {
    const cap = this.keys.length * 2;
    const k = new Float64Array(cap);
    k.set(this.keys);
    const n = new Int32Array(cap);
    n.set(this.nodes);
    this.keys = k;
    this.nodes = n;
  }
  push(key: number, node: number): void {
    if (this.size === this.keys.length) this.grow();
    const keys = this.keys;
    const nodes = this.nodes;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pk = keys[p];
      // Tie-break on node index for full determinism.
      if (pk < key || (pk === key && nodes[p] <= node)) break;
      keys[i] = pk;
      nodes[i] = nodes[p];
      i = p;
    }
    keys[i] = key;
    nodes[i] = node;
  }
  /** Pops min; returns node index. Key of popped is in lastKey. */
  lastKey = 0;
  pop(): number {
    const keys = this.keys;
    const nodes = this.nodes;
    const topNode = nodes[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const node = nodes[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        const r = c + 1;
        if (r < n && (keys[r] < keys[c] || (keys[r] === keys[c] && nodes[r] < nodes[c]))) c = r;
        const ck = keys[c];
        if (ck > key || (ck === key && nodes[c] >= node)) break;
        keys[i] = ck;
        nodes[i] = nodes[c];
        i = c;
      }
      keys[i] = key;
      nodes[i] = node;
    }
    return topNode;
  }
}
