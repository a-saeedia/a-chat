/**
 * Bits shared by the login and sign-up forms. Kept free of server-only imports
 * because the client form components import the label types from here.
 */

/** Field labels the login and sign-up forms both render. */
export type AuthFieldLabels = {
  email: string;
  password: string;
};

export type LoginFormLabels = AuthFieldLabels & {
  signIn: string;
  signInPending: string;
};

export type SignUpFormLabels = AuthFieldLabels & {
  name: string;
  createAccount: string;
  createAccountPending: string;
};

/**
 * Deliberately permissive. A format check cannot tell you an address is real,
 * so this only rejects obvious typos; anything stricter starts rejecting valid
 * addresses. The real gate is `ALLOWED_EMAILS` plus delivery.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Keeps a post-login redirect on this origin. `callbackUrl` arrives from the
 * query string, so without this an attacker could link to
 * `/login?callbackUrl=https://evil.example` and have a successful sign-in hand
 * the user to their site.
 *
 * Only same-origin, absolute-path targets survive. `//evil.example` and
 * `/\evil.example` are rejected too: browsers read both as protocol-relative
 * URLs, so a check for a leading `/` alone would let them through, which is
 * why any backslash is refused outright.
 */
export function sanitizeRedirect(
  raw: string | null | undefined,
  fallback = "/dashboard"
): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  return raw;
}
