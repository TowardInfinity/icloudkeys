export type HmeErrorCode =
  | "not-signed-in"
  | "no-icloud-plus"
  | "rate-limited"
  | "unexpected-shape"
  | "api-error";

export class HmeError extends Error {
  readonly code: HmeErrorCode;
  constructor(code: HmeErrorCode, message: string) {
    super(message);
    this.name = "HmeError";
    this.code = code;
  }
}
