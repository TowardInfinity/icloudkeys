// Every message the background accepts, with no extension APIs of its own so it can be tested
// against the fake helper. Hosts, tabs and frames come from the browser's `sender`, never from a
// message body: a page can send anything through its content script.

import { ProtocolError, type FrameTarget, type OneTimeCode, type PasswordsClient } from "@icloudkeys/core";
import type { HmeClient, HmeSession } from "@icloudkeys/hme";
import type { CodeRow, ContentRequest, FillResult, Request, Response, Status, ToContent, UiRequest } from "./messages.ts";

export interface Sender {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number; url?: string };
}

export interface Tab {
  id?: number;
  url?: string;
}

export interface RouterEnv {
  client: PasswordsClient;
  extensionId: string;
  popupUrl: string;
  /** Written into each alias's note in iCloud. */
  appName: string;
  activeTab(): Promise<Tab | undefined>;
  sendToFrame(tabId: number, frameId: number, msg: ToContent): Promise<FillResult | undefined>;
  hme?: Pick<HmeClient, "session" | "generate" | "reserve">;
  openPopup?(): Promise<void>;
  /** Shows the toolbar icon for unlocked (true) or anything else (false). */
  setIcon?(unlocked: boolean): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

const CONTENT_TYPES = new Set<ContentRequest["type"]>([
  "inlineStatus",
  "inlineLogins",
  "inlineFill",
  "inlinePick",
  "inlineCodes",
  "inlineFillCode",
  "inlineIdStep",
  "offerSave",
  "signInOutcome",
  "openPopup",
  "inlineLaunch",
  "hmeGenerate",
  "hmeReserve",
]);

// long enough for a captcha between a login's steps
const PICK_TTL_MS = 10 * 60_000;
// a listed code is picked within seconds; past this the list is stale and a TOTP has rotated
const CODE_LIST_TTL_MS = 2 * 60_000;
// one alias per page per interval, so a page script can't fill the user's alias list
const HME_COOLDOWN_MS = 10_000;
// Refresh asks iCloud for another address; a held-down Enter must not hammer it
const HME_GENERATE_GAP_MS = 2_000;
// an address shown in the list and never used goes back to iCloud's pool
const HME_PENDING_TTL_MS = 5 * 60_000;
// a sign-in answers within this, or its save is dropped
const SAVE_HOLD_MS = 60_000;
// how long an iCloud.com sign-in check holds, so focusing email fields doesn't hammer validate
const HME_SESSION_TTL_MS = 5 * 60_000;
// short when unavailable, so signing in to iCloud.com takes effect on the next field
const HME_UNAVAILABLE_TTL_MS = 30_000;

/** HTTPS, or the loopback and reserved-TLD hosts used for local development. */
export function webHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol === "https:") return host;
  const local =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".test");
  return u.protocol === "http:" && local ? host : undefined;
}

class Refused extends Error {}

interface Where {
  tabId: number;
  frameId: number;
  host: string;
  frameUrls: string[];
}

export function createRouter(env: RouterEnv) {
  const { client } = env;
  const now = () => env.now?.() ?? Date.now();
  const codesByTab = new Map<number, { at: number; entries: OneTimeCode[]; target: FrameTarget }>();
  const picks = new Map<number, { at: number; host: string; username: string }>();
  const idSteps = new Map<number, { at: number; host: string; username: string }>();
  const hmeAt = new Map<number, number>();
  const hmeGeneratedAt = new Map<number, number>();
  // the address shown to each tab; a page can only ever reserve the one we generated for it
  const hmePending = new Map<number, { at: number; frameId: number; host: string; address: string }>();
  let hmeSession: { at: number; value: HmeSession } | undefined;
  // a typed password waits here, per tab, until the sign-in it was typed for is seen to work
  const heldSaves = new Map<number, { at: number; host: string; frameId: number; username: string; password: string; isNew: boolean }>();

  if (env.setIcon) {
    const setIcon = env.setIcon;
    setIcon(client.state === "unlocked");
    client.onStateChange((s) => setIcon(s === "unlocked"));
  }

  const status = (): Status => ({
    state: client.state,
    hasChallenge: client.hasChallenge,
    canFillCodes: client.canFillOneTimeCodes,
    canOpenNewPassword: client.canOpenNewPasswordSheet,
    canHideEmail: hmeSession?.value.available === true,
    hmeNeedsSignIn: hmeSession?.value.reason === "not-signed-in",
  });

  async function checkHme(): Promise<HmeSession> {
    if (!env.hme) return { available: false };
    const ttl = hmeSession?.value.available ? HME_SESSION_TTL_MS : HME_UNAVAILABLE_TTL_MS;
    if (hmeSession && now() - hmeSession.at < ttl) return hmeSession.value;
    const value = await env.hme.session().catch((): HmeSession => ({ available: false }));
    hmeSession = { at: now(), value };
    return value;
  }

  /** The asking frame, for content scripts. */
  function senderFrame(sender: Sender): Where {
    const tabId = sender.tab?.id;
    const host = webHost(sender.url);
    if (tabId === undefined || sender.frameId === undefined) throw new Refused("no frame");
    if (!host) throw new Refused("not a secure page");
    const frameUrls = [...new Set([sender.url!, sender.tab?.url].filter((u): u is string => !!webHost(u)))];
    return { tabId, frameId: sender.frameId, host, frameUrls };
  }

  /** The active tab's top frame, for the popup. */
  async function activeFrame(): Promise<Where> {
    const tab = await env.activeTab();
    const host = webHost(tab?.url);
    if (tab?.id === undefined || !host) throw new Refused("not a secure web page");
    return { tabId: tab.id, frameId: 0, host, frameUrls: [tab.url!] };
  }

  /** The ID submitted on the page before, once. A filled pick never names a save: it may be an old account's. */
  function takeIdStep(at: Where): string {
    const step = idSteps.get(at.tabId);
    idSteps.delete(at.tabId);
    return step && step.host === at.host && now() - step.at < PICK_TTL_MS ? step.username : "";
  }

  function livePick(at: Where): string | undefined {
    const pick = picks.get(at.tabId);
    return pick && pick.host === at.host && now() - pick.at < PICK_TTL_MS ? pick.username : undefined;
  }

  async function fillLogin(at: Where, username: string): Promise<Response> {
    const cred = await client.getPassword(at.tabId, at.host, username);
    if (!cred) throw new Refused("login not found for this site");
    const res = await env.sendToFrame(at.tabId, at.frameId, {
      type: "fill",
      expectedHost: at.host,
      username: cred.username,
      password: cred.password,
    });
    if (!res?.filled) throw new Refused(res?.error ?? "no login fields to fill on this page");
    picks.set(at.tabId, { at: now(), host: at.host, username: cred.username });
    return { ok: true, status: status() };
  }

  async function listCodes(at: Where): Promise<Response> {
    if (!client.ready || !client.canFillOneTimeCodes) return { ok: true, status: status(), codes: [] };
    const target = { tabId: at.tabId, frameId: at.frameId, frameUrls: at.frameUrls };
    const { entries, requiresAuth } = await client.getOneTimeCodes(target);
    codesByTab.set(at.tabId, { at: now(), entries, target });
    const codes: CodeRow[] = entries.map((e, id) => ({ id, source: e.source, username: e.username, domain: e.domain }));
    const picked = livePick(at);
    return { ok: true, status: status(), codes, requiresAuth, ...(picked ? { picked } : {}) };
  }

  /** The value of a listed code, re-read for TOTP so a rotated one is never filled. */
  async function resolveCode(at: Where, id: number): Promise<string> {
    const listed = codesByTab.get(at.tabId);
    if (!listed || now() - listed.at > CODE_LIST_TTL_MS) throw new Refused("code list expired, focus the field again");
    // a code listed for one frame is never handed to another
    if (listed.target.frameId !== at.frameId) throw new Refused("code listed for another frame");
    const entry = listed.entries[id];
    if (!entry) throw new Refused("unknown code");
    if (entry.source !== "totp") return entry.code;
    const fresh = await client.readOneTimeCode(listed.target, entry.username);
    const hit = fresh.find((e) => e.source === "totp" && e.username === entry.username && e.domain === entry.domain) ?? fresh[0];
    if (!hit?.code) throw new Refused("no current code");
    return hit.code;
  }

  async function createAlias(at: Where): Promise<Response> {
    if (!env.hme) throw new Refused("Hide My Email is not available");
    const last = hmeAt.get(at.tabId) ?? -Infinity;
    if (now() - last < HME_COOLDOWN_MS) throw new Refused("wait a moment before creating another address");
    hmeAt.set(at.tabId, now());
    const address = await env.hme.generate().catch((e) => {
      // a failure here usually means the sign-in lapsed; recheck before offering again
      hmeSession = undefined;
      throw e;
    });
    await env.hme.reserve(address, at.host, `Generated through ${env.appName}`);
    return { ok: true, status: status(), address };
  }

  async function generateAlias(at: Where): Promise<Response> {
    if (!env.hme) throw new Refused("Hide My Email is not available");
    if (now() - (hmeGeneratedAt.get(at.tabId) ?? -Infinity) < HME_GENERATE_GAP_MS) throw new Refused("wait a moment");
    hmeGeneratedAt.set(at.tabId, now());
    const address = await env.hme.generate().catch((e) => {
      hmeSession = undefined;
      throw e;
    });
    hmePending.set(at.tabId, { at: now(), frameId: at.frameId, host: at.host, address });
    return { ok: true, status: status(), address };
  }

  async function reserveAlias(at: Where): Promise<Response> {
    if (!env.hme) throw new Refused("Hide My Email is not available");
    const pending = hmePending.get(at.tabId);
    if (!pending || now() - pending.at > HME_PENDING_TTL_MS) throw new Refused("no address to use, choose Hide My Email again");
    // shown to one frame of one site; a navigation or another frame can't claim it
    if (pending.frameId !== at.frameId || pending.host !== at.host) throw new Refused("address shown for another page");
    if (now() - (hmeAt.get(at.tabId) ?? -Infinity) < HME_COOLDOWN_MS) throw new Refused("wait a moment before creating another address");
    hmeAt.set(at.tabId, now());
    hmePending.delete(at.tabId);
    await env.hme.reserve(pending.address, at.host, `Generated through ${env.appName}`);
    return { ok: true, status: status(), address: pending.address };
  }

  async function ui(req: UiRequest): Promise<Response> {
    switch (req.type) {
      case "status":
        return { ok: true, status: status() };
      case "pair":
        await client.requestChallenge({ ifNeeded: true });
        return { ok: true, status: status() };
      case "verify":
        await client.verifyPin(req.pin);
        return { ok: true, status: status() };
      case "logins": {
        const at = await activeFrame();
        return { ok: true, status: status(), host: at.host, logins: await client.getLoginNames(at.tabId, at.host) };
      }
      case "fill":
        // the tab may have navigated since the list was shown; query and pin to where it is now
        return fillLogin(await activeFrame(), req.username);
      case "codes":
        return listCodes(await activeFrame());
      case "fillCode": {
        const at = await activeFrame();
        const code = await resolveCode(at, req.id);
        const res = await env.sendToFrame(at.tabId, at.frameId, { type: "fillCode", expectedHost: at.host, code });
        // shown in the popup only when no field took it, so the user can type it
        return { ok: true, status: status(), code: res?.filled ? undefined : code };
      }
      case "launch": {
        const tab = await env.activeTab();
        const url = webHost(tab?.url) ? tab!.url : undefined;
        client.launchPasswordsApp(req.mode === "new" && url ? { newPasswordUrl: url } : url ? { searchUrl: url } : {});
        return { ok: true, status: status() };
      }
      case "hmeStatus": {
        // opening the popup is rare and the user may have just signed in, so nothing to wait out
        if (hmeSession?.value.reason === "not-signed-in") hmeSession = undefined;
        const hme = await checkHme();
        return { ok: true, status: status(), hme };
      }
      case "hmeCreate":
        return createAlias(await activeFrame());
    }
  }

  async function content(req: ContentRequest, sender: Sender): Promise<Response> {
    if (req.type === "inlineStatus") {
      await checkHme();
      return { ok: true, status: status() };
    }
    if (req.type === "openPopup") {
      await env.openPopup?.();
      return { ok: true, status: status() };
    }
    const at = senderFrame(sender);
    switch (req.type) {
      case "inlineLogins":
        await checkHme();
        if (!client.ready) return { ok: true, status: status(), logins: [] };
        {
          const logins = await client.getLoginNames(at.tabId, at.host);
          const picked = livePick(at);
          return { ok: true, status: status(), logins, ...(picked && logins.some((l) => l.username === picked) ? { picked } : {}) };
        }
      case "inlineFill":
        return fillLogin(at, String(req.username ?? ""));
      case "inlinePick": {
        const username = String(req.username ?? "");
        if (username) picks.set(at.tabId, { at: now(), host: at.host, username });
        else {
          picks.delete(at.tabId);
          idSteps.delete(at.tabId);
        }
        return { ok: true, status: status() };
      }
      case "inlineCodes":
        return listCodes(at);
      case "inlineFillCode": {
        const code = await resolveCode(at, Number(req.id));
        const res = await env.sendToFrame(at.tabId, at.frameId, { type: "fillCode", expectedHost: at.host, code });
        if (!res?.filled) throw new Refused(res?.error ?? "no code field to fill");
        return { ok: true, status: status() };
      }
      case "inlineIdStep": {
        const username = String(req.username ?? "").trim();
        if (!username) return { ok: true, status: status() };
        idSteps.set(at.tabId, { at: now(), host: at.host, username });
        picks.set(at.tabId, { at: now(), host: at.host, username });
        return { ok: true, status: status() };
      }
      case "offerSave": {
        const save = { at: now(), host: at.host, frameId: at.frameId, username: String(req.username ?? "").trim() || takeIdStep(at), password: String(req.password ?? ""), isNew: !!req.isNew };
        if (!save.password) throw new Refused("no password");
        if (req.afterSignIn) heldSaves.set(at.tabId, save);
        else await saveLogin(at.tabId, save);
        return { ok: true, status: status() };
      }
      case "signInOutcome": {
        const held = heldSaves.get(at.tabId);
        // only the site the password was typed into settles it
        if (!held || held.host !== at.host) return { ok: true, status: status() };
        heldSaves.delete(at.tabId);
        if (req.ok && now() - held.at < SAVE_HOLD_MS) await saveLogin(at.tabId, held);
        return { ok: true, status: status() };
      }
      case "inlineLaunch":
        // the search is for the asking frame's own page, never a URL the page names
        client.launchPasswordsApp(at.frameUrls[0] ? { searchUrl: at.frameUrls[0] } : {});
        return { ok: true, status: status() };
      case "hmeGenerate":
        return generateAlias(at);
      case "hmeReserve":
        return reserveAlias(at);
    }
  }

  async function saveLogin(tabId: number, save: { host: string; username: string; password: string; isNew: boolean }): Promise<void> {
    // a locked session can't save; the user hasn't been asked for anything yet, so drop it
    if (!client.ready) return;
    let username = save.username;
    // a password change with no username field belongs to the site's only login
    if (!username && save.isNew) {
      const existing = await client.getLoginNames(tabId, save.host).catch(() => []);
      if (existing.length === 1) username = existing[0]!.username;
    }
    await client.saveLogin(tabId, save.host, username, save.password);
  }

  /**
   * A page finished loading in a tab whose save waits on a sign-in: a submit that navigated. The
   * sign-in worked if the new page shows no login form; one shown again is a failed attempt.
   */
  async function tabLoaded(tabId: number): Promise<void> {
    const held = heldSaves.get(tabId);
    if (!held) return;
    if (now() - held.at >= SAVE_HOLD_MS) return void heldSaves.delete(tabId);
    const ask = (frameId: number) => env.sendToFrame(tabId, frameId, { type: "signInCheck" }).catch(() => undefined);
    const frames = [...new Set([0, held.frameId])];
    let answers = await Promise.all(frames.map(ask));
    // the content script can start just after the load completes
    if (answers[0]?.loginShown === undefined) {
      await env.sleep?.(1_000);
      answers = await Promise.all(frames.map(ask));
    }
    // a newer submit replaced it while we asked
    if (heldSaves.get(tabId) !== held) return;
    // not one of our pages (or none yet): leave it to the next load or the hold running out;
    // the same page, still watching, settles it itself
    if (answers[0]?.loginShown === undefined || answers.some((a) => a?.watching)) return;
    heldSaves.delete(tabId);
    if (answers.every((a) => !a?.loginShown)) await saveLogin(tabId, held).catch(() => {});
  }

  /** Answers one message, or `undefined` when it isn't ours to answer. */
  const handle = async function handle(msg: unknown, sender: Sender): Promise<Response | undefined> {
    if (sender.id !== env.extensionId || typeof msg !== "object" || msg === null) return undefined;
    const req = msg as Request;
    // the popup can also be opened as a tab, so it's told apart by its URL alone
    const fromPopup = sender.url === env.popupUrl;
    const fromContent = !fromPopup && sender.tab !== undefined;
    try {
      if (fromPopup) {
        await client.connect();
        return await ui(req as UiRequest);
      }
      if (fromContent && CONTENT_TYPES.has(req.type as ContentRequest["type"])) {
        await client.connect().catch(() => {});
        return await content(req as ContentRequest, sender);
      }
      return { ok: false, status: status(), error: "forbidden" };
    } catch (e) {
      return {
        ok: false,
        status: status(),
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof ProtocolError ? e.code : undefined,
      };
    }
  };
  return Object.assign(handle, { tabLoaded });
}
