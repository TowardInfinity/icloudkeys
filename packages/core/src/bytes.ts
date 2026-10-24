// Derived from open-passwords src/crypto.js, itself ported from au2001/icloud-passwords-firefox
// (Apache-2.0). See NOTICE.

export type Bytes = Uint8Array<ArrayBuffer>;

export function hexToBytes(hex: string): Bytes {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function base64ToBytes(b64: string): Bytes {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const utf8ToBytes = (s: string): Bytes => new TextEncoder().encode(s) as Bytes;
export const bytesToUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function concatBytes(...arrays: Uint8Array[]): Bytes {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Minimal big-endian encoding; 0 encodes as a single zero byte. */
export function bigIntToBytes(n: bigint): Bytes {
  if (n === 0n) return new Uint8Array([0]);
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array(out);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** Left-pads with zeros to `length`, or keeps the low `length` bytes if longer. */
export function padBytes(bytes: Uint8Array, length: number): Bytes {
  if (bytes.length >= length) return bytes.slice(bytes.length - length);
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function sha256(...inputs: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concatBytes(...inputs)));
}

export function randomBytes(count: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(count));
}

export function mod(a: bigint, n: bigint): bigint {
  a %= n;
  return a < 0n ? a + n : a;
}

export function powmod(base: bigint, exp: bigint, n: bigint): bigint {
  if (exp < 0n) throw new Error("negative exponent unsupported");
  base = mod(base, n);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, n);
    base = mod(base * base, n);
    exp >>= 1n;
  }
  return result;
}
