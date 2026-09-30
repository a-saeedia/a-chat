import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password hashing, built on Node's own scrypt so the app adds no dependency
 * for it. scrypt is memory-hard, which is the point: it makes a stolen hash
 * expensive to attack off a GPU, without the extra native build step that
 * bcrypt or argon2 would need on Vercel.
 *
 * Node's default scrypt `maxmem` is 32 MiB, and N=16384, r=8 needs exactly
 * 128 * N * r = 16 MiB, so the default would pass today and fail the moment
 * anyone raises N. The limit is set explicitly instead, at twice what the
 * parameters need, so the ceiling moves with them.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/// Bounds on parameters read back out of a stored hash. They exist so a
/// corrupted or hand-edited row cannot make `verifyPassword` allocate
/// unbounded memory. Generous, because a future build may raise the cost.
const MIN_N = 1024;
const MAX_N = 1 << 21;
const MAX_R = 32;
const MAX_P = 16;

/**
 * Shortest password the sign-up form accepts. Length is the only rule that
 * meaningfully raises the cost of guessing a password, so it is the only rule
 * applied; composition rules (a digit, a symbol) push people toward
 * predictable shapes and are deliberately not used.
 */
export const MIN_PASSWORD_LENGTH = 8;

/// NFKC first, so the same password typed with a composed or decomposed accent
/// hashes the same way on every keyboard and OS. Applied on both sides.
function normalize(password: string): string {
  return password.normalize("NFKC");
}

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2;
}

/// `promisify(scrypt)` resolves to Node's documented 3-argument overload and so
/// rejects the cost parameters entirely. The promise is built by hand instead,
/// which keeps the overload that actually takes `options`.
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(normalize(password), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: maxmemFor(SCRYPT_N, SCRYPT_R),
  });

  // Self-describing: the parameters travel with the hash, so they can be
  // raised later without invalidating every existing password.
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Constant-time check of `password` against a stored hash. Returns false for
 * any malformed input rather than throwing, so a bad row is a failed login and
 * not a 500.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < MIN_N ||
    N > MAX_N ||
    r < 1 ||
    r > MAX_R ||
    p < 1 ||
    p > MAX_P
  ) {
    return false;
  }

  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(normalize(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, so it is only reached when
  // the lengths already agree.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
