/** DAO (account officer) code: asked for at the very start of every financing request. Shared by browser and server. */
export const DAO_CODE_HINT = "Your DAO (account officer) code, e.g. DAO-1001";
const DAO_PATTERN = /^[A-Z0-9][A-Z0-9\-/]{1,29}$/;

/** Upper-cases and trims. Returns null when the value is not a plausible DAO code. */
export function normaliseDaoCode(raw: string | null | undefined): string | null {
  const v = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return DAO_PATTERN.test(v) ? v : null;
}

export const DAO_CODE_MESSAGE = "Enter the DAO code (2 to 30 letters, digits, hyphens or slashes).";
