// Receipt signing helpers shared by helpers (sign), game (countersign) and server (verify + Merkle root).
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import nacl from 'tweetnacl';
import type { JobType } from './types';

export { bytesToHex, hexToBytes };

/** receiptMessage = sha256(`${jobId}|${type}|${workUnits}|${outputHash}`) */
export function receiptMessage(jobId: string, type: JobType, workUnits: number, outputHash: string): Uint8Array {
  return sha256(utf8ToBytes(`${jobId}|${type}|${workUnits}|${outputHash}`));
}

export function newKeypair(): { publicKey: string; secretKey: string } {
  const kp = nacl.sign.keyPair();
  return { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.secretKey) };
}

export function signMessage(msg: Uint8Array, secretKeyHex: string): string {
  return bytesToHex(nacl.sign.detached(msg, hexToBytes(secretKeyHex)));
}

export function verifyMessage(msg: Uint8Array, sigHex: string, publicKeyHex: string): boolean {
  try {
    return nacl.sign.detached.verify(msg, hexToBytes(sigHex), hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

/** Merkle root: sha256 pairwise over sorted leaves (leaves = receipt messages). Odd node is carried up. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].map((l) => bytesToHex(l)).sort().map((h) => hexToBytes(h));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) { next.push(level[i]); continue; }
      const buf = new Uint8Array(64);
      buf.set(level[i], 0);
      buf.set(level[i + 1], 32);
      next.push(sha256(buf));
    }
    level = next;
  }
  return level[0];
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
