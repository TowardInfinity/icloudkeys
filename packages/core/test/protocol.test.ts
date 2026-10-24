import { describe, expect, it } from "vitest";
import { PasswordsClient, ProtocolError, type State } from "../src/protocol.ts";
import { FakeHelper } from "./fake-helper.ts";

const vault = {
  "example.com": [
    { username: "alice@example.com", password: "hunter2" },
    { username: "bob", password: "correct horse" },
  ],
};

function setup(opts: { base64?: boolean } = {}) {
  const helper = new FakeHelper(vault);
  helper.base64 = opts.base64 ?? false;
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const client = new PasswordsClient({ connect: () => helper.port(), now: () => t });
  const states: State[] = [];
  client.onStateChange((s) => states.push(s));
  return { helper, client, clock, states };
}

async function pair(client: PasswordsClient, helper: FakeHelper) {
  await client.connect();
  await client.requestChallenge();
  await client.verifyPin(helper.pin);
}

describe.each([false, true])("pairing (base64=%s)", (base64) => {
  it("pairs with the right code and lists and reads logins", async () => {
    const { client, helper, states } = setup({ base64 });
    await pair(client, helper);
    expect(client.state).toBe("unlocked");
    expect(states).toEqual(["needs_pin", "unlocked"]);

    const logins = await client.getLoginNames(7, "example.com");
    expect(logins.map((l) => l.username)).toEqual(["alice@example.com", "bob"]);
    expect(await client.getPassword(7, "example.com", "bob")).toEqual({
      username: "bob",
      password: "correct horse",
      sites: ["example.com"],
    });
  });
});

describe("protocol", () => {
  it("sends the HSTBRSR and PROTO fields the helper expects in m0", async () => {
    const { client, helper } = setup();
    await client.connect();
    await client.requestChallenge();
    const m0 = helper.received.find((m) => m.cmd === 2)!;
    expect(m0.msg.QID).toBe("m0");
    expect(m0.msg.HSTBRSR).toBe("Chrome");
    const pake = JSON.parse(atob(m0.msg.PAKE));
    expect(pake).toMatchObject({ MSG: 0, VER: "1.0", PROTO: [1] });
  });

  it("rejects a wrong code and needs a fresh challenge afterwards", async () => {
    const { client, helper } = setup();
    await client.connect();
    await client.requestChallenge();
    await expect(client.verifyPin("000000")).rejects.toMatchObject({ code: "incorrect_code" });
    expect(client.state).toBe("needs_pin");
    expect(client.hasChallenge).toBe(false);
    // the next attempt re-issues instead of verifying against the burned challenge
    await expect(client.verifyPin(helper.pin)).rejects.toMatchObject({ code: "challenge_reissued" });
    await client.verifyPin(helper.pin);
    expect(client.state).toBe("unlocked");
  });

  it("re-issues an expired challenge instead of verifying it", async () => {
    const { client, helper, clock } = setup();
    await client.connect();
    await client.requestChallenge();
    clock.advance(3 * 60_000 + 1);
    await expect(client.verifyPin(helper.pin)).rejects.toMatchObject({ code: "challenge_reissued" });
    expect(client.hasChallenge).toBe(true);
  });

  it("requestChallenge with ifNeeded keeps a live prompt", async () => {
    const { client, helper } = setup();
    await client.connect();
    expect(await client.requestChallenge({ ifNeeded: true })).toBe(true);
    expect(await client.requestChallenge({ ifNeeded: true })).toBe(false);
    expect(helper.received.filter((m) => m.cmd === 2)).toHaveLength(1);
  });

  it("concurrent queries are serialized, not rejected as in-flight", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    const [a, b] = await Promise.all([
      client.getPassword(1, "example.com", "alice@example.com"),
      client.getPassword(1, "example.com", "bob"),
    ]);
    expect([a?.password, b?.password]).toEqual(["hunter2", "correct horse"]);
  });

  it("returns nothing for a site with no logins", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    expect(await client.getLoginNames(1, "other.test")).toEqual([]);
    expect(await client.getPassword(1, "other.test", "alice@example.com")).toBeUndefined();
  });

  it("refuses queries before pairing", async () => {
    const { client } = setup();
    await client.connect();
    await expect(client.getLoginNames(1, "example.com")).rejects.toBeInstanceOf(ProtocolError);
  });

  it("RELOGIN_NEEDED locks the session", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    helper.push({ cmd: 10 });
    expect(client.state).toBe("needs_pin");
    expect(client.ready).toBe(false);
  });

  it("maps a missing helper and a dropped port to distinct states", async () => {
    const missing = new PasswordsClient({
      connect: () => {
        throw new Error("Specified native messaging host not found.");
      },
    });
    await expect(missing.connect()).rejects.toThrow("not found");
    expect(missing.state).toBe("no_helper");

    const { client, helper } = setup();
    await pair(client, helper);
    helper.drop("closed");
    expect(client.state).toBe("disconnected");
    expect(client.ready).toBe(false);
  });
});
