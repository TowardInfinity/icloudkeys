// The background's trust boundary: what a content script (so, any page) can ask for, and where
// the answers go. Runs the router against the fake helper, with no browser.

import { PasswordsClient } from "@icloudkeys/core";
import { describe, expect, it, vi } from "vitest";
import { FakeHelper } from "../../../packages/core/test/fake-helper.ts";
import type { ToContent } from "../src/messages.ts";
import { createRouter, webHost, type Sender } from "../src/router.ts";

const EXT = "pejdijmoenmkgeppbflobdenhhabjlaj";
const POPUP = `chrome-extension://${EXT}/popup.html`;

async function setup(
  opts: { unlocked?: boolean; codes?: boolean; setIcon?: (unlocked: boolean) => void; loginShown?: boolean; watching?: boolean } = {},
) {
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
  const hme = { session: vi.fn(async () => ({ available: true })), generate: vi.fn(async () => "abc@icloud.com"), reserve: vi.fn(async () => ({}) as any) };
  const handle = createRouter({
    client,
    hme,
    appName: "iCloudKeys",
    extensionId: EXT,
    popupUrl: POPUP,
    now: () => t,
    setIcon: opts.setIcon,
    activeTab: async () => ({ id: 1, url: "https://example.com/login" }),
    sendToFrame: async (tabId, frameId, msg) => {
      sent.push({ tabId, frameId, msg });
      if (msg.type === "signInCheck") return { filled: false, loginShown: opts.loginShown, watching: opts.watching };
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

  const typed = { type: "offerSave", username: "bob", password: "pw1", isNew: false, afterSignIn: true };

  it("holds a typed password until the sign-in is reported working", async () => {
    const { handle, helper } = await setup();
    await handle(typed, page());
    expect(helper.saved).toEqual([]);
    await handle({ type: "signInOutcome", ok: true }, page());
    expect(helper.saved).toEqual([{ host: "example.com", username: "bob", password: "pw1" }]);
  });

  it("never offers a password whose sign-in failed, or one settled by another site", async () => {
    const { handle, helper } = await setup();
    await handle(typed, page());
    await handle({ type: "signInOutcome", ok: true }, page("https://evil.example/"));
    await handle({ type: "signInOutcome", ok: false }, page());
    await handle({ type: "signInOutcome", ok: true }, page());
    expect(helper.saved).toEqual([]);
  });

  it("drops a held password once the hold runs out", async () => {
    const { handle, helper, advance } = await setup();
    await handle(typed, page());
    advance(61_000);
    await handle({ type: "signInOutcome", ok: true }, page());
    expect(helper.saved).toEqual([]);
  });

  it("saves after a navigation only when the new page shows no login", async () => {
    for (const [loginShown, saves] of [[false, 1], [true, 0]] as const) {
      const { handle, helper } = await setup({ loginShown });
      await handle(typed, page());
      await handle.tabLoaded(1);
      expect(helper.saved).toHaveLength(saves);
      // settled either way: a later page can't save it
      await handle({ type: "signInOutcome", ok: true }, page());
      expect(helper.saved).toHaveLength(saves);
    }
  });

  it("leaves a sign-in to the page that's still watching it", async () => {
    const { handle, helper } = await setup({ loginShown: true, watching: true });
    await handle(typed, page());
    await handle.tabLoaded(1);
    await handle({ type: "signInOutcome", ok: true }, page());
    expect(helper.saved).toHaveLength(1);
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
  const tab2: Sender = { id: EXT, url: "https://example.com/signup", frameId: 0, tab: { id: 2, url: "https://example.com/signup" } };

  it("creates only the address it showed, labelled with the sender's host", async () => {
    const { handle, hme, advance } = await setup();
    expect(await handle({ type: "hmeGenerate" }, page())).toMatchObject({ ok: true, address: "abc@icloud.com" });
    expect(hme.reserve).not.toHaveBeenCalled();
    const res = await handle({ type: "hmeReserve", address: "victim@icloud.com", label: "spoofed" } as any, page());
    expect(res).toMatchObject({ ok: true, address: "abc@icloud.com" });
    expect(hme.reserve).toHaveBeenCalledWith("abc@icloud.com", "example.com", "Generated through iCloudKeys");
    // used up: a second Use creates nothing, even past the cooldown
    advance(10_001);
    expect(await handle({ type: "hmeReserve" }, page())).toMatchObject({ ok: false });
    expect(hme.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["without a shown address", async (h: any) => undefined],
    ["from another tab", async (h: any) => h({ type: "hmeGenerate" }, tab2)],
  ])("refuses Use %s", async (_name, before) => {
    const { handle, hme } = await setup();
    await before(handle);
    expect(await handle({ type: "hmeReserve" }, page())).toMatchObject({ ok: false });
    expect(hme.reserve).not.toHaveBeenCalled();
  });

  it("refuses Use after the tab moved to another site or frame, or the address went stale", async () => {
    const { handle, hme, advance } = await setup();
    await handle({ type: "hmeGenerate" }, page());
    expect(await handle({ type: "hmeReserve" }, page("https://evil.example/"))).toMatchObject({ ok: false });
    expect(await handle({ type: "hmeReserve" }, page("https://example.com/login", 3))).toMatchObject({ ok: false });
    advance(5 * 60_000 + 1);
    expect(await handle({ type: "hmeReserve" }, page())).toMatchObject({ ok: false, error: /choose Hide My Email again/ });
    expect(hme.reserve).not.toHaveBeenCalled();
  });

  it("rate-limits Refresh and creation per page", async () => {
    const { handle, hme, advance } = await setup();
    await handle({ type: "hmeGenerate" }, page());
    expect(await handle({ type: "hmeGenerate" }, page())).toMatchObject({ ok: false });
    advance(2_001);
    await handle({ type: "hmeGenerate" }, page());
    expect(hme.generate).toHaveBeenCalledTimes(2);
    await handle({ type: "hmeReserve" }, page());
    advance(2_001);
    await handle({ type: "hmeGenerate" }, page());
    expect(await handle({ type: "hmeReserve" }, page())).toMatchObject({ ok: false, error: /wait/ });
    advance(10_001);
    expect(await handle({ type: "hmeReserve" }, page())).toMatchObject({ ok: true });
  });

  it("no longer lets a page create an address in one step", async () => {
    const { handle, hme } = await setup();
    expect(await handle({ type: "hmeCreate" }, page())).toMatchObject({ ok: false, error: "forbidden" });
    expect(hme.generate).not.toHaveBeenCalled();
  });
});

describe("Hide My Email availability", () => {
  it("checks the iCloud.com session once per interval and reports it in status", async () => {
    const { handle, hme, advance } = await setup();
    expect(await handle({ type: "inlineStatus" }, page())).toMatchObject({ status: { canHideEmail: true } });
    await handle({ type: "inlineLogins" }, page());
    await handle({ type: "hmeStatus" }, popup);
    expect(hme.session).toHaveBeenCalledTimes(1);
    advance(5 * 60_000 + 1);
    hme.session.mockResolvedValueOnce({ available: false, reason: "not-signed-in" } as any);
    expect(await handle({ type: "inlineStatus" }, page())).toMatchObject({ status: { canHideEmail: false, hmeNeedsSignIn: true } });
    // signing in to iCloud.com shows up within seconds, not minutes
    advance(30_001);
    expect(await handle({ type: "inlineStatus" }, page())).toMatchObject({ status: { canHideEmail: true } });
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

describe("Open Passwords App from a page", () => {
  it("searches for the asking frame's own page, whatever the message says", async () => {
    const { handle, client } = await setup();
    const launch = vi.spyOn(client, "launchPasswordsApp");
    await handle({ type: "inlineLaunch", searchUrl: "https://evil.example/" } as any, page("https://example.com/login"));
    expect(launch).toHaveBeenCalledWith({ searchUrl: "https://example.com/login" });
    expect(await handle({ type: "inlineLaunch" }, page("http://example.com/"))).toMatchObject({ ok: false });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("toolbar icon", () => {
  it("follows the session: locked, unlocked, then locked again when the helper goes away", async () => {
    const setIcon = vi.fn();
    const { client, helper } = await setup({ unlocked: false, setIcon });
    expect(setIcon.mock.calls).toEqual([[false]]);
    await client.connect();
    await client.requestChallenge();
    await client.verifyPin(helper.pin);
    expect(setIcon).toHaveBeenLastCalledWith(true);
    client.disconnect();
    expect(setIcon).toHaveBeenLastCalledWith(false);
  });

  it("starts unlocked when the router is made after pairing", async () => {
    const setIcon = vi.fn();
    await setup({ setIcon });
    expect(setIcon.mock.calls).toEqual([[true]]);
  });
});
