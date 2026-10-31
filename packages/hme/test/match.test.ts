import { describe, expect, it } from "vitest";
import { addressesForSite, type HmeEmail } from "../src/index.ts";

const alias = (fields: Partial<HmeEmail>): HmeEmail =>
  ({ origin: "ON_DEMAND", domain: "", hme: "a@icloud.com", isActive: true, label: "", note: "", createTimestamp: 1, recipientMailId: "", ...fields }) as HmeEmail;

describe("addressesForSite", () => {
  it.each([
    ["example.com", "example.com"],
    ["example.com", "www.example.com"],
    ["www.example.com", "example.com"],
    ["m.example.com", "www.example.com"],
    ["EXAMPLE.com", "example.com"],
    ["  example.com  ", "example.com"],
    ["example.com.", "example.com"],
    ["https://example.com/signup?x=1", "example.com"],
    ["example.com:8443", "example.com"],
    ["accounts.example.com", "accounts.example.com"],
    ["bücher.de", "xn--bcher-kva.de"],
  ])("matches the label %s on %s", (label, host) => {
    expect(addressesForSite([alias({ label })], host)).toEqual(["a@icloud.com"]);
  });

  it.each([
    ["example.com", "evil-example.com"],
    ["example.com", "example.com.evil.net"],
    ["example.com", "notexample.com"],
    ["example.com", "evil.example.com"],
    ["github.io", "evil.github.io"],
    ["alice.github.io", "bob.github.io"],
    ["co.uk", "shop.co.uk"],
    ["accounts.example.com", "login.example.com"],
    ["evil.com@example.com", "example.com"],
    ["example.com@evil.com", "example.com"],
    ["Netflix", "netflix.com"],
    ["my netflix.com", "netflix.com"],
    ["com", "com"],
    ["localhost", "localhost"],
    ["1.1.1.1", "1.1.1.1"],
    ["", "example.com"],
  ])("does not match the label %s on %s", (label, host) => {
    expect(addressesForSite([alias({ label })], host)).toEqual([]);
  });

  it("matches on the domain field when the label is free text", () => {
    expect(addressesForSite([alias({ label: "Shopping", domain: "example.com" })], "www.example.com")).toEqual(["a@icloud.com"]);
    expect(addressesForSite([alias({ label: "example.com", domain: "evil.net" })], "evil.net")).toEqual(["a@icloud.com"]);
  });

  it("skips an address that is switched off", () => {
    expect(addressesForSite([alias({ label: "example.com", isActive: false })], "example.com")).toEqual([]);
  });

  it("lists the newest first and no more than three", () => {
    const list = [1, 2, 3, 4].map((n) => alias({ label: "example.com", hme: `${n}@icloud.com`, createTimestamp: n }));
    expect(addressesForSite(list, "example.com")).toEqual(["4@icloud.com", "3@icloud.com", "2@icloud.com"]);
  });

  it("ignores entries iCloud sent in an unexpected shape", () => {
    const odd = [null, {}, { hme: 5, isActive: true, label: "example.com" }, { hme: "b@icloud.com", isActive: "yes", label: "example.com" }, { hme: "c@icloud.com", isActive: true, label: 7, domain: null }];
    expect(addressesForSite(odd as unknown as HmeEmail[], "example.com")).toEqual([]);
  });
});
