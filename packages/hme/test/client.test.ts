import { describe, expect, it } from "vitest";
import { HmeClient, HmeError, dnrRules, type HmeFetch } from "../src/index.ts";

const PMS = "https://p99-maildomainws.icloud.com";
const ok = (b: unknown, status = 200) => ({ ok: status < 300, status, json: async () => b });

function fake(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f: HmeFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const key = `${init.method} ${url}`;
    if (!(key in routes)) return ok({}, 404);
    return ok(routes[key], status);
  };
  return { f, calls };
}

const validate = {
  "POST https://setup.icloud.com/setup/ws/1/validate": {
    webservices: { premiummailsettings: { url: PMS, status: "active" } },
  },
};
const env = (result: unknown) => ({ success: true, result });
const fail = { success: false, error: { errorMessage: "nope" } };

describe("session", () => {
  it("bootstraps the service url", async () => {
    const { f } = fake(validate);
    expect(await new HmeClient({ fetch: f }).session()).toEqual({ available: true });
  });
  it("not signed in on 401", async () => {
    const f: HmeFetch = async () => ok({}, 401);
    expect(await new HmeClient({ fetch: f }).session()).toEqual({
      available: false,
      reason: "not-signed-in",
    });
  });
  it("not signed in when webservices missing", async () => {
    const { f } = fake({ "POST https://setup.icloud.com/setup/ws/1/validate": {} });
    expect((await new HmeClient({ fetch: f }).session()).reason).toBe("not-signed-in");
  });
  it("no iCloud+ when premiummailsettings missing", async () => {
    const { f } = fake({
      "POST https://setup.icloud.com/setup/ws/1/validate": { webservices: {} },
    });
    expect((await new HmeClient({ fetch: f }).session()).reason).toBe("no-icloud-plus");
  });
  it("rate-limited on 429", async () => {
    const f: HmeFetch = async () => ok({}, 429);
    expect((await new HmeClient({ fetch: f }).session()).reason).toBe("rate-limited");
  });
  it("bootstraps once", async () => {
    const { f, calls } = fake({ ...validate, [`GET ${PMS}/v2/hme/list`]: env({ hmeEmails: [], forwardToEmails: [], selectedForwardTo: "a" }) });
    const c = new HmeClient({ fetch: f });
    await c.session();
    await c.list();
    await c.list();
    expect(calls.filter((x) => x.url.endsWith("/validate"))).toHaveLength(1);
  });
});

describe("operations", () => {
  const hme = { anonymousId: "id1", hme: "a@icloud.com", isActive: true };
  const { f, calls } = fake({
    ...validate,
    [`GET ${PMS}/v2/hme/list`]: env({ hmeEmails: [hme], forwardToEmails: ["x"], selectedForwardTo: "x" }),
    [`POST ${PMS}/v1/hme/generate`]: env({ hme: "cand@icloud.com" }),
    [`POST ${PMS}/v1/hme/reserve`]: env({ hme }),
    [`POST ${PMS}/v1/hme/updateMetaData`]: env({}),
    [`POST ${PMS}/v1/hme/deactivate`]: env({}),
    [`POST ${PMS}/v1/hme/reactivate`]: env({}),
    [`POST ${PMS}/v1/hme/delete`]: env({}),
  });
  const c = new HmeClient({ fetch: f });

  it("list", async () => {
    expect((await c.list()).hmeEmails[0]?.anonymousId).toBe("id1");
  });
  it("generate", async () => {
    expect(await c.generate()).toBe("cand@icloud.com");
  });
  it("reserve", async () => {
    expect((await c.reserve("cand@icloud.com", "L", "N")).anonymousId).toBe("id1");
    const last = calls.find((x) => x.url.endsWith("/reserve"));
    expect(JSON.parse(last!.body!)).toEqual({ hme: "cand@icloud.com", label: "L", note: "N" });
  });
  it("metadata, deactivate, reactivate, remove", async () => {
    await c.updateMetadata("id1", "L2");
    await c.deactivate("id1");
    await c.reactivate("id1");
    await c.remove("id1");
    for (const op of ["updateMetaData", "deactivate", "reactivate", "delete"]) {
      const call = calls.find((x) => x.url.endsWith(`/${op}`));
      expect(JSON.parse(call!.body!).anonymousId).toBe("id1");
    }
  });
});

describe("errors", () => {
  it("success:false maps to api-error with message", async () => {
    const { f } = fake({ ...validate, [`POST ${PMS}/v1/hme/generate`]: fail });
    await expect(new HmeClient({ fetch: f }).generate()).rejects.toMatchObject({
      code: "api-error",
      message: "nope",
    });
  });
  it("bad shapes", async () => {
    const { f } = fake({
      ...validate,
      [`POST ${PMS}/v1/hme/generate`]: env({}),
      [`GET ${PMS}/v2/hme/list`]: env({ hmeEmails: 1 }),
      [`POST ${PMS}/v1/hme/reserve`]: env({}),
      [`POST ${PMS}/v1/hme/delete`]: "junk",
    });
    const c = new HmeClient({ fetch: f });
    for (const p of [c.generate(), c.list(), c.reserve("a", "b"), c.remove("x")]) {
      await expect(p).rejects.toMatchObject({ code: "unexpected-shape" });
    }
  });
  it("429 on an operation", async () => {
    let n = 0;
    const f: HmeFetch = async (url) =>
      url.endsWith("/validate") ? ok(validate["POST https://setup.icloud.com/setup/ws/1/validate"]) : (n++, ok({}, 429));
    await expect(new HmeClient({ fetch: f }).generate()).rejects.toBeInstanceOf(HmeError);
    expect(n).toBe(1);
  });
  it("401 on an operation re-bootstraps next time", async () => {
    let validates = 0;
    const f: HmeFetch = async (url) => {
      if (url.endsWith("/validate")) {
        validates++;
        return ok(validate["POST https://setup.icloud.com/setup/ws/1/validate"]);
      }
      return ok({}, 401);
    };
    const c = new HmeClient({ fetch: f });
    await expect(c.generate()).rejects.toMatchObject({ code: "not-signed-in" });
    await expect(c.generate()).rejects.toMatchObject({ code: "not-signed-in" });
    expect(validates).toBe(2);
  });
});

describe("dnrRules", () => {
  it("rewrites Origin/Referer for both regions", () => {
    const r = dnrRules("abcdef");
    expect(r.map((x) => x.id)).toEqual([1, 2]);
    expect(r[0]!.action.requestHeaders).toEqual([
      { header: "Origin", operation: "set", value: "https://www.icloud.com" },
      { header: "Referer", operation: "set", value: "https://www.icloud.com/" },
    ]);
    expect(r[1]!.condition.urlFilter).toBe("|https://*.icloud.com.cn/*");
  });

  it("never applies to web pages, only the extension's tabless requests", () => {
    for (const rule of dnrRules("abcdef")) {
      expect(rule.condition).toMatchObject({ initiatorDomains: ["abcdef"], tabIds: [-1] });
      expect(rule.condition).not.toHaveProperty("excludedInitiatorDomains");
    }
    expect(() => dnrRules("")).toThrow();
  });
});

describe("bootstrap", () => {
  it("refuses a service URL off iCloud, since cookies would follow it", async () => {
    for (const url of ["https://evil.example/hme", "http://p99-maildomainws.icloud.com", "https://icloud.com.evil.example"]) {
      const fetch: HmeFetch = async () => ({ ok: true, status: 200, json: async () => ({ webservices: { premiummailsettings: { url } } }) });
      await expect(new HmeClient({ fetch }).list()).rejects.toMatchObject({ code: "unexpected-shape" });
    }
  });
});
