// SRP-6a (RFC 5054) client where the 6-digit code macOS shows is the password, plus the
// AES-GCM session it keys. Derived from open-passwords src/srp.js, itself ported from
// au2001/icloud-passwords-firefox (Apache-2.0). See NOTICE.

import {
  type Bytes,
  base64ToBytes,
  bigIntToBytes,
  bytesToBase64,
  bytesToBigInt,
  bytesToHex,
  concatBytes,
  hexToBytes,
  mod,
  padBytes,
  powmod,
  randomBytes,
  sha256,
  utf8ToBytes,
} from "./bytes.ts";

// RFC 5054 appendix A, 3072-bit group. One wrong digit silently breaks interop with the helper.
const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const N_BYTES = 384;
const g = 5n;

if (N.toString(16).length !== 768) throw new Error("SRP group prime is corrupt");

export const SecretSessionVersion = { SRPWithOldVerification: 0, SRPWithRFCVerification: 1 } as const;
export const MSGType = {
  ClientKeyExchange: 0,
  ServerKeyExchange: 1,
  ClientVerification: 2,
  ServerVerification: 3,
} as const;

export interface SessionOptions {
  /** The helper's `shouldUseBase64` capability; hex with a 0x prefix otherwise. */
  base64?: boolean;
  /** Injected for deterministic tests. */
  random?: (count: number) => Bytes;
}

export class SRPSession {
  readonly base64: boolean;
  readonly username: string;
  private readonly random: (count: number) => Bytes;
  private readonly privateKey: bigint;
  private serverPublicKey: bigint | undefined;
  private salt: Bytes | undefined;
  private sharedKey: Bytes | undefined;
  private aesKey: Promise<CryptoKey> | undefined;

  constructor({ base64 = false, random = randomBytes }: SessionOptions = {}) {
    this.base64 = base64;
    this.random = random;
    this.username = this.serialize(random(16));
    this.privateKey = bytesToBigInt(random(32));
  }

  // A and B stay minimal big-endian on the wire; only u pads them, per RFC 5054 PAD()
  get clientPublicKey(): Bytes {
    return bigIntToBytes(powmod(g, this.privateKey, N));
  }

  get hasChallenge(): boolean {
    return this.serverPublicKey !== undefined;
  }

  get isKeyed(): boolean {
    return this.sharedKey !== undefined;
  }

  serialize(bytes: Uint8Array, prefix = true): string {
    if (this.base64) return bytesToBase64(bytes);
    return (prefix ? "0x" : "") + bytesToHex(bytes);
  }

  deserialize(s: string): Bytes {
    return this.base64 ? base64ToBytes(s) : hexToBytes(s);
  }

  /** Salt stays raw bytes: a bigint round trip drops a leading zero and looks like a wrong code. */
  setChallenge(serverPublicKey: Bytes, salt: Bytes): void {
    const B = bytesToBigInt(serverPublicKey);
    if (B <= 0n || B >= N || mod(B, N) === 0n) throw new Error("invalid server public key");
    if (salt.length === 0) throw new Error("invalid salt");
    this.reset();
    this.serverPublicKey = B;
    this.salt = salt;
  }

  /** Forgets the challenge and any key derived from it. */
  reset(): void {
    this.serverPublicKey = undefined;
    this.salt = undefined;
    this.sharedKey = undefined;
    this.aesKey = undefined;
  }

  /** Derives the session key from the code and returns M, the client proof. */
  async computeProof(pin: string): Promise<Bytes> {
    const { serverPublicKey: Bn, salt } = this;
    if (Bn === undefined || salt === undefined) throw new Error("no challenge");
    const A = this.clientPublicKey;
    const B = bigIntToBytes(Bn);

    // RFC 5054 requires u != 0, or the password drops out of S
    const u = bytesToBigInt(await sha256(padBytes(A, N_BYTES), padBytes(B, N_BYTES)));
    if (u === 0n) throw new Error("invalid SRP parameter: u == 0");
    const k = bytesToBigInt(await sha256(bigIntToBytes(N), padBytes(bigIntToBytes(g), N_BYTES)));
    const x = bytesToBigInt(await sha256(salt, await sha256(utf8ToBytes(this.username + ":" + pin))));

    const base = mod(Bn - mod(k * powmod(g, x, N), N), N);
    const S = powmod(base, this.privateKey + u * x, N);
    // pad so a zero high byte isn't dropped, which would shift the AES key
    const K = padBytes(await sha256(bigIntToBytes(S)), 32);
    this.sharedKey = K;

    const hN = await sha256(bigIntToBytes(N));
    const hg = await sha256(padBytes(bigIntToBytes(g), N_BYTES));
    const xored = hN.map((b, i) => b ^ hg[i]!);
    return sha256(xored, await sha256(utf8ToBytes(this.username)), salt, A, B, K);
  }

  /** The proof the server must return (HAMK) for client proof `m`. */
  async expectedServerProof(m: Bytes): Promise<Bytes> {
    if (!this.sharedKey) throw new Error("no shared key");
    return sha256(this.clientPublicKey, m, this.sharedKey);
  }

  private key(): Promise<CryptoKey> {
    if (!this.sharedKey) throw new Error("no shared key");
    this.aesKey ??= crypto.subtle.importKey("raw", this.sharedKey.slice(0, 16), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return this.aesKey;
  }

  /** Requests are ciphertext+tag || iv, matching Apple's SecretSession.encrypt. */
  async encrypt(obj: unknown): Promise<Bytes> {
    const iv = this.random(16);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), utf8ToBytes(JSON.stringify(obj)));
    return concatBytes(new Uint8Array(ct), iv);
  }

  /** Replies are iv || ciphertext+tag: the opposite order from requests, on purpose. */
  async decrypt(bytes: Bytes): Promise<Bytes> {
    const iv = bytes.slice(0, 16);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await this.key(), bytes.slice(16));
    return new Uint8Array(pt);
  }
}
