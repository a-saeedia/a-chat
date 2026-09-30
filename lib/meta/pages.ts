import { prisma } from "@/lib/db/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import { encryptToken, decryptToken } from "@/lib/meta/oauth";
import { MetaApiError } from "@/lib/meta/client";

/**
 * Facebook Login page discovery.
 *
 * One call to /me/accounts returns every Page the authorizing person has a
 * role on, each already carrying a derived Page Access Token, plus the
 * Instagram professional account linked to it. That is the whole trick behind
 * a ManyChat-style connect: one consent screen, N channels, no per-account
 * token plumbing.
 */

function graphBase(): string {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

export interface DiscoveredPage {
  pageId: string;
  pageName: string;
  pictureUrl: string | null;
  /** Page-scoped, derived from the user's long-lived token. Never expires on a
   *  schedule — invalidated only if the grant is revoked or the person loses
   *  their Page role. */
  pageAccessToken: string;
  instagramId: string | null;
  instagramUsername: string | null;
  hasMessenger: boolean;
}

interface AccountsResponse {
  data?: Array<{
    id: string;
    name?: string;
    access_token?: string;
    picture?: { data?: { url?: string } };
    instagram_business_account?: { id?: string; username?: string };
    // A Page with no inbox and no linked IG is a dead end for this product but
    // Meta still lists it. Surfaced so the picker can grey it out rather than
    // failing at connect time.
    has_messenger_chat_page?: boolean;
  }>;
  error?: { message?: string; code?: number };
}

/**
 * Every Page reachable with this user token.
 *
 * `pages_show_list` is what makes this return anything at all; without it Meta
 * answers 200 with an empty list, which is indistinguishable from "this person
 * manages no Pages" and is the single most common cause of a connect that
 * appears to succeed and connects nothing.
 */
export async function discoverPages(
  userAccessToken: string
): Promise<DiscoveredPage[]> {
  const url = new URL(`${graphBase()}/me/accounts`);
  url.searchParams.set(
    "fields",
    "id,name,access_token,picture{url},instagram_business_account{id,username},has_messenger_chat_page"
  );
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", userAccessToken);

  const response = await fetch(url.toString());
  const data = (await response.json()) as AccountsResponse;

  if (!response.ok || data.error) {
    throw new MetaApiError(
      data.error?.code ?? response.status,
      undefined,
      undefined,
      `Page discovery failed: ${data.error?.message ?? response.status}`
    );
  }

  return (data.data ?? [])
    // A Page with no access_token in the response is one the person can see but
    // cannot act as. Skipping it beats storing a blank credential.
    .flatMap((page) => {
      if (!page.access_token) return [];
      return [
        {
          pageId: page.id,
          pageName: page.name ?? page.id,
          pictureUrl: page.picture?.data?.url ?? null,
          pageAccessToken: page.access_token,
          instagramId: page.instagram_business_account?.id ?? null,
          instagramUsername: page.instagram_business_account?.username ?? null,
          hasMessenger: page.has_messenger_chat_page !== false,
        },
      ];
    });
}

/**
 * Subscribe a Page to this app's webhooks.
 *
 * Without this the Page connects, the UI says so, and nothing ever arrives —
 * the app looks broken rather than unconfigured. Best-effort: a failure here
 * must not abort the connect, because the Page is still usable for API sends.
 */
export async function subscribeAppToPageWebhooks(
  pageId: string,
  pageAccessToken: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${graphBase()}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(
        pageAccessToken
      )}`,
      { method: "POST" }
    );
    const data = (await response.json()) as {
      success?: boolean;
      error?: { message?: string };
    };
    return Boolean(data.success) && response.ok;
  } catch (error) {
    console.warn("[Meta] Page webhook subscription failed:", error);
    return false;
  }
}

/**
 * Refresh the discovery cache. Idempotent — safe to call from a cron to pick
 * up a Page the user was later granted a role on, or an IG link added after
 * the initial connect.
 */
export async function syncDiscoveredPages({
  metaConnectionId,
  workspaceId,
  userAccessToken,
}: {
  metaConnectionId: string;
  workspaceId: string;
  userAccessToken: string;
}): Promise<DiscoveredPage[]> {
  const pages = await discoverPages(userAccessToken);

  for (const page of pages) {
    await prisma.metaChannel.upsert({
      where: {
        metaConnectionId_pageId: { metaConnectionId, pageId: page.pageId },
      },
      create: {
        metaConnectionId,
        pageId: page.pageId,
        pageName: page.pageName,
        pictureUrl: page.pictureUrl,
        instagramId: page.instagramId,
        instagramUsername: page.instagramUsername,
        hasMessenger: page.hasMessenger,
      },
      update: {
        pageName: page.pageName,
        pictureUrl: page.pictureUrl,
        instagramId: page.instagramId,
        instagramUsername: page.instagramUsername,
        hasMessenger: page.hasMessenger,
      },
    });
  }

  const discoveredIds = pages.map((page) => page.pageId);

  // An empty result is ambiguous: it can mean the user genuinely has no Pages,
  // or it can mean Meta returned nothing transiently. Deleting the whole cache
  // on that signal turns a blip into a wiped picker, so only prune when we have
  // a positive list to compare against.
  if (discoveredIds.length > 0) {
    // Scope the delete to a connection this workspace actually owns, so a
    // caller bug can never prune another workspace's channels.
    const connection = await prisma.metaConnection.findFirst({
      where: { id: metaConnectionId, workspaceId },
      select: { id: true },
    });

    if (connection) {
      await prisma.metaChannel.deleteMany({
        where: {
          metaConnectionId,
          pageId: { notIn: discoveredIds },
        },
      });
    }
  }

  return pages;
}

export type ConnectResult =
  | { ok: true; instagramAccountId: string; webhookSubscribed: boolean }
  | { ok: false; reason: "no_instagram" | "already_connected" | "not_found" };

/**
 * Turn a discovered Page into a usable account row.
 *
 * Stores the *Page* token, not an Instagram-scoped one: an account discovered
 * through Facebook Login has no Instagram-scoped token to store. The Graph
 * host and ID space differ from the Instagram Login path — resolve both with
 * `resolveMessagingTarget` in ./target rather than assuming graph.instagram.com.
 */
export async function connectPageChannel({
  workspaceId,
  metaConnectionId,
  pageId,
}: {
  workspaceId: string;
  metaConnectionId: string;
  pageId: string;
}): Promise<ConnectResult> {
  const channel = await prisma.metaChannel.findFirst({
    where: { pageId, metaConnectionId },
  });
  if (!channel) return { ok: false, reason: "not_found" };
  if (!channel.instagramId || !channel.instagramUsername) {
    return { ok: false, reason: "no_instagram" };
  }

  const connection = await prisma.metaConnection.findUnique({
    where: { id: metaConnectionId },
    select: { accessToken: true },
  });
  if (!connection) return { ok: false, reason: "not_found" };

  // Re-discover to recover the Page Access Token. It is not persisted by
  // design — Meta treats it as a derived credential, and the discovery cache
  // is meant to be safe to render from a stale read.
  const pages = await discoverPages(decryptToken(connection.accessToken));
  const page = pages.find((candidate) => candidate.pageId === pageId);
  if (!page) return { ok: false, reason: "not_found" };

  const existing = await prisma.instagramAccount.findUnique({
    where: { instagramId: channel.instagramId },
    select: { id: true, workspaceId: true, provider: true },
  });
  if (
    existing &&
    (existing.workspaceId !== workspaceId || existing.provider === "ZERNIO")
  ) {
    return { ok: false, reason: "already_connected" };
  }

  const webhookSubscribed = await subscribeAppToPageWebhooks(
    page.pageId,
    page.pageAccessToken
  );
  await prisma.metaChannel.update({
    where: { id: channel.id },
    data: { webhooksSubscribed: webhookSubscribed },
  });

  const encryptedToken = encryptToken(page.pageAccessToken);
  const data = {
    username: channel.instagramUsername,
    name: channel.pageName,
    accessToken: encryptedToken,
    // Page tokens do not carry an expiry, so this stays null rather than
    // inventing a date. A fabricated expiry would make the Settings UI
    // "renew soon" for a token that is perfectly valid.
    tokenExpiresAt: null,
    webhookSubscribed,
    pageId: page.pageId,
    metaConnectionId,
  };
  const account = existing
    ? await prisma.instagramAccount.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.instagramAccount.create({
        data: {
          ...data,
          workspaceId,
          instagramId: channel.instagramId!,
        },
      });

  return { ok: true, instagramAccountId: account.id, webhookSubscribed };
}
