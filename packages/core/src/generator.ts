// Apple-style strong passwords. Format per Apple's documented Strong Password: three six-letter
// consonant-vowel syllables joined by hyphens, with one uppercase letter and one digit.

const CONSONANTS = "bcdfghjkmnpqrstvwxz"; // no "l", too close to "1" and "I"
const VOWELS = "aeiouy";

/** Uniform in [0, n): rejection sampling, since `% n` alone favours small values. */
function randomBelow(n: number, random = (b: Uint32Array<ArrayBuffer>) => crypto.getRandomValues(b)): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    const v = random(buf)[0]!;
    if (v < limit) return v % n;
  }
}

const pick = (set: string) => set[randomBelow(set.length)]!;

/** e.g. "ruvwy1-gozfob-mudXep": 20 characters, about 71 bits. */
export function strongPassword(): string {
  const groups = Array.from({ length: 3 }, () => [CONSONANTS, VOWELS, CONSONANTS, CONSONANTS, VOWELS, CONSONANTS].map(pick));
  // the digit sits next to a hyphen or at the end, as in Apple's output
  const slots = [[0, 5], [1, 0], [1, 5], [2, 0], [2, 5]] as const;
  const [dg, dp] = slots[randomBelow(slots.length)]!;
  groups[dg]![dp] = String(randomBelow(10));
  let ug: number, up: number;
  do {
    ug = randomBelow(3);
    up = randomBelow(6);
  } while (ug === dg && up === dp);
  groups[ug]![up] = groups[ug]![up]!.toUpperCase();
  return groups.map((g) => g.join("")).join("-");
}

/** For sites that reject symbols: 15 letters and digits with at least one of each class. */
export function alphanumericPassword(length = 15): string {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = lower.toUpperCase();
  const digits = "0123456789";
  const chars = [pick(lower), pick(upper), pick(digits)];
  while (chars.length < length) chars.push(pick(lower + upper + digits));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// passwordrules (https://developer.apple.com/password-rules/): sites state what they accept, and a
// generated password that ignores it is rejected at signup.

export type CharClass = "upper" | "lower" | "digit" | "special" | "ascii-printable" | { chars: string };

/** min/maxLength come from the input's attributes; -1 or 0 means unset. */
export interface FieldRules {
  passwordrules?: string | null;
  minLength?: number;
  maxLength?: number;
}

export interface ParsedRules {
  required: CharClass[][];
  allowed: CharClass[];
  maxConsecutive?: number;
  minLength?: number;
  maxLength?: number;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = UPPER.toLowerCase();
const DIGITS = "0123456789";
const SPECIAL = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?] "; // Apple's list, space included
const AMBIGUOUS = "lIO0o";

const NAMED: Record<string, CharClass> = {
  upper: "upper",
  lower: "lower",
  digit: "digit",
  special: "special",
  "ascii-printable": "ascii-printable",
  unicode: "ascii-printable", // nothing past ASCII is generated
};

/** `[` ... `]`; Apple allows `-` only first and `]` only last (`[-abc]]`), so a stray `-` is dropped. */
function readCustom(t: string, start: number): { chars: string; end: number } {
  let chars = "";
  for (let j = start + 1; j < t.length; j++) {
    const c = t[j]!;
    if (c === "]") {
      if (t[j + 1] === "]" && (j + 2 >= t.length || /[\s,;]/.test(t[j + 2]!))) return { chars: chars + "]", end: j + 2 };
      return { chars, end: j + 1 };
    }
    if (c === "-" && j !== start + 1) continue;
    chars += c;
  }
  return { chars, end: t.length };
}

/** Comma-separated values up to the next `;` outside brackets. */
function readValues(t: string, start: number): { values: (string | { chars: string })[]; end: number } {
  const values: (string | { chars: string })[] = [];
  let word = "";
  let i = start;
  const flush = () => {
    const w = word.trim().toLowerCase();
    if (w) values.push(w);
    word = "";
  };
  while (i < t.length && t[i] !== ";") {
    if (t[i] === "[") {
      flush();
      const r = readCustom(t, i);
      values.push({ chars: r.chars });
      i = r.end;
    } else if (t[i] === ",") {
      flush();
      i++;
    } else word += t[i++];
  }
  flush();
  return { values, end: i };
}

/** Never throws: anything it doesn't understand is skipped. */
export function parsePasswordRules(text: string): ParsedRules {
  const rules: ParsedRules = { required: [], allowed: [] };
  const toClasses = (values: (string | { chars: string })[]): CharClass[] =>
    values.flatMap((v): CharClass[] => {
      if (typeof v !== "string") return v.chars ? [{ chars: v.chars }] : [];
      const named = NAMED[v];
      return named ? [named] : [];
    });
  const num = (values: (string | { chars: string })[]) => {
    const v = values.find((x): x is string => typeof x === "string" && /^\d+$/.test(x));
    return v === undefined ? undefined : parseInt(v, 10);
  };

  const t = text ?? "";
  let i = 0;
  while (i < t.length) {
    while (i < t.length && /[\s;]/.test(t[i]!)) i++;
    let name = "";
    while (i < t.length && t[i] !== ":" && t[i] !== ";") name += t[i++];
    if (t[i] !== ":") continue; // no value: garbage
    const { values, end } = readValues(t, i + 1);
    i = end;
    switch (name.trim().toLowerCase()) {
      case "required": {
        const classes = toClasses(values);
        if (classes.length) {
          rules.required.push(classes);
          rules.allowed.push(...classes);
        }
        break;
      }
      case "allowed":
        rules.allowed.push(...toClasses(values));
        break;
      case "max-consecutive": {
        const n = num(values);
        if (n) rules.maxConsecutive = n;
        break;
      }
      case "minlength": {
        const n = num(values);
        if (n !== undefined) rules.minLength = Math.max(rules.minLength ?? 0, n);
        break;
      }
      case "maxlength": {
        const n = num(values);
        if (n) rules.maxLength = Math.min(rules.maxLength ?? Infinity, n);
        break;
      }
    }
  }
  if (!rules.allowed.length) rules.allowed = ["ascii-printable"];
  return rules;
}

function charsOf(c: CharClass): string {
  if (typeof c !== "string") return c.chars;
  switch (c) {
    case "upper": return UPPER;
    case "lower": return LOWER;
    case "digit": return DIGITS;
    case "special": return SPECIAL;
    case "ascii-printable": return UPPER + LOWER + DIGITS + SPECIAL;
  }
}

const unique = (s: string) => Array.from(new Set(s));
const pickOf = <T>(a: readonly T[]): T => a[randomBelow(a.length)]!;

/** Space is never generated; ambiguous characters go too unless that would leave nothing. */
function usable(chars: string[]): string[] {
  const noSpace = chars.filter((c) => c !== " ");
  const clear = noSpace.filter((c) => !AMBIGUOUS.includes(c));
  return clear.length ? clear : noSpace;
}

function bounds(rules: ParsedRules, field: FieldRules): { lo: number; hi: number } {
  const pos = (n?: number) => (n && n > 0 ? n : 0);
  const lo = Math.max(rules.minLength ?? 0, pos(field.minLength));
  const hi = Math.min(rules.maxLength ?? Infinity, pos(field.maxLength) || Infinity);
  return { lo: Math.min(lo, hi), hi }; // contradictory bounds: the maximum wins, it's the hard limit
}

function runsOk(pw: string[], max?: number): boolean {
  if (!max) return true;
  let run = 1;
  for (let i = 1; i < pw.length; i++) {
    run = pw[i] === pw[i - 1] ? run + 1 : 1;
    if (run > max) return false;
  }
  return true;
}

/** Null when 100 random draws all break max-consecutive. */
function generate(groups: string[][], pool: string[], length: number, maxConsecutive?: number): string | null {
  if (!pool.length || groups.some((g) => !g.length)) throw new Error("password rules allow no usable characters");
  if (groups.length > length) throw new Error(`password rules require ${groups.length} character groups but allow only ${length} characters`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const chars = groups.map(pickOf);
    while (chars.length < length) chars.push(pickOf(pool));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomBelow(i + 1);
      [chars[i], chars[j]] = [chars[j]!, chars[i]!];
    }
    if (runsOk(chars, maxConsecutive)) return chars.join("");
  }
  return null;
}

function accepts(pw: string, rules: ParsedRules, lo: number, hi: number): boolean {
  const chars = Array.from(pw);
  const allowed = new Set(rules.allowed.flatMap((c) => unique(charsOf(c))));
  return (
    chars.length >= lo &&
    chars.length <= hi &&
    chars.every((c) => allowed.has(c)) &&
    rules.required.every((g) => chars.some((c) => g.some((k) => charsOf(k).includes(c)))) &&
    runsOk(chars, rules.maxConsecutive)
  );
}

export function strongPasswordFor(field: FieldRules): string {
  const rules = parsePasswordRules(field.passwordrules ?? "");
  const { lo, hi } = bounds(rules, field);
  // Apple's own rule: keep the default format whenever the site accepts it
  for (let i = 0; i < 10; i++) {
    const candidate = strongPassword();
    if (accepts(candidate, rules, lo, hi)) return candidate;
  }
  const groups = rules.required.map((g) => usable(unique(g.map(charsOf).join(""))));
  const pool = usable(unique(rules.allowed.map(charsOf).join("")));
  const length = Math.min(Math.max(20, lo), hi);
  return generate(groups, pool, length, rules.maxConsecutive) ?? strongPassword().slice(0, hi);
}

/** Null when the rules need a symbol or allow no letters or digits, so the caller can fall back. */
export function alphanumericPasswordFor(field: FieldRules): string | null {
  const rules = parsePasswordRules(field.passwordrules ?? "");
  const { lo, hi } = bounds(rules, field);
  const alnum = new Set(UPPER + LOWER + DIGITS);
  const onlyAlnum = (chars: string[]) => chars.filter((c) => alnum.has(c));
  const allowed = unique(rules.allowed.map(charsOf).join(""));
  const pool = usable(onlyAlnum(allowed));
  if (!pool.length) return null;
  const required = rules.required.map((g) => usable(onlyAlnum(unique(g.map(charsOf).join("")))));
  if (required.some((g) => !g.length)) return null;
  // one of each class, wherever the rules permit it
  const classes = [UPPER, LOWER, DIGITS].map((set) => usable(allowed.filter((c) => set.includes(c)))).filter((g) => g.length);
  const length = Math.min(Math.max(15, lo), hi);
  return generate([...required, ...classes], pool, length, rules.maxConsecutive);
}

// symbols that sign-up forms almost all accept: no quotes, brackets, slashes or space
const COMPLEX_SYMBOLS = "!#$%&*+-=?@^_";

/**
 * 20 characters of upper, lower, digits and symbols, at least one of each: about 120 bits, for
 * users who want more than Apple's format. Null when the rules allow no symbol.
 */
export function complexPasswordFor(field: FieldRules): string | null {
  const rules = parsePasswordRules(field.passwordrules ?? "");
  const { lo, hi } = bounds(rules, field);
  const allowed = unique(rules.allowed.map(charsOf).join(""));
  const within = (set: string) => usable(allowed.filter((c) => set.includes(c)));
  // a site listing only its own symbols gets those instead
  const symbols = within(COMPLEX_SYMBOLS).length ? within(COMPLEX_SYMBOLS) : within(SPECIAL);
  if (!symbols.length) return null;
  const pool = [...within(UPPER + LOWER + DIGITS), ...symbols];
  const inPool = (g: string[]) => g.filter((c) => pool.includes(c));
  const required = rules.required.map((g) => {
    const chars = usable(unique(g.map(charsOf).join("")));
    return inPool(chars).length ? inPool(chars) : chars;
  });
  const classes = [UPPER, LOWER, DIGITS].map((set) => inPool(within(set))).filter((g) => g.length);
  const length = Math.min(Math.max(20, lo), hi);
  return generate([...required, ...classes, symbols], [...pool, ...required.flat()], length, rules.maxConsecutive);
}
