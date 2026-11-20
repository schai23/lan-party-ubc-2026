// NPC dialogue: voice in (ElevenLabs STT via server, or Web Speech fallback) -> dialogue job
// (remote helper via router, or the host's own Ollama) -> streamed bubble + per-sentence TTS.
import type { DialogueInput, Dispatch, NpcId } from '@sidekick/shared';
import { LOCAL_OLLAMA_URL, api } from '../env';
import { router } from '../sidekick/router';
import { store } from '../sidekick/store';

export const NPCS: { id: NpcId; name: string; persona: string; color: number; pitch: number }[] = [
  {
    id: 'innkeeper',
    name: 'Mara the Innkeeper',
    persona: 'Mara, the warm, gossipy innkeeper of the Lantern Tavern in Lanternfall. Knows every rumor, calls travelers "love".',
    color: 0xf2b84b,
    pitch: 1.1,
  },
  {
    id: 'blacksmith',
    name: 'Bram the Blacksmith',
    persona: 'Bram, the gruff, proud blacksmith of Lanternfall. Short sentences, talks about steel, fire and fair prices.',
    color: 0xe0603a,
    pitch: 0.75,
  },
  {
    id: 'oracle',
    name: 'The Oracle',
    persona: 'The Oracle of the lantern temple. Speaks in calm, cryptic riddles and omens about what lies beyond the east gate.',
    color: 0x9b7bff,
    pitch: 1.3,
  },
];

export const DEFAULT_DISPATCH: Dispatch = {
  date: new Date().toISOString().slice(0, 10),
  source: 'default',
  worldEvent: {
    title: 'The Lantern Festival approaches',
    summary: 'Villagers prepare lanterns for the festival while strange lights flicker beyond the east gate.',
  },
  quests: [
    { npcId: 'innkeeper', title: 'Festival supplies', description: 'Bring honey cakes from the market.' },
    { npcId: 'blacksmith', title: 'Iron for the lanterns', description: 'Fetch ore from beyond the gate.' },
    { npcId: 'oracle', title: 'The flickering lights', description: 'Discover what glows past the east gate.' },
  ],
  fallbackLines: {
    innkeeper: ['Welcome, love! The festival has everyone in a fine mood.', 'Pull up a stool, the stew is hot tonight.'],
    blacksmith: ['Steel does not lie. Neither do I.', 'Need a blade? Bring coin and patience.'],
    oracle: ['The lights beyond the gate are waiting for you.', 'What you seek has already seen you.'],
  },
  area: { theme: 'misty forest', seed: 1337, buildingTypes: ['hut', 'shrine', 'tower', 'mill'] },
  loreMentions: [],
};

const history: Record<string, { role: 'player' | 'npc'; text: string }[]> = {};

// ---------------- Voice output ----------------
let audioQueue: Promise<void> = Promise.resolve();
let turnStart = 0;
let firstAudioSeen = false;

function markFirstAudio(source: string) {
  if (firstAudioSeen) return;
  firstAudioSeen = true;
  store.ttfaMs = performance.now() - turnStart;
  store.ttfaSource = source;
}

function speakBrowser(npcId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = NPCS.find((n) => n.id === npcId)?.pitch ?? 1;
    u.rate = 1.05;
    u.onstart = () => markFirstAudio('browser');
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function speak(npcId: string, text: string) {
  const clean = text.trim();
  if (!clean) return;
  if (store.voice !== 'elevenlabs') {
    audioQueue = audioQueue.then(() => speakBrowser(npcId, clean));
    return;
  }
  // Fetch starts immediately (parallel); playback is queued in order.
  const audioP = fetch(api('/api/tts'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ npcId, text: clean }),
  })
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`tts ${r.status}`))))
    .catch(() => null);
  audioQueue = audioQueue.then(async () => {
    const blob = await audioP;
    if (!blob) return speakBrowser(npcId, clean);
    const url = URL.createObjectURL(blob);
    await new Promise<void>((resolve) => {
      const a = new Audio(url);
      a.onplaying = () => markFirstAudio('elevenlabs');
      a.onended = () => resolve();
      a.onerror = () => resolve();
      a.play().catch(() => resolve());
    });
    URL.revokeObjectURL(url);
  });
}

/** Splits streamed text into sentences; calls onSentence for each completed one. */
function sentenceSplitter(onSentence: (s: string) => void) {
  let buf = '';
  return {
    push(delta: string) {
      buf += delta;
      for (;;) {
        const m = /^(.*?[.!?…]+["')\]]?)(\s+)/s.exec(buf);
        if (!m) break;
        onSentence(m[1]);
        buf = buf.slice(m[0].length);
      }
    },
    flush() {
      if (buf.trim()) onSentence(buf);
      buf = '';
    },
  };
}

// ---------------- Dialogue generation ----------------
function buildInput(npcId: NpcId, playerLine: string): DialogueInput {
  const d = store.dispatch ?? DEFAULT_DISPATCH;
  const npc = NPCS.find((n) => n.id === npcId)!;
  const quest = d.quests.find((q) => q.npcId === npcId);
  return {
    npcId,
    persona: npc.persona,
    worldEvent: `${d.worldEvent.title}: ${d.worldEvent.summary}`,
    quest: quest ? `${quest.title}: ${quest.description}` : '',
    playerLine,
    history: (history[npcId] ?? []).slice(-6),
  };
}

function systemPrompt(i: DialogueInput): string {
  return [
    `You are ${i.persona}`,
    `Today in the village: ${i.worldEvent}`,
    i.quest ? `Your quest for travelers: ${i.quest}` : '',
    'Stay in character. Reply with at most 2 short sentences. No narration, no emojis.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function localOllama(i: DialogueInput, model: string, onDelta: (t: string) => void): Promise<string> {
  const messages = [
    { role: 'system', content: systemPrompt(i) },
    ...i.history.map((h) => ({ role: h.role === 'player' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: i.playerLine },
  ];
  const r = await fetch(`${LOCAL_OLLAMA_URL.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, options: { num_predict: 90, temperature: 0.8 } }),
  });
  if (!r.ok || !r.body) throw new Error(`ollama ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let pending = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line) as { message?: { content?: string } };
        const t = j.message?.content ?? '';
        if (t) {
          full += t;
          onDelta(t);
        }
      } catch {
        /* partial line */
      }
    }
  }
  return full;
}

let busy = false;

export async function talk(npcId: NpcId, playerLine: string, model: string) {
  if (busy || !playerLine.trim()) return;
  busy = true;
  const npc = NPCS.find((n) => n.id === npcId)!;
  const dlg = store.dialogue;
  dlg.npcId = npcId;
  dlg.npcName = npc.name;
  dlg.player = playerLine;
  dlg.text = '';
  dlg.status = 'thinking…';
  turnStart = performance.now();
  firstAudioSeen = false;
  const split = sentenceSplitter((s) => speak(npcId, s));
  const onDelta = (t: string) => {
    dlg.text += t;
    dlg.status = '';
    split.push(t);
  };
  const input = buildInput(npcId, playerLine);
  let reply = '';
  try {
    if (router.canRemote('dialogue')) {
      try {
        dlg.source = 'helper';
        const r = await router.submitRemote('dialogue', input, onDelta);
        const full = (r.output as { text?: string } | undefined)?.text ?? dlg.text;
        if (full.startsWith(dlg.text) && full.length > dlg.text.length) onDelta(full.slice(dlg.text.length));
        reply = full || dlg.text;
      } catch (e) {
        console.info('[dialogue] remote failed, using local', e);
        if (dlg.text) reply = dlg.text; // partial stream already shown
      }
    }
    if (!reply) {
      dlg.text = '';
      const t0 = performance.now();
      try {
        dlg.source = 'host Ollama';
        reply = await localOllama(input, model, onDelta);
        router.recordLocalDialogue(performance.now() - t0);
      } catch (e) {
        console.info('[dialogue] local Ollama unreachable, using dispatch fallback', e);
        const d = store.dispatch ?? DEFAULT_DISPATCH;
        const lines = d.fallbackLines[npcId] ?? [];
        reply = lines.length ? lines[Math.floor(Math.random() * lines.length)] : '…';
        dlg.source = 'dispatch fallback';
        dlg.text = '';
        onDelta(reply + ' ');
      }
    }
    split.flush();
    dlg.text = reply;
    dlg.status = '';
    const h = (history[npcId] ??= []);
    h.push({ role: 'player', text: playerLine }, { role: 'npc', text: reply });
  } finally {
    busy = false;
  }
}

// ---------------- Voice input ----------------
type Rec = { stop: () => Promise<string> };

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function browserRecognition(): Rec | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.continuous = true;
  let text = '';
  let ended: () => void = () => undefined;
  const endP = new Promise<void>((r) => (ended = r));
  rec.onresult = (e) => {
    text = Array.from(e.results).map((r) => r[0].transcript).join(' ');
  };
  rec.onend = () => ended();
  rec.onerror = () => ended();
  rec.start();
  return {
    async stop() {
      rec.stop();
      await endP;
      return text;
    },
  };
}

async function serverStt(): Promise<Rec> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.start();
  return {
    stop: () =>
      new Promise<string>((resolve) => {
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          try {
            const fd = new FormData();
            fd.append('audio', blob, 'speech.webm');
            const r = await fetch(api('/api/stt'), { method: 'POST', body: fd });
            const j = (await r.json()) as { text?: string };
            resolve(j.text ?? '');
          } catch {
            resolve('');
          }
        };
        mr.stop();
      }),
  };
}

let current: Rec | null = null;

export async function startListening() {
  if (current || busy) return;
  store.listening = true;
  try {
    current = store.voice === 'elevenlabs' ? await serverStt() : browserRecognition();
  } catch (e) {
    console.warn('[voice] mic unavailable', e);
    current = browserRecognition();
  }
  if (!current) store.listening = false;
}

export async function stopListening(npcId: NpcId | null, model: string) {
  const rec = current;
  current = null;
  store.listening = false;
  if (!rec) return;
  store.dialogue.status = 'transcribing…';
  const text = (await rec.stop()).trim();
  store.dialogue.status = '';
  if (npcId && text) await talk(npcId, text, model);
}
