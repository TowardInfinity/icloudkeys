// Client for Apple's com.apple.passwordmanager native-messaging helper. Derived from
// open-passwords src/protocol.js, itself ported from au2001/icloud-passwords-firefox
// (Apache-2.0). See NOTICE.
//
// Nothing here touches a browser API: the caller supplies the port, so this runs the same
// under an MV3 service worker, a Firefox event page, or a test.

import { base64ToBytes, bytesToBase64, bytesToUtf8, constantTimeEqual, utf8ToBytes } from "./bytes.ts";
import { MSGType, SRPSession, SecretSessionVersion } from "./srp.ts";

export const HOST_NAME = "com.apple.passwordmanager";

/** Numbering matches the helper's own ExtensionCommand enum. */
export const Command = {
  END: 0,
  HANDSHAKE: 2,
  GET_LOGIN_NAMES_FOR_URL: 4,
  GET_PASSWORD_FOR_LOGIN_NAME: 5,
  SET_PASSWORD_FOR_LOGIN_NAME_URL: 6,
  PASSWORDS_DISABLED: 9,
  RELOGIN_NEEDED: 10,
  LAUNCH_PASSWORDS_APP: 13,
  GET_CAPABILITIES: 14,
} as const;

const QueryId: Record<number, string> = {
  [Command.GET_LOGIN_NAMES_FOR_URL]: "CmdGetLoginNames4URL",
  [Command.GET_PASSWORD_FOR_LOGIN_NAME]: "CmdGetPassword4LoginName",
};

const Action = { SEARCH: 2, GHOST_SEARCH: 5 } as const;

export const QueryStatus = { Success: 0, NoResults: 3 } as const;

const STATUS_TEXT: Record<number, string> = {
  1: "Generic query error",
  2: "Invalid query param",
  4: "Failed to delete",
  5: "Failed to update",
  6: "Invalid message format",
  7: "Duplicate item",
  8: "Unknown action",
  9: "Invalid session",
};

const BROWSER_NAME = "Chrome";
const VERSION = "1.0";
// past this, re-prompt rather than verify against a code the user has lost track of
const CHALLENGE_TTL_MS = 3 * 60_000;

export type HelperMessage = { cmd: number; [key: string]: any };

export type DisconnectReason = "no_helper" | "closed";

/** The transport the target provides, e.g. a wrapped `chrome.runtime.connectNative` port. */
export interface HelperPort {
  postMessage(msg: HelperMessage): void;
  onMessage(fn: (msg: HelperMessage) => void): void;
  onDisconnect(fn: (reason: DisconnectReason) => void): void;
  disconnect(): void;
}

export type State = "disconnected" | "no_helper" | "needs_pin" | "unlocked";

export interface Login {
  username: string;
  sites: string[];
}

export interface Credential extends Login {
  password: string;
}

export class ProtocolError extends Error {
  /** `challenge_reissued`: the Mac now shows a new code; retyping the old one can never work. */
  constructor(
    message: string,
    readonly code?: "challenge_reissued" | "incorrect_code",
  ) {
    super(message);
  }
}

interface Waiter {
  resolve(msg: HelperMessage): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ClientOptions {
  connect: () => HelperPort;
  /** Injected for deterministic tests. */
  sessionOptions?: { random?: (count: number) => Uint8Array<ArrayBuffer> };
  now?: () => number;
}

export class PasswordsClient {
  state: State = "disconnected";
  capabilities: Record<string, unknown> = {};
  private port: HelperPort | undefined;
  private session: SRPSession | undefined;
  private readonly waiters = new Map<number, Waiter>();
  private readonly stateListeners = new Set<(s: State) => void>();
  private challengeAt = 0;
  private challengeGen = 0;
  private challengePending: Promise<boolean> | undefined;
  private connecting: Promise<void> | undefined;
  // replies carry no correlation id, so requests on the same cmd would collide: serialize all
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ClientOptions) {}

  onStateChange(fn: (s: State) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private setState(s: State): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) {
      try {
        fn(s);
      } catch {}
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private send(cmd: number, body: Record<string, unknown> = {}, timeoutMs: number | null = 5000): Promise<HelperMessage> {
    const port = this.port;
    if (!port) return Promise.reject(new ProtocolError("connection closed"));
    if (this.waiters.has(cmd)) return Promise.reject(new ProtocolError("another request is already in flight"));
    return new Promise((resolve, reject) => {
      const w: Waiter = { resolve, reject, timer: undefined };
      if (timeoutMs !== null) {
        w.timer = setTimeout(() => {
          if (this.waiters.get(cmd) === w) this.waiters.delete(cmd);
          reject(new ProtocolError("timeout waiting for response"));
        }, timeoutMs);
      }
      this.waiters.set(cmd, w);
      try {
        port.postMessage({ cmd, ...body });
      } catch (e) {
        clearTimeout(w.timer);
        this.waiters.delete(cmd);
        reject(e instanceof Error ? e : new ProtocolError(String(e)));
      }
    });
  }

  private dispatch(msg: HelperMessage): void {
    const w = this.waiters.get(msg.cmd);
    if (w) {
      this.waiters.delete(msg.cmd);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
    if (msg.cmd === Command.PASSWORDS_DISABLED || msg.cmd === Command.RELOGIN_NEEDED) {
      this.session?.reset();
      this.challengeAt = 0;
      if (this.port) this.setState("needs_pin");
    }
  }

  private dropConnection(reason: DisconnectReason): void {
    this.port = undefined;
    this.session = undefined;
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new ProtocolError("connection closed"));
    }
    this.waiters.clear();
    this.setState(reason === "no_helper" ? "no_helper" : "disconnected");
  }

  /** Opens the port and reads capabilities. A live, unlocked connection is left untouched. */
  connect(): Promise<void> {
    if (this.session) return Promise.resolve();
    // concurrent callers share one attempt, so none proceeds before the session exists
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<void> {
    let port: HelperPort;
    try {
      port = this.opts.connect();
    } catch (e) {
      this.setState("no_helper");
      throw e;
    }
    this.port = port;
    port.onMessage((m) => this.dispatch(m));
    port.onDisconnect((reason) => {
      if (this.port === port) this.dropConnection(reason);
    });

    let caps: Record<string, unknown>;
    try {
      const reply = await this.send(Command.GET_CAPABILITIES);
      caps = (reply.capabilities ?? {}) as Record<string, unknown>;
      // the helper negotiates per handshake via PROTO, so only an explicit non-RFC demand is fatal
      if (caps.secretSessionVersion !== undefined && caps.secretSessionVersion !== SecretSessionVersion.SRPWithRFCVerification) {
        throw new ProtocolError("helper requires an unsupported SRP verification mode");
      }
    } catch (e) {
      // a half-open port with no session would make every later connect() a no-op
      if (this.port === port) this.disconnect();
      throw e;
    }
    this.capabilities = caps;
    this.session = new SRPSession({ base64: caps.shouldUseBase64 === true, ...this.opts.sessionOptions });
    this.setState("needs_pin");
  }

  /** True while the code on the Mac belongs to our newest, unexpired challenge. */
  get hasChallenge(): boolean {
    return (
      this.state === "needs_pin" &&
      this.session?.hasChallenge === true &&
      this.now() - this.challengeAt < CHALLENGE_TTL_MS
    );
  }

  /** Asks the helper to show a code. `ifNeeded` keeps a live prompt instead of replacing it. */
  requestChallenge({ ifNeeded = false } = {}): Promise<boolean> {
    if (!this.session) return Promise.reject(new ProtocolError("not connected"));
    if (ifNeeded && (this.hasChallenge || this.state === "unlocked")) return Promise.resolve(false);
    // two prompts would race and only the last code would work
    if (this.challengePending) return this.challengePending;
    const p = this.withLock(() => this.issueChallenge());
    this.challengePending = p;
    const clear = () => {
      if (this.challengePending === p) this.challengePending = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  private async issueChallenge(): Promise<boolean> {
    const session = this.requireSession();
    session.reset();
    this.challengeGen++;
    this.setState("needs_pin");

    const reply = await this.send(Command.HANDSHAKE, {
      msg: {
        QID: "m0",
        PAKE: jsonToBase64({
          TID: session.username,
          MSG: MSGType.ClientKeyExchange,
          A: session.serialize(session.clientPublicKey),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRPWithRFCVerification],
        }),
        HSTBRSR: BROWSER_NAME,
      },
    });
    const pake = parsePake(reply);
    if (pake.TID !== session.username) throw new ProtocolError("challenge for another session");
    if (pake.ErrCode !== undefined) throw new ProtocolError(`server hello error ${pake.ErrCode}`);
    if (String(pake.MSG) !== String(MSGType.ServerKeyExchange)) throw new ProtocolError("unexpected server message");
    if (pake.PROTO !== SecretSessionVersion.SRPWithRFCVerification) throw new ProtocolError("unsupported protocol");

    session.setChallenge(session.deserialize(pake.B), session.deserialize(pake.s));
    this.challengeAt = this.now();
    return true;
  }

  /** Verifies the code the Mac shows. A code only matches the challenge it was shown for. */
  async verifyPin(pin: string): Promise<void> {
    this.requireSession();
    if (!this.hasChallenge) {
      await this.requestChallenge();
      throw new ProtocolError("Enter the new code your Mac is showing now", "challenge_reissued");
    }
    const gen = this.challengeGen;
    return this.withLock(async () => {
      if (gen !== this.challengeGen) {
        throw new ProtocolError("Enter the new code your Mac is showing now", "challenge_reissued");
      }
      const session = this.requireSession();
      try {
        const m = await session.computeProof(pin);
        const reply = await this.send(Command.HANDSHAKE, {
          msg: {
            QID: "m2",
            PAKE: jsonToBase64({ TID: session.username, MSG: MSGType.ClientVerification, M: session.serialize(m, false) }),
          },
        });
        const pake = parsePake(reply);
        if (pake.TID !== session.username) throw new ProtocolError("verification for another session");
        if (String(pake.MSG) !== String(MSGType.ServerVerification)) throw new ProtocolError("unexpected server message");
        if (pake.ErrCode === 1) throw new ProtocolError("Incorrect code", "incorrect_code");
        if (pake.ErrCode !== undefined && pake.ErrCode !== 0) throw new ProtocolError(`verification error ${pake.ErrCode}`);
        const hamk = await session.expectedServerProof(m);
        if (typeof pake.HAMK !== "string" || !constantTimeEqual(session.deserialize(pake.HAMK), hamk)) {
          throw new ProtocolError("server proof mismatch");
        }
        this.setState("unlocked");
      } catch (e) {
        // the helper burns the challenge on a failed verify; the next attempt needs a fresh one
        session.reset();
        this.challengeAt = 0;
        throw e;
      }
    });
  }

  get ready(): boolean {
    return this.state === "unlocked" && this.port !== undefined && this.session?.isKeyed === true;
  }

  private requireSession(): SRPSession {
    if (!this.session) throw new ProtocolError("not connected");
    return this.session;
  }

  private async query(cmd: number, tabId: number, hostname: string, body: object, timeoutMs: number | null) {
    const session = this.requireSession();
    const sdata = session.serialize(await session.encrypt(body));
    const reply = await this.send(
      cmd,
      {
        tabId,
        frameId: 0,
        url: hostname,
        payload: { QID: QueryId[cmd], SMSG: JSON.stringify({ TID: session.username, SDATA: sdata }) },
      },
      timeoutMs,
    );
    let smsg = reply.payload?.SMSG;
    if (typeof smsg === "string") smsg = JSON.parse(smsg);
    if (smsg?.TID !== session.username) throw new ProtocolError("response for another session");
    const res = JSON.parse(bytesToUtf8(await session.decrypt(session.deserialize(smsg.SDATA))));
    if (res.STATUS === QueryStatus.Success || res.STATUS === QueryStatus.NoResults) return res;
    throw new ProtocolError(STATUS_TEXT[res.STATUS] ?? `query error: status ${res.STATUS}`);
  }

  /** Login names saved for `hostname`. Passwords are not included. */
  async getLoginNames(tabId: number, hostname: string): Promise<Login[]> {
    if (!this.ready) throw new ProtocolError("not unlocked");
    return this.withLock(async () => {
      const res = await this.query(
        Command.GET_LOGIN_NAMES_FOR_URL,
        tabId,
        hostname,
        { ACT: Action.GHOST_SEARCH, URL: hostname },
        5000,
      );
      return (res.Entries ?? []).map((e: any) => ({ username: String(e.USR ?? ""), sites: e.sites ?? [] }));
    });
  }

  /**
   * The password for one login on `hostname`. Callers must pass the hostname of the frame being
   * filled, never a login's `sites`, which a page could point at another origin.
   */
  async getPassword(tabId: number, hostname: string, username: string): Promise<Credential | undefined> {
    if (!this.ready) throw new ProtocolError("not unlocked");
    return this.withLock(async () => {
      const res = await this.query(
        Command.GET_PASSWORD_FOR_LOGIN_NAME,
        tabId,
        hostname,
        { ACT: Action.SEARCH, URL: hostname, USR: username },
        null, // no timeout: the helper may be waiting on Touch ID
      );
      const e = res.Entries?.[0];
      if (!e) return undefined;
      return { username: String(e.USR ?? ""), password: String(e.PWD ?? ""), sites: e.sites ?? [] };
    });
  }

  disconnect(): void {
    const port = this.port;
    if (!port) return;
    try {
      port.postMessage({ cmd: Command.END });
    } catch {}
    try {
      port.disconnect();
    } catch {}
    this.dropConnection("closed");
  }
}

function jsonToBase64(obj: unknown): string {
  return bytesToBase64(utf8ToBytes(JSON.stringify(obj)));
}

function parsePake(reply: HelperMessage): any {
  const pake = reply.payload?.PAKE;
  if (typeof pake !== "string") throw new ProtocolError("malformed handshake reply");
  return JSON.parse(bytesToUtf8(base64ToBytes(pake)));
}
