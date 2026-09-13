const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, sortable-enough, collision-resistant id for jobs and ideas. */
export function newId(prefix: string, now: number = Date.now()): string {
  const time = now.toString(36).padStart(9, "0");
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${random}`;
}
