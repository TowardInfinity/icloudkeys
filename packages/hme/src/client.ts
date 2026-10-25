import { HmeError } from "./errors.ts";

export const SETUP_URL = "https://setup.icloud.com/setup/ws/1";

export interface HmeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type HmeFetch = (
  url: string,
  init: { method: "GET" | "POST"; body?: string },
) => Promise<HmeResponse>;

export interface HmeEmail {
  origin: string;
  anonymousId: string;
  domain: string;
  forwardToEmail: string;
  hme: string;
  isActive: boolean;
  label: string;
  note: string;
  createTimestamp: number;
  recipientMailId: string;
}

export interface HmeList {
  hmeEmails: HmeEmail[];
  selectedForwardTo: string;
  forwardToEmails: string[];
}

export interface HmeSession {
  available: boolean;
  reason?: "not-signed-in" | "no-icloud-plus" | "rate-limited";
}

export interface HmeClientOptions {
  fetch: HmeFetch;
  setupUrl?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function isICloudUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)icloud\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false;
  }
}

const shape = (what: string) =>
  new HmeError("unexpected-shape", `Unexpected response shape: ${what}`);

export class HmeClient {
  readonly #fetch: HmeFetch;
  readonly #setupUrl: string;
  #serviceUrl: string | undefined;

  constructor(opts: HmeClientOptions) {
    this.#fetch = opts.fetch;
    this.#setupUrl = opts.setupUrl ?? SETUP_URL;
  }

  async session(): Promise<HmeSession> {
    try {
      await this.#bootstrap();
      return { available: true };
    } catch (e) {
      if (
        e instanceof HmeError &&
        (e.code === "not-signed-in" ||
          e.code === "no-icloud-plus" ||
          e.code === "rate-limited")
      ) {
        return { available: false, reason: e.code };
      }
      throw e;
    }
  }

  async list(): Promise<HmeList> {
    const r = await this.#call("GET", "v2", "list");
    if (
      !isObject(r) ||
      !Array.isArray(r.hmeEmails) ||
      !Array.isArray(r.forwardToEmails) ||
      typeof r.selectedForwardTo !== "string"
    ) {
      throw shape("list");
    }
    return r as unknown as HmeList;
  }

  async generate(): Promise<string> {
    const r = await this.#call("POST", "v1", "generate");
    if (!isObject(r) || typeof r.hme !== "string") throw shape("generate");
    return r.hme;
  }

  async reserve(address: string, label: string, note = ""): Promise<HmeEmail> {
    const r = await this.#call("POST", "v1", "reserve", { hme: address, label, note });
    if (!isObject(r) || !isObject(r.hme) || typeof r.hme.anonymousId !== "string") {
      throw shape("reserve");
    }
    return r.hme as unknown as HmeEmail;
  }

  async updateMetadata(id: string, label: string, note?: string): Promise<void> {
    await this.#call("POST", "v1", "updateMetaData", { anonymousId: id, label, note });
  }

  async deactivate(id: string): Promise<void> {
    await this.#call("POST", "v1", "deactivate", { anonymousId: id });
  }

  async reactivate(id: string): Promise<void> {
    await this.#call("POST", "v1", "reactivate", { anonymousId: id });
  }

  async remove(id: string): Promise<void> {
    await this.#call("POST", "v1", "delete", { anonymousId: id });
  }

  async #send(method: "GET" | "POST", url: string, data?: object) {
    const res = await this.#fetch(url, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (res.status === 429) {
      throw new HmeError("rate-limited", "iCloud rate-limited the request");
    }
    if (res.status === 401 || res.status === 421) {
      this.#serviceUrl = undefined;
      throw new HmeError("not-signed-in", "Not signed in to iCloud.com");
    }
    if (!res.ok) {
      throw new HmeError("api-error", `Request failed with status ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw shape("not JSON");
    }
  }

  async #bootstrap(): Promise<string> {
    if (this.#serviceUrl) return this.#serviceUrl;
    const body = await this.#send("POST", `${this.#setupUrl}/validate`);
    if (!isObject(body)) throw shape("validate");
    const ws = body.webservices;
    if (!isObject(ws)) {
      throw new HmeError("not-signed-in", "Not signed in to iCloud.com");
    }
    const pms = ws.premiummailsettings;
    if (!isObject(pms) || typeof pms.url !== "string") {
      throw new HmeError("no-icloud-plus", "Hide My Email needs iCloud+");
    }
    // the session cookies follow this URL, so it must stay on iCloud
    if (!isICloudUrl(pms.url)) throw shape("premiummailsettings url");
    this.#serviceUrl = pms.url;
    return pms.url;
  }

  async #call(
    method: "GET" | "POST",
    version: "v1" | "v2",
    op: string,
    data?: object,
  ): Promise<unknown> {
    const base = await this.#bootstrap();
    const body = await this.#send(method, `${base}/${version}/hme/${op}`, data);
    if (!isObject(body) || typeof body.success !== "boolean") throw shape(op);
    if (!body.success) {
      const msg =
        isObject(body.error) && typeof body.error.errorMessage === "string"
          ? body.error.errorMessage
          : `${op} failed`;
      throw new HmeError("api-error", msg);
    }
    return body.result;
  }
}
