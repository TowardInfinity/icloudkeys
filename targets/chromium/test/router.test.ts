// The background's trust boundary: what a content script (so, any page) can ask for, and where
// the answers go. Runs the router against the fake helper, with no browser.

import { PasswordsClient } from "@icloudkeys/core";
import { describe, expect, it, vi } from "vitest";
import { FakeHelper } from "../../../packages/core/test/fake-helper.ts";
import type { ToContent } from "../src/messages.ts";
import { createRouter, webHost, type Sender } from "../src/router.ts";

const EXT = "pejdijmoenmkgeppbflobdenhhabjlaj";
const POPUP = `chrome-extension://${EXT}/popup.html`;

async function setup(opts: { unlocked?: boolean; codes?: boolean } = {}) {
  const helper = new FakeHelper({
    "example.com": [{ username: "alice", password: "hunter2" }],
    "login.example.com": [{ username: "frame-user", password: "frame-pw" }],
    "evil.example": [{ username: "mallory", password: "nope" }],
  });
  if (opts.codes) {
    helper.capabilities = { canFillOneTimeCodes: true };
    helper.codes = [
      { source: "sms", username: "", domain: "example.com", code: "111111" },
      { source: "totp", username: "alice", domain: "example.com", code: "222222" },
    ];
  }
  let t = 1_000_000;
  const client = new PasswordsClient({ connect: () => helper.port(), now: () => t });
  if (opts.unlocked !== false) {
    await client.connect();
    await client.requestChallenge();
    await client.verifyPin(helper.pin);
  }
  const sent: { tabId: number; frameId: number; msg: ToContent }[] = [];
  const hme = { session: vi.fn(), generate: vi.fn(async () => "abc@icloud.com"), reserve: vi.fn(async () => ({}) as any) };
  const handle = createRouter({
    client,
    hme,
    appName: "iCloudKeys",
    extensionId: EXT,
    popupUrl: POPUP,
    now: () => t,
    activeTab: async () => ({ id: 1, url: "https://example.com/login" }),
    sendToFrame: async (tabId, frameId, msg) => {
      sent.push({ tabId, frameId, msg });
      return { filled: true };
    },
  });
  return { helper, client, handle, sent, hme, advance: (ms: number) => (t += ms) };
}

const page = (url = "https://example.com/login", frameId = 0, tabUrl = url): Sender => ({
  id: EXT,
  url,
  frameId,
  tab: { id: 1, url: tabUrl },
});
const popup: Sender = { id: EXT, url: POPUP };

describe("who may ask", () => {
  it("ignores other extensions entirely", async () => {
    const { handle } = await setup();
    expect(await handle({ type: "status" }, { id: "someone-else", url: POPUP })).toBeUndefined();
  });

  it.each(["pair", "verify", "logins", "fill", "codes", "fillCode", "launch", "hmeStatus"])(
    "refuses the popup-only %s from a page",
    async (type) => {
      const { handle } = await setup();
      const res = await handle({ type, pin: "424242", username: "alice", id: 0, mode: "search" }, page());
      expect(res).toMatchObject({ ok: false, error: "forbidden" });
    },
  );

  it("refuses page requests from non-HTTPS frames", async () => {
    const { handle, helper } = await setup();
    for (const type of ["inlineLogins", "inlineFill", "inlineCodes", "offerSave"]) {
      const res = await handle({ type, username: "alice", password: "x", isNew: false }, page("http://example.com/"));
      expect(res).toMatchObject({ ok: false, error: "not a secure page" });
    }
    expect(helper.saved).toEqual([]);
  });

  it("treats loopback and .test as local development", () => {
    expect(webHost("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(webHost("http://app.test/")).toBe("app.test");
    expect(webHost("http://example.com/")).toBeUndefined();
    expect(webHost("file:///etc/passwd")).toBeUndefined();
  });
});

describe("inline fill", () => {
  it("lists logins for the frame's own host, without passwords", async () => {
    const { handle } = await setup();
    const res = await handle({ type: "inlineLogins" }, page());
    expect(res).toMatchObject({ ok: true, logins: [{ username: "alice" }] });
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  it("queries by the sender's host and fills only the asking frame, pinned to it", async () => {
    const { handle, sent } = await setup();
    // a page naming another host in the message gets nothing for it
    const res = await handle(
      { type: "inlineFill", username: "frame-user", host: "evil.example", url: "https://evil.example/" },
      page("https://login.example.com/embed", 7, "https://example.com/"),
    );
    expect(res).toMatchObject({ ok: true });
    expect(JSON.stringify(res)).not.toContain("frame-pw");
    expect(sent).toEqual([
      { tabId: 1, frameId: 7, msg: { type: "fill", expectedHost: "login.example.com", username: "frame-user", password: "frame-pw" } },
    ]);
  });

  it("never fills another site's login", async () => {
    const { handle, sent } = await setup();
    const res = await handle({ type: "inlineFill", username: "mallory" }, page());
    expect(res).toMatchObject({ ok: false, error: "login not found for this site" });
    expect(sent).toEqual([]);
  });

  it("answers locked with no logins rather than an error", async () => {
    const { handle } = await setup({ unlocked: false });
    expect(await handle({ type: "inlineLogins" }, page())).toMatchObject({ ok: true, logins: [], status: { state: "needs_pin" } });
  });
});

describe("saving", () => {
  it("saves under the sender's host, whatever the message claims", async () => {
    const { handle, helper } = await setup();
    await handle({ type: "offerSave", username: "bob", password: "pw1", isNew: false, url: "https://evil.example/" }, page());
    expect(helper.saved).toEqual([{ host: "example.com", username: "bob", password: "pw1" }]);
  });

  it("gives a username-less password change to the site's only login", async () => {
    const { handle, helper } = await setup();
    await handle({ type: "offerSave", username: "", password: "new-pw", isNew: true }, page());
    expect(helper.saved).toEqual([{ host: "example.com", username: "alice", password: "new-pw" }]);
  });

  it("drops saves while locked", async () => {
    const { handle, helper } = await setup({ unlocked: false });
    expect(await handle({ type: "offerSave", username: "bob", password: "pw", isNew: false }, page())).toMatchObject({ ok: true });
    expect(helper.saved).toEqual([]);
  });
});

describe("one-time codes", () => {
  it("lists codes by id only and fills the value into the asking frame", async () => {
    const { handle, sent } = await setup({ codes: true });
    const listed = await handle({ type: "inlineCodes" }, page("https://example.com/2fa", 3));
    expect(listed).toMatchObject({ ok: true, codes: [{ id: 0, source: "sms" }, { id: 1, source: "totp" }] });
    expect(JSON.stringify(listed)).not.toMatch(/111111|222222/);

    await handle({ type: "inlineFillCode", id: 1 }, page("https://example.com/2fa", 3));
    expect(sent.at(-1)).toEqual({ tabId: 1, frameId: 3, msg: { type: "fillCode", expectedHost: "example.com", code: "222222" } });
  });

  it("won't hand a code listed for one frame to another", async () => {
    const { handle, sent } = await setup({ codes: true });
    await handle({ type: "inlineCodes" }, page("https://example.com/2fa", 3));
    const res = await handle({ type: "inlineFillCode", id: 0 }, page("https://example.com/ad", 9));
    expect(res).toMatchObject({ ok: false, error: "code listed for another frame" });
    expect(sent).toEqual([]);
  });

  it("expires a stale list", async () => {
    const { handle, advance } = await setup({ codes: true });
    await handle({ type: "inlineCodes" }, page());
    advance(2 * 60_000 + 1);
    expect(await handle({ type: "inlineFillCode", id: 0 }, page())).toMatchObject({ ok: false, error: /expired/ });
  });
});

describe("Hide My Email", () => {
  it("labels the alias with the sender's host and rate-limits a page", async () => {
    const { handle, hme, advance } = await setup();
    expect(await handle({ type: "hmeCreate", label: "spoofed" }, page())).toMatchObject({ ok: true, address: "abc@icloud.com" });
    expect(hme.reserve).toHaveBeenCalledWith("abc@icloud.com", "example.com", "Generated through iCloudKeys");
    expect(await handle({ type: "hmeCreate" }, page())).toMatchObject({ ok: false });
    advance(10_001);
    expect(await handle({ type: "hmeCreate" }, page())).toMatchObject({ ok: true });
    expect(hme.reserve).toHaveBeenCalledTimes(2);
  });
});

describe("popup", () => {
  it("fills the active tab's top frame", async () => {
    const { handle, sent } = await setup();
    expect(await handle({ type: "fill", username: "alice" }, popup)).toMatchObject({ ok: true });
    expect(sent).toEqual([{ tabId: 1, frameId: 0, msg: { type: "fill", expectedHost: "example.com", username: "alice", password: "hunter2" } }]);
  });

  it("is recognised by URL even when opened as a tab", async () => {
    const { handle } = await setup();
    expect(await handle({ type: "logins" }, { ...popup, tab: { id: 5, url: POPUP } })).toMatchObject({ ok: true });
  });
});
