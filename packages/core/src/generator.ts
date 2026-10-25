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
