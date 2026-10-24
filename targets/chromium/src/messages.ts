import type { Login, State } from "@icloudkeys/core";

/** Popup → background. */
export type Request =
  | { type: "status" }
  | { type: "pair" }
  | { type: "verify"; pin: string }
  | { type: "logins" }
  | { type: "fill"; username: string };

export interface Status {
  state: State;
  hasChallenge: boolean;
}

export type Response =
  | { ok: true; status: Status; logins?: Login[]; host?: string }
  | { ok: false; status: Status; error: string; code?: string };

/** Background → content script, top frame only. */
export interface FillMessage {
  type: "fill";
  expectedHost: string;
  username: string;
  password: string;
}
