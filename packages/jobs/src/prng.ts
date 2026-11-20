import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Mulberry32 PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash -> [0,1). */
export function latticeHash(seed: number, ix: number, iy: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth-interpolated (smoothstep) value noise on an integer lattice. Returns [0,1). */
export function valueNoise2D(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const v00 = latticeHash(seed, x0, y0);
  const v10 = latticeHash(seed, x0 + 1, y0);
  const v01 = latticeHash(seed, x0, y0 + 1);
  const v11 = latticeHash(seed, x0 + 1, y0 + 1);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(v)) {
    const parts = new Array<string>(v.length);
    for (let i = 0; i < v.length; i++) parts[i] = canonical(v[i]);
    return '[' + parts.join(',') + ']';
  }
  if (ArrayBuffer.isView(v)) return canonical(Array.from(v as unknown as ArrayLike<number>));
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function canonicalJson(obj: unknown): string {
  return canonical(obj);
}

/** Hex sha256 of canonical JSON (sorted object keys). */
export function hashOutput(obj: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(obj))));
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = new Uint8Array(64);
for (let i = 0; i < 64; i++) B64_CODES[i] = B64.charCodeAt(i);
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP['-'.charCodeAt(0)] = 62;
B64_LOOKUP['_'.charCodeAt(0)] = 63;

/** Standard base64 encode (no Buffer, works in browser and Node). */
export function bytesToB64(u8: Uint8Array): string {
  const n = u8.length;
  const outLen = Math.ceil(n / 3) * 4;
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const t = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out[o++] = B64_CODES[(t >> 18) & 63];
    out[o++] = B64_CODES[(t >> 12) & 63];
    out[o++] = B64_CODES[(t >> 6) & 63];
    out[o++] = B64_CODES[t & 63];
  }
  const rem = n - i;
  if (rem === 1) {
    const t = u8[i] << 16;
    out[o++] = B64_CODES[(t >> 18) & 63];
    out[o++] = B64_CODES[(t >> 12) & 63];
    out[o++] = 61;
    out[o++] = 61;
  } else if (rem === 2) {
    const t = (u8[i] << 16) | (u8[i + 1] << 8);
    out[o++] = B64_CODES[(t >> 18) & 63];
    out[o++] = B64_CODES[(t >> 12) & 63];
    out[o++] = B64_CODES[(t >> 6) & 63];
    out[o++] = 61;
  }
  // Chunked conversion to string to avoid call-stack limits.
  let s = '';
  const CH = 0x8000;
  for (let p = 0; p < outLen; p += CH) {
    s += String.fromCharCode.apply(null, out.subarray(p, Math.min(p + CH, outLen)) as unknown as number[]);
  }
  return s;
}

/** Base64 decode (accepts standard and url-safe alphabets, ignores whitespace). */
export function b64ToBytes(s: string): Uint8Array {
  const vals = new Uint8Array(s.length);
  let m = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 256 ? B64_LOOKUP[c] : -1;
    if (v >= 0) vals[m++] = v;
  }
  const outLen = Math.floor((m * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 3 < m; i += 4) {
    const t = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = (t >> 16) & 255;
    out[o++] = (t >> 8) & 255;
    out[o++] = t & 255;
  }
  const rem = m - i;
  if (rem === 2) {
    const t = (vals[i] << 18) | (vals[i + 1] << 12);
    out[o++] = (t >> 16) & 255;
  } else if (rem === 3) {
    const t = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6);
    out[o++] = (t >> 16) & 255;
    out[o++] = (t >> 8) & 255;
  }
  return o === outLen ? out : out.subarray(0, o);
}
