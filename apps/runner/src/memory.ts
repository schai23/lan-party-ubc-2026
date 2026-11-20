// NPC memory (spec 10, P1): after each exchange, embed it with EMBED_MODEL (nomic-embed-text) via Ollama
// and keep an in-memory list per roomCode+npcId; retrieve the top 3 by cosine similarity for the next prompt.
import type { Ollama } from 'ollama';

interface Memory { text: string; vec: number[] }

export class NpcMemory {
  private store = new Map<string, Memory[]>();
  private enabled = true;

  constructor(private ollama: Ollama, private model: string) {}

  private key(roomCode: string, npcId: string) { return `${roomCode}:${npcId}`; }

  private async embed(text: string): Promise<number[] | null> {
    if (!this.enabled) return null;
    try {
      const r = await this.ollama.embed({ model: this.model, input: text });
      return r.embeddings?.[0] ?? null;
    } catch (e) {
      this.enabled = false;
      console.error(`NPC memory disabled: embedding with "${this.model}" failed (${(e as Error).message}). Run: ollama pull ${this.model}`);
      return null;
    }
  }

  /** Top-k past exchanges most similar to the player's line. */
  async recall(roomCode: string, npcId: string, query: string, k = 3): Promise<string[]> {
    const list = this.store.get(this.key(roomCode, npcId));
    if (!list?.length) return [];
    const q = await this.embed(query);
    if (!q) return [];
    return list
      .map((m) => ({ m, s: cosine(q, m.vec) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.m.text);
  }

  /** Store an exchange (call without awaiting; it must not delay the job result). */
  async remember(roomCode: string, npcId: string, playerLine: string, reply: string): Promise<void> {
    const text = `Traveler said: "${playerLine}" You replied: "${reply}"`;
    const vec = await this.embed(text);
    if (!vec) return;
    const k = this.key(roomCode, npcId);
    const list = this.store.get(k) ?? [];
    list.push({ text, vec });
    if (list.length > 200) list.shift();
    this.store.set(k, list);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
