// ElevenLabs proxy (spec 8.5): streaming TTS with an on-disk cache, and speech-to-text.
import { cfg, integrationStatus } from '@sidekick/shared/config';
import type { NpcId } from '@sidekick/shared';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/tts-cache');
const EL = 'https://api.elevenlabs.io/v1';

export function voiceConfigured(): boolean {
  return !!integrationStatus().find((r) => r.name.startsWith('ElevenLabs'))?.configured;
}

export function voiceIdFor(npcId: string): string | undefined {
  return ({ innkeeper: cfg.VOICE_ID_INNKEEPER, blacksmith: cfg.VOICE_ID_BLACKSMITH, oracle: cfg.VOICE_ID_ORACLE } as Record<string, string | undefined>)[npcId];
}

const cachePath = (npcId: string, text: string) =>
  resolve(CACHE_DIR, createHash('sha1').update(npcId + text).digest('hex') + '.mp3');

async function fetchTts(voiceId: string, text: string): Promise<Response> {
  const url = `${EL}/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;
  return fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': cfg.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: cfg.ELEVENLABS_TTS_MODEL }),
  });
}

/**
 * Returns a readable mp3 stream: from the disk cache if present, else ElevenLabs streaming TTS,
 * piped to the caller as bytes arrive while being written to the cache.
 */
export async function ttsStream(npcId: NpcId | string, text: string): Promise<Readable> {
  const path = cachePath(npcId, text);
  if (existsSync(path)) return createReadStream(path);
  const voiceId = voiceIdFor(npcId);
  if (!voiceId) throw new Error(`no voice for ${npcId}`);
  const res = await fetchTts(voiceId, text);
  if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.part`;
  const file = createWriteStream(tmp);
  const src = Readable.fromWeb(res.body as any);
  const out = new PassThrough();
  src.pipe(out);
  src.pipe(file);
  src.on('error', () => { file.destroy(); try { unlinkSync(tmp); } catch {} });
  file.on('finish', () => { try { renameSync(tmp, path); } catch {} });
  return out;
}

/** Pre-generate cache entries (used when a new dispatch arrives). Errors are logged, never thrown. */
export async function pregenerateTts(lines: { npcId: string; text: string }[]): Promise<void> {
  if (!voiceConfigured()) return;
  for (const l of lines) {
    if (existsSync(cachePath(l.npcId, l.text))) continue;
    try {
      const s = await ttsStream(l.npcId, l.text);
      await new Promise<void>((res, rej) => { s.on('end', res); s.on('error', rej); s.resume(); });
    } catch (e) {
      console.warn(`[tts] pregenerate failed for ${l.npcId}:`, (e as Error).message);
    }
  }
}

export async function stt(audio: Buffer, filename: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append('model_id', cfg.ELEVENLABS_STT_MODEL);
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), filename || 'audio.webm');
  const res = await fetch(`${EL}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': cfg.ELEVENLABS_API_KEY! }, body: form });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  return j.text ?? '';
}
