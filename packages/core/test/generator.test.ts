import { describe, expect, it } from "vitest";
import {
  alphanumericPassword,
  alphanumericPasswordFor,
  complexPasswordFor,
  parsePasswordRules,
  strongPassword,
  strongPasswordFor,
  type ParsedRules,
} from "../src/generator.ts";

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

describe("parsePasswordRules", () => {
  it("parses a typical rule set", () => {
    const r = parsePasswordRules(`required: upper; required: lower; required: digit; allowed: [-().&@?'#,/"+]; max-consecutive: 2; minlength: 8; maxlength: 12`);
    expect(r.required).toEqual([["upper"], ["lower"], ["digit"]]);
    expect(r.allowed).toEqual(["upper", "lower", "digit", { chars: `-().&@?'#,/"+` }]);
    expect(r).toMatchObject({ maxConsecutive: 2, minLength: 8, maxLength: 12 });
  });

  it("defaults to ascii-printable for empty and garbage input", () => {
    for (const text of ["", "   ", "blah", ";;;", "required", "required:", ": upper", "foo: bar; ]]]: [", "required: nonsense"]) {
      expect(parsePasswordRules(text)).toEqual({ required: [], allowed: ["ascii-printable"] });
    }
  });

  it("ignores case in names and classes", () => {
    const r = parsePasswordRules("REQUIRED: UPPER, Digit; MinLength: 9; MAXLENGTH: 30; Max-Consecutive: 1");
    expect(r.required).toEqual([["upper", "digit"]]);
    expect(r).toMatchObject({ maxConsecutive: 1, minLength: 9, maxLength: 30 });
  });

  it("keeps the max of minlengths and the min of maxlengths", () => {
    const r = parsePasswordRules("minlength: 6; minlength: 10; minlength: 8; maxlength: 40; maxlength: 16; maxlength: 20");
    expect(r).toMatchObject({ minLength: 10, maxLength: 16 });
  });

  it("reads - first and ] last in custom classes", () => {
    expect(parsePasswordRules("allowed: [-abc]]").allowed).toEqual([{ chars: "-abc]" }]);
    expect(parsePasswordRules("allowed: [abc]]; minlength: 8").allowed).toEqual([{ chars: "abc]" }]);
    expect(parsePasswordRules("allowed: [a-z]").allowed).toEqual([{ chars: "az" }]);
    expect(parsePasswordRules("allowed: [;,]; required: [x]").allowed).toEqual([{ chars: ";," }, { chars: "x" }]);
  });

  it("treats unicode as ascii-printable", () => {
    expect(parsePasswordRules("allowed: unicode").allowed).toEqual(["ascii-printable"]);
  });
});

interface Check {
  rules: string;
  min?: number;
  max?: number;
}

function assertHolds(pw: string, parsed: ParsedRules, lo: number, hi: number) {
  expect(pw.length).toBeGreaterThanOrEqual(lo);
  expect(pw.length).toBeLessThanOrEqual(hi);
  expect(pw).not.toContain(" ");
  const allowed = parsed.allowed.flatMap((c) => Array.from(typeof c === "string" ? ALL[c]! : c.chars));
  for (const ch of pw) expect(allowed).toContain(ch);
  for (const group of parsed.required) {
    const set = group.flatMap((c) => Array.from(typeof c === "string" ? ALL[c]! : c.chars));
    expect(Array.from(pw).some((ch) => set.includes(ch))).toBe(true);
  }
  if (parsed.maxConsecutive) expect(pw).not.toMatch(new RegExp(`(.)\\1{${parsed.maxConsecutive},}`));
}

const ALL: Record<string, string> = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digit: "0123456789",
  special: "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?]",
  "ascii-printable": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~!@#$%^&*_+=`|(){}[:;\"'<>,.?]",
};

describe("strongPasswordFor", () => {
  it("returns the Apple format with no rules", () => {
    for (let i = 0; i < 100; i++) {
      expect(strongPasswordFor({})).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
      expect(strongPasswordFor({ passwordrules: "", minLength: -1, maxLength: -1 })).toMatch(/^[a-zA-Z0-9]{6}-/);
    }
  });

  it("keeps the Apple format when the rules accept it", () => {
    expect(strongPasswordFor({ passwordrules: "minlength: 8; maxlength: 64" })).toMatch(/^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/);
  });

  it("honours maxLength from the attribute", () => {
    for (let i = 0; i < 500; i++) {
      const pw = strongPasswordFor({ maxLength: 16 });
      expect(pw.length).toBeLessThanOrEqual(16);
    }
  });

  const sets: Check[] = [
    { rules: `required: upper; required: lower; required: digit; allowed: [-().&@?'#,/"+]; max-consecutive: 2; minlength: 8; maxlength: 12` },
    { rules: "required: digit; allowed: lower; maxlength: 6" },
    { rules: "required: upper, lower; required: digit; required: special; minlength: 10; max-consecutive: 1" },
    { rules: "allowed: upper, lower, digit; minlength: 12", max: 16 },
    { rules: "required: [!@#]; allowed: digit; max-consecutive: 1; maxlength: 8" },
    { rules: "", max: 16 },
    { rules: "minlength: 24; allowed: ascii-printable", min: 30 },
  ];
  for (const s of sets) {
    it(`satisfies "${s.rules}" (max ${s.max ?? "-"}, min ${s.min ?? "-"})`, () => {
      const parsed = parsePasswordRules(s.rules);
      const lo = Math.max(parsed.minLength ?? 0, s.min ?? 0);
      const hi = Math.min(parsed.maxLength ?? Infinity, s.max ?? Infinity);
      for (let i = 0; i < 500; i++) {
        assertHolds(strongPasswordFor({ passwordrules: s.rules, minLength: s.min, maxLength: s.max }), parsed, lo, hi);
      }
    });
  }

  it("avoids ambiguous characters when it can", () => {
    for (let i = 0; i < 200; i++) {
      expect(strongPasswordFor({ passwordrules: "required: upper; required: lower; required: digit; max-consecutive: 2; maxlength: 12" })).not.toMatch(/[lIO0o]/);
    }
  });

  it("uses ambiguous characters when a required group has nothing else", () => {
    for (let i = 0; i < 50; i++) expect(strongPasswordFor({ passwordrules: "required: [0]; allowed: lower; maxlength: 6" })).toContain("0");
  });

  it("throws on impossible rules", () => {
    expect(() => strongPasswordFor({ passwordrules: "required: upper; required: lower; required: digit; maxlength: 2" })).toThrow(/groups/);
    expect(() => strongPasswordFor({ passwordrules: "required: upper; required: digit", maxLength: 1 })).toThrow();
    expect(() => strongPasswordFor({ passwordrules: "allowed: [ ]" })).toThrow(/usable/);
  });

  it("falls back to a truncated Apple password when max-consecutive can't be met", () => {
    const pw = strongPasswordFor({ passwordrules: "allowed: [a]; max-consecutive: 1; maxlength: 10" });
    expect(pw.length).toBeLessThanOrEqual(10);
  });
});

describe("alphanumericPasswordFor", () => {
  it("returns null when a special character is required or no letters or digits are allowed", () => {
    expect(alphanumericPasswordFor({ passwordrules: "required: special" })).toBeNull();
    expect(alphanumericPasswordFor({ passwordrules: "required: upper; required: [!@]" })).toBeNull();
    expect(alphanumericPasswordFor({ passwordrules: "allowed: special" })).toBeNull();
  });

  it("makes alphanumeric passwords with every allowed class", () => {
    for (let i = 0; i < 200; i++) expect(alphanumericPasswordFor({})).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9]{15}$/);
  });

  it("honours maxLength and the rules", () => {
    for (let i = 0; i < 300; i++) {
      expect(alphanumericPasswordFor({ maxLength: 10 })!.length).toBe(10);
      const pw = alphanumericPasswordFor({ passwordrules: "allowed: lower, digit; max-consecutive: 2; maxlength: 9" })!;
      expect(pw).toMatch(/^(?=.*[a-z])(?=.*\d)[a-z0-9]{9}$/);
      expect(pw).not.toMatch(/(.)\1\1/);
    }
  });
});

describe("complexPasswordFor", () => {
  const COMPLEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!#$%&*+\-=?@^_])[a-zA-Z0-9!#$%&*+\-=?@^_]{20}$/;

  it("makes 20 characters with every class, and no look-alikes", () => {
    for (let i = 0; i < 500; i++) {
      const pw = complexPasswordFor({})!;
      expect(pw).toMatch(COMPLEX);
      expect(pw).not.toMatch(/[lIO0o]/);
    }
  });

  it("shrinks to maxLength and keeps to the site's own symbols", () => {
    for (let i = 0; i < 300; i++) {
      expect(complexPasswordFor({ maxLength: 12 })!).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!#$%&*+\-=?@^_]).{12}$/);
      const pw = complexPasswordFor({ passwordrules: "required: upper; required: lower; required: digit; allowed: [.~]; max-consecutive: 2" })!;
      expect(pw).toMatch(/^(?=.*[.~])[a-zA-Z0-9.~]{20}$/);
      expect(pw).not.toMatch(/(.)\1\1/);
    }
  });

  it("returns null when the rules allow no symbol", () => {
    expect(complexPasswordFor({ passwordrules: "allowed: upper, lower, digit" })).toBeNull();
  });
});
