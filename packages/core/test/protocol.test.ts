import { describe, expect, it, vi } from "vitest";
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

  it("recovers after the capabilities request times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { client, helper } = setup();
      helper.silent = true;
      const first = client.connect();
      const second = client.connect(); // shares the attempt instead of racing it
      const settled = Promise.allSettled([first, second]);
      await vi.advanceTimersByTimeAsync(5001);
      expect((await settled).map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(helper.connections).toBe(1);
      expect(client.state).toBe("disconnected");

      helper.silent = false;
      await client.connect();
      expect(helper.connections).toBe(2);
      expect(client.state).toBe("needs_pin");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("saving and one-time codes", () => {
  it("offers a login to the helper with MAYBE_ADD", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    await client.saveLogin(3, "example.com", "carol", "s3cret");
    expect(helper.saved).toEqual([{ host: "example.com", username: "carol", password: "s3cret" }]);
    expect(helper.requests.at(-1)).toMatchObject({ ACT: 4, URL: "", USR: "", PWD: "" });
    expect(helper.received.at(-1)?.payload.QID).toBe("CmdNewAccount4URL");
  });

  it("treats an unacknowledged save as sent, since the Mac's prompt is still up", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    helper.slowSave = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const save = client.saveLogin(3, "example.com", "carol", "s3cret");
      // encryption runs off the fake clock; the timeout is armed only once the request is sent
      await vi.waitFor(() => expect(helper.saved).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(3001);
      await expect(save).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to save an empty password", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    await expect(client.saveLogin(3, "example.com", "carol", "")).rejects.toBeInstanceOf(ProtocolError);
  });

  it("lists no codes when the helper lacks the capability", async () => {
    const { client, helper } = setup();
    helper.codes = [{ source: "sms", username: "", domain: "example.com", code: "123456" }];
    await pair(client, helper);
    const target = { tabId: 1, frameId: 0, frameUrls: ["https://example.com/"] };
    expect(await client.getOneTimeCodes(target)).toEqual({ entries: [], requiresAuth: false });
  });

  it("lists codes, keeping TOTP entries whose value is read at fill time", async () => {
    const { client, helper } = setup();
    helper.capabilities = { canFillOneTimeCodes: true };
    helper.codes = [
      { source: "sms", username: "", domain: "example.com", code: "123456" },
      { source: "totp", username: "alice", domain: "example.com", code: "654321" },
    ];
    await pair(client, helper);
    const target = { tabId: 1, frameId: 2, frameUrls: ["https://example.com/"] };
    const listed = await client.getOneTimeCodes(target, "alice");
    expect(listed.requiresAuth).toBe(true);
    expect(listed.entries.map((e) => [e.source, e.code])).toEqual([
      ["sms", "123456"],
      ["totp", ""],
    ]);
    const sent = helper.received.at(-1)!;
    expect(sent.frameId).toBe(2);
    expect(sent.url).toBeUndefined();
    expect(helper.requests.at(-1)).toMatchObject({ ACT: 5, TYPE: "oneTimeCodes", username: "alice" });

    const read = await client.readOneTimeCode(target, "alice");
    expect(read.find((e) => e.source === "totp")?.code).toBe("654321");
  });

  it("notifies listeners of an unsolicited code", async () => {
    const { client, helper } = setup();
    await pair(client, helper);
    const fn = vi.fn();
    client.onOneTimeCode(fn);
    helper.push({ cmd: 15 });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("gates the launch variants on capabilities", async () => {
    const { client, helper } = setup();
    await client.connect();
    expect(() => client.launchPasswordsApp({ newPasswordUrl: "https://example.com" })).toThrow(ProtocolError);
    expect(() => client.launchPasswordsApp({ totpUri: "otpauth://totp/x?secret=A" })).toThrow(ProtocolError);
    client.launchPasswordsApp({ searchUrl: "example.com" });
    expect(helper.received.at(-1)).toEqual({ cmd: 13, searchQueryURL: "example.com" });
  });
});
