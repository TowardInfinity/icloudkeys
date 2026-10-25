import { describe, expect, it } from "vitest";
import { alphanumericPassword, strongPassword } from "../src/generator.ts";

describe("generator", () => {
  it("makes Apple-format strong passwords", () => {
    for (let i = 0; i < 500; i++) {
      const pw = strongPassword();
      expect(pw).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
      expect(pw.replace(/[^A-Z]/g, "")).toHaveLength(1);
      expect(pw.replace(/[^0-9]/g, "")).toHaveLength(1);
      expect(pw).not.toMatch(/l/i);
    }
  });

  it("makes alphanumeric passwords with every class", () => {
    for (let i = 0; i < 500; i++) {
      const pw = alphanumericPassword();
      expect(pw).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9]{15}$/);
    }
  });

  it("doesn't repeat", () => {
    expect(new Set(Array.from({ length: 200 }, strongPassword)).size).toBe(200);
  });
});
