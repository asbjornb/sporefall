// Crockford base32: 0-9 + A-Z minus I, L, O, U (visually ambiguous / profane).
// Gives ~5 bits per char; 6 chars = 30 bits ≈ 1B combos. Plenty for friend-sharing.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Normalize a user-pasted code: upper-case, drop non-alphabet chars, and
 * forgive common visual substitutions (I→1, L→1, O→0, U→V). Keeps the code
 * case-insensitive on entry without needing a separate input component.
 */
export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V")
    .split("")
    .filter((c) => ALPHABET.includes(c))
    .join("");
}

export function isValidRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && /^[0-9A-Z]+$/.test(code);
}

export function parseRoomFromUrl(href = window.location.href): string | null {
  const url = new URL(href);
  const raw = url.searchParams.get("r");
  if (!raw) return null;
  const code = normalizeRoomCode(raw);
  return isValidRoomCode(code) ? code : null;
}

export function roomShareUrl(code: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}?r=${code}`;
}
