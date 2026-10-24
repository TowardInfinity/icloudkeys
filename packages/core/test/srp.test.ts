import { describe, expect, it } from "vitest";
import { bytesToHex, bytesToUtf8, hexToBytes } from "../src/bytes.ts";
import { SRPSession } from "../src/srp.ts";
import vectors from "./srp-vectors.json" with { type: "json" };

// generated from open-passwords' srp.js, which pairs with the live helper; includes a salt
// with a leading zero byte and a session key whose high byte is zero
describe.each(vectors)("golden vector (base64=$base64, salt $salt)", (v) => {
  function session() {
    const queue = [hexToBytes(v.usernameBytes), hexToBytes(v.clientPrivateKey), hexToBytes(v.requestIv)];
    return new SRPSession({ base64: v.base64, random: () => queue.shift()! });
  }

  it("matches A, M, HAMK and both AES directions", async () => {
    const s = session();
    expect(s.username).toBe(v.username);
    expect(bytesToHex(s.clientPublicKey)).toBe(v.A);
    expect(s.serialize(s.clientPublicKey)).toBe(v.A_wire);

    s.setChallenge(hexToBytes(v.B), hexToBytes(v.salt));
    const m = await s.computeProof(v.pin);
    expect(bytesToHex(m)).toBe(v.M);
    expect(s.serialize(m, false)).toBe(v.M_wire);
    expect(bytesToHex(await s.expectedServerProof(m))).toBe(v.HAMK);

    expect(bytesToHex(await s.encrypt(v.request))).toBe(v.encrypted);
    const reply = JSON.parse(bytesToUtf8(await s.decrypt(hexToBytes(v.replyBytes))));
    expect(reply).toEqual(v.decryptedReply);
  });

  it("a wrong code gives a different proof", async () => {
    const s = session();
    s.setChallenge(hexToBytes(v.B), hexToBytes(v.salt));
    expect(bytesToHex(await s.computeProof("111111"))).not.toBe(v.M);
  });
});

it("rejects an out-of-range server key", () => {
  const s = new SRPSession();
  expect(() => s.setChallenge(new Uint8Array([0]), new Uint8Array([1]))).toThrow("invalid server public key");
});
