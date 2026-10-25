import type { HmeSession } from "@icloudkeys/hme";
import type { Login, State } from "@icloudkeys/core";

/** Popup → background. */
export type UiRequest =
  | { type: "status" }
  | { type: "pair" }
  | { type: "verify"; pin: string }
  | { type: "logins" }
  | { type: "fill"; username: string }
  | { type: "codes" }
  | { type: "fillCode"; id: number }
  | { type: "launch"; mode: "search" | "new" }
  | { type: "hmeStatus" }
  | { type: "hmeCreate" };

/**
 * Content script → background. Nothing answered here carries a password or a code: fills go
 * back down to the asking frame, pinned to its host.
 */
export type ContentRequest =
  | { type: "inlineStatus" }
  | { type: "inlineLogins" }
  | { type: "inlineFill"; username: string }
  | { type: "inlineCodes" }
  | { type: "inlineFillCode"; id: number }
  | { type: "offerSave"; username: string; password: string; isNew: boolean }
  | { type: "openPopup" }
  | { type: "inlineLaunch" }
  /** Shows an address; nothing is created in iCloud until `hmeReserve`. */
  | { type: "hmeGenerate" }
  /** Creates the address last generated for this frame. Takes no address: a page can't name one. */
  | { type: "hmeReserve" };

export type Request = UiRequest | ContentRequest;

export interface Status {
  state: State;
  hasChallenge: boolean;
  canFillCodes: boolean;
  canOpenNewPassword: boolean;
  /** Signed in to iCloud.com with iCloud+, as of the last check. */
  canHideEmail: boolean;
  /** Hide My Email is configured but iCloud.com has no session in this browser. */
  hmeNeedsSignIn: boolean;
}

/** A one-time code as listed: the value stays in the background until it's filled. */
export interface CodeRow {
  id: number;
  source: string;
  username: string;
  domain: string;
}

export type Response =
  | {
      ok: true;
      status: Status;
      host?: string;
      logins?: Login[];
      codes?: CodeRow[];
      requiresAuth?: boolean;
      /** A code the popup shows when no field on the page took it. */
      code?: string;
      hme?: HmeSession;
      address?: string;
    }
  | { ok: false; status: Status; error: string; code?: string };

/** Background → content script, sent only to the frame that asked, or the top frame. */
export type ToContent =
  | { type: "fill"; expectedHost: string; username: string; password: string }
  | { type: "fillCode"; expectedHost: string; code: string };

export interface FillResult {
  filled: boolean;
  error?: string;
}
