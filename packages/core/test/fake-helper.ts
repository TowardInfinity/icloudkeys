// A stand-in for Apple's helper that runs the server side of SRP-6a, so the client's whole
// flow (capabilities, m0/m2, encrypted queries) can be exercised without a Mac.

import {
  base64ToBytes,
  bigIntToBytes,
  bytesToBase64,
  bytesToBigInt,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  hexToBytes,
  mod,
  padBytes,
  powmod,
  randomBytes,
  sha256,
  utf8ToBytes,
  type Bytes,
} from "../src/bytes.ts";
import type { DisconnectReason, HelperMessage, HelperPort } from "../src/protocol.ts";

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const g = 5n;

export interface Vault {
  [hostname: string]: { username: string; password: string }[];
}

export class FakeHelper {
  base64 = false;
  pin = "424242";
  /** Every message the client sent, for assertions. */
  readonly received: HelperMessage[] = [];
  private onMsg: (m: HelperMessage) => void = () => {};
  private onDisc: (r: DisconnectReason) => void = () => {};
  private challenge: { tid: string; A: bigint; b: bigint; B: bigint; salt: Bytes; v: bigint } | undefined;
  private key: CryptoKey | undefined;
  private tid = "";

  constructor(private readonly vault: Vault = {}) {}

  port(): HelperPort {
    return {
      postMessage: (m) => {
        this.received.push(m);
        void this.handle(m).then((reply) => reply && queueMicrotask(() => this.onMsg(reply)));
      },
      onMessage: (fn) => (this.onMsg = fn),
      onDisconnect: (fn) => (this.onDisc = fn),
      disconnect: () => {},
    };
  }

  /** Simulates the helper side going away (e.g. it crashed or the user quit Passwords). */
  drop(reason: DisconnectReason = "closed"): void {
    this.onDisc(reason);
  }

  /** Pushes an unsolicited message, like RELOGIN_NEEDED. */
  push(m: HelperMessage): void {
    this.onMsg(m);
  }

  private ser(b: Uint8Array, prefix = true): string {
    return this.base64 ? bytesToBase64(b) : (prefix ? "0x" : "") + bytesToHex(b);
  }

  private de(s: string): Bytes {
    return this.base64 ? base64ToBytes(s) : hexToBytes(s);
  }

  private async handle(m: HelperMessage): Promise<HelperMessage | undefined> {
    switch (m.cmd) {
      case 14:
        return { cmd: 14, capabilities: { shouldUseBase64: this.base64, secretSessionVersion: 1 } };
      case 2:
        return m.msg.QID === "m0" ? this.hello(m) : this.verify(m);
      case 4:
      case 5:
        return this.query(m);
    }
    return undefined;
  }

  private async hello(m: HelperMessage): Promise<HelperMessage> {
    const pake = JSON.parse(bytesToUtf8(base64ToBytes(m.msg.PAKE)));
    const salt = randomBytes(16);
    const x = bytesToBigInt(await sha256(salt, await sha256(utf8ToBytes(pake.TID + ":" + this.pin))));
    const v = powmod(g, x, N);
    const k = bytesToBigInt(await sha256(bigIntToBytes(N), padBytes(bigIntToBytes(g), 384)));
    const b = bytesToBigInt(randomBytes(32));
    const B = mod(k * v + powmod(g, b, N), N);
    this.challenge = { tid: pake.TID, A: bytesToBigInt(this.de(pake.A)), b, B, salt, v };
    this.key = undefined;
    return this.pake(m.cmd, { TID: pake.TID, MSG: 1, B: this.ser(bigIntToBytes(B)), s: this.ser(salt), PROTO: 1 });
  }

  private async verify(m: HelperMessage): Promise<HelperMessage> {
    const pake = JSON.parse(bytesToUtf8(base64ToBytes(m.msg.PAKE)));
    const c = this.challenge;
    this.challenge = undefined; // a challenge is single-use, like the real helper
    if (!c || c.tid !== pake.TID) return this.pake(m.cmd, { TID: pake.TID, MSG: 3, ErrCode: 2 });
    const Ab = bigIntToBytes(c.A);
    const Bb = bigIntToBytes(c.B);
    const u = bytesToBigInt(await sha256(padBytes(Ab, 384), padBytes(Bb, 384)));
    const S = powmod(mod(c.A * powmod(c.v, u, N), N), c.b, N);
    const K = padBytes(await sha256(bigIntToBytes(S)), 32);
    const hN = await sha256(bigIntToBytes(N));
    const hg = await sha256(padBytes(bigIntToBytes(g), 384));
    const M = await sha256(hN.map((x, i) => x ^ hg[i]!), await sha256(utf8ToBytes(c.tid)), c.salt, Ab, Bb, K);
    if (bytesToHex(M) !== bytesToHex(this.de(pake.M))) return this.pake(m.cmd, { TID: c.tid, MSG: 3, ErrCode: 1 });
    this.key = await crypto.subtle.importKey("raw", K.slice(0, 16), "AES-GCM", false, ["encrypt", "decrypt"]);
    this.tid = c.tid;
    const hamk = await sha256(Ab, M, K);
    return this.pake(m.cmd, { TID: c.tid, MSG: 3, ErrCode: 0, HAMK: this.ser(hamk) });
  }

  private async query(m: HelperMessage): Promise<HelperMessage> {
    if (!this.key) throw new Error("fake helper: query before pairing");
    const smsg = JSON.parse(m.payload.SMSG);
    const data = this.de(smsg.SDATA);
    // requests are ciphertext+tag || iv
    const iv = data.slice(data.length - 16);
    const req = JSON.parse(
      bytesToUtf8(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, data.slice(0, -16)))),
    );
    const logins = this.vault[req.URL] ?? [];
    let res: object;
    if (m.cmd === 4) {
      res = logins.length
        ? { STATUS: 0, Entries: logins.map((l) => ({ USR: l.username, sites: [req.URL] })) }
        : { STATUS: 3 };
    } else {
      const hit = logins.find((l) => l.username === req.USR);
      res = hit ? { STATUS: 0, Entries: [{ USR: hit.username, PWD: hit.password, sites: [req.URL] }] } : { STATUS: 3 };
    }
    // replies are iv || ciphertext+tag
    const riv = randomBytes(16);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: riv }, this.key, utf8ToBytes(JSON.stringify(res))),
    );
    return { cmd: m.cmd, payload: { SMSG: JSON.stringify({ TID: this.tid, SDATA: this.ser(concatBytes(riv, ct)) }) } };
  }

  private pake(cmd: number, obj: object): HelperMessage {
    return { cmd, payload: { PAKE: bytesToBase64(utf8ToBytes(JSON.stringify(obj))) } };
  }
}
