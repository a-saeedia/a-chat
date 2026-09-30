import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getMetaGraphApiVersion, requireEnv } from "@/lib/env";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";

/**
 * Facebook Login (Business Login) — the grant ManyChat-class tools use.
 *
 * This is a different Meta product from the Instagram API with Instagram Login
 * in ./oauth.ts. That one authorizes on www.instagram.com and can only ever
 * return a single Instagram professional account; it cannot see a Page, a Page
 * inbox, or WhatsApp. Facebook Login returns a *user* token from which
 * /me/accounts lists every Page the authorizing person manages, so one consent
 * screen connects an entire portfolio.
 */

/** Page + Instagram. The set every install needs, and the set a plain
 *  personal Facebook account is actually able to grant. */
const CORE_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_manage_comments",
] as const;

/**
 * WhatsApp Cloud scopes.
 *
 * Off by default. `whatsapp_business_management` is only grantable from a
 * Business Manager account; a personal or non-BM admin hits a consent screen
 * that hard-fails for the whole request, taking the Page and Instagram
 * permissions down with it. Opt in with META_WHATSAPP_SCOPES=1 once the app is
 * attached to a Business Manager.
 */
const WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

function graphBase(): string {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

function oauthBase(): string {
  return `https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth`;
}

export function getFacebookScopes(): string[] {
  const withWhatsapp = process.env.META_WHATSAPP_SCOPES === "1";
  return withWhatsapp ? [...CORE_SCOPES, ...WHATSAPP_SCOPES] : [...CORE_SCOPES];
}

/* ------------------------------------------------------------------ state -- */

interface FacebookOAuthState {
  workspaceId: string;
  ts: number;
  nonce: string;
}

// Domain-separated from the Instagram flow's HMAC so a `state` minted for one
// callback cannot be replayed against the other. Without this, a state captured
// from /api/instagram/connect would verify at /api/meta/callback and hand over
// the attacker's chosen workspace.
const STATE_DOMAIN = "meta-facebook-login";

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(`${STATE_DOMAIN}.${payload}`)
    .digest("base64url");
}

export function createFacebookOAuthState(workspaceId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      workspaceId,
      ts: Date.now(),
      nonce: randomBytes(16).toString("base64url"),
    } satisfies FacebookOAuthState)
  ).toString("base64url");

  return `${payload}.${signState(payload)}`;
}

export function verifyFacebookOAuthState(
  state: string | null
): FacebookOAuthState | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as FacebookOAuthState;
    if (!parsed.workspaceId || !parsed.nonce) return null;
    if (Date.now() - parsed.ts > 10 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- authorize */

export function getFacebookAuthorizationUrl(
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: requireEnv("META_APP_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  // Facebook Login for Business replaces the inline scope list with a
  // Configuration ID created in the App Dashboard. config_id wins when present:
  // Meta warns that a scope list sent alongside it can conflict, and the
  // config is what App Review actually looks at. Apps still on the classic
  // Facebook Login product have no config_id and keep using scope.
  const configId = process.env.META_LOGIN_CONFIG_ID;
  if (configId) {
    params.set("config_id", configId);
  } else {
    params.set("scope", getFacebookScopes().join(","));
  }

  // "reauthenticate" drops the session cookie so the consent screen always
  // renders. That is right after a revoke-and-retry and wrong otherwise — a
  // user with a healthy grant gets needlessly re-prompted. Opt in.
  if (process.env.META_FORCE_REAUTHENTICATE === "1") {
    params.set("auth_type", "reauthenticate");
  }

  return `${oauthBase()}?${params.toString()}`;
}

/* -------------------------------------------------------------------- token */

interface FacebookTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Facebook Login returns a ~1 hour user token. Everything downstream — page
 * token derivation, /me/accounts, webhook subscription — is unreliable against
 * it, and a cron job holding one would find it dead. Exchange immediately for
 * the 60-day token and store that instead.
 */
export async function exchangeFacebookCodeForLongLivedToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const shortLived = new URL(`${graphBase()}/oauth/access_token`);
  shortLived.searchParams.set("client_id", requireEnv("META_APP_ID"));
  shortLived.searchParams.set("client_secret", requireEnv("META_APP_SECRET"));
  shortLived.searchParams.set("redirect_uri", redirectUri);
  shortLived.searchParams.set("code", code);

  const shortRes = await fetch(shortLived.toString());
  const shortData = (await shortRes.json()) as FacebookTokenResponse & {
    error?: { message?: string };
  };
  if (!shortRes.ok || !shortData.access_token) {
    throw new Error(
      `Facebook code exchange failed: ${shortData.error?.message ?? shortRes.status}`
    );
  }

  // No {user-id} path segment: the documented form is
  // GET /{version}/oauth/access_token?grant_type=fb_exchange_token&...
  const longLived = new URL(`${graphBase()}/oauth/access_token`);
  longLived.searchParams.set("grant_type", "fb_exchange_token");
  longLived.searchParams.set("client_id", requireEnv("META_APP_ID"));
  longLived.searchParams.set("client_secret", requireEnv("META_APP_SECRET"));
  longLived.searchParams.set("fb_exchange_token", shortData.access_token);

  const longRes = await fetch(longLived.toString());
  const longData = (await longRes.json()) as FacebookTokenResponse & {
    error?: { message?: string };
  };
  if (!longRes.ok || !longData.access_token) {
    throw new Error(
      `Facebook long-lived token exchange failed: ${
        longData.error?.message ?? longRes.status
      }`
    );
  }

  return {
    accessToken: longData.access_token,
    expiresIn: longData.expires_in ?? 5_184_000,
  };
}

/** /me with the long-lived user token — the identity behind the grant. */
export async function getFacebookUser(
  accessToken: string
): Promise<{ id: string; name: string }> {
  const url = new URL(`${graphBase()}/me`);
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = (await response.json()) as {
    id?: string;
    name?: string;
    error?: { message?: string };
  };

  if (!response.ok || !data.id) {
    throw new Error(
      `Facebook /me failed: ${data.error?.message ?? response.status}`
    );
  }

  return { id: data.id, name: data.name ?? "" };
}

/** Which permissions this app actually holds, per Meta. Drives the setup
 *  checklist shown when a Page connects but its webhooks stay silent. */
export async function getFacebookTokenScopes(
  accessToken: string
): Promise<string[]> {
  const url = new URL(`${graphBase()}/me/permissions`);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = (await response.json()) as {
    data?: Array<{ permission?: string; status?: string }>;
    error?: { message?: string };
  };

  if (!response.ok || !data.data) {
    throw new Error(
      `Facebook permissions lookup failed: ${data.error?.message ?? response.status}`
    );
  }

  return data.data
    .filter((entry) => entry.status === "granted")
    .map((entry) => entry.permission)
    .filter((scope): scope is string => Boolean(scope));
}

export { encryptToken, decryptToken };
