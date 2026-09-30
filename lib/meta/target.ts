import { decryptToken } from "@/lib/meta/oauth";
import { getMetaGraphApiVersion } from "@/lib/env";

/**
 * Instagram messaging is reachable over two different Graph products, and an
 * account connected either way is stored in the same table. Picking the wrong
 * one fails with an error that looks like a permissions problem, which sends
 * people to App Review for nothing.
 *
 *  - Instagram API with Instagram Login (lib/meta/oauth.ts)
 *      host  graph.instagram.com
 *      id    the IGSID (user_id), not the app-scoped id
 *      auth  an Instagram-scoped long-lived user token
 *      set   by this app on the connected account itself
 *
 *  - Facebook Login, Page with a linked IG (lib/meta/facebook-oauth.ts)
 *      host  graph.facebook.com
 *      id    the instagram_business_account id
 *      auth  the Page Access Token derived from the user's long-lived token
 *      set   by linking the IG professional account to a Facebook Page
 *
 * `pageId` being non-null on the account row is the discriminator: the Facebook
 * Login path is the only one that can ever populate it.
 */

export interface MessagingTarget {
  /** Full versioned Graph base, e.g. https://graph.instagram.com/v25.0 */
  base: string;
  /** Decrypted, ready to use. */
  token: string;
  /** Host-appropriate account identifier. */
  accountId: string;
  /** Which product this account was connected through. Surfaced in the UI so
   *  "why can't I DM from this account" is answerable without a stack trace. */
  source: "INSTAGRAM_LOGIN" | "FACEBOOK_PAGE";
}

export type MessagingAccount = {
  instagramId: string;
  accessToken: string;
  pageId: string | null;
};

export function resolveMessagingTarget(
  account: MessagingAccount
): MessagingTarget {
  const version = getMetaGraphApiVersion();

  if (account.pageId) {
    return {
      base: `https://graph.facebook.com/${version}`,
      token: decryptToken(account.accessToken),
      accountId: account.instagramId,
      source: "FACEBOOK_PAGE",
    };
  }

  return {
    base: `https://graph.instagram.com/${version}`,
    token: decryptToken(account.accessToken),
    accountId: account.instagramId,
    source: "INSTAGRAM_LOGIN",
  };
}
