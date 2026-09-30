import { decryptToken } from "@/lib/meta/oauth";
import { resolveMessagingTarget } from "@/lib/meta/target";
import { prisma } from "@/lib/db/client";

export type InstagramContext =
  | {
      provider: "META";
      accessToken: string;
      /**
       * Graph host + version for this account's Instagram product. Page-linked
       * accounts discovered through Facebook Login live on graph.facebook.com;
       * accounts connected through Instagram Login live on graph.instagram.com.
       * Mixing them up surfaces as a permissions error, so it is resolved once
       * here rather than guessed at each call site.
       */
      graphBase: string;
    }
  | {
      provider: "ZERNIO";
      apiKey: string;
      accountId: string;
      instagramId: string;
      operationId?: string;
    };

export type ProviderAccount = {
  provider: "META" | "ZERNIO";
  workspaceId: string;
  zernioAccountId: string | null;
  instagramId: string;
  accessToken: string;
  pageId: string | null;
};

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "provider" | "accessToken" | "zernioAccountId">
) {
  return account.provider === "ZERNIO"
    ? Boolean(account.zernioAccountId)
    : Boolean(account.accessToken);
}

export async function createInstagramContext(
  account: ProviderAccount,
  operationId?: string
): Promise<InstagramContext> {
  if (account.provider !== "ZERNIO") {
    const target = resolveMessagingTarget(account);
    return {
      provider: "META",
      accessToken: target.token,
      graphBase: target.base,
    };
  }
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");
  const connection = await prisma.zernioConnection.findUnique({
    where: { workspaceId: account.workspaceId },
    select: { apiKey: true },
  });
  if (!connection) throw new Error("Zernio workspace connection is missing");
  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    instagramId: account.instagramId,
    ...(operationId ? { operationId } : {}),
  };
}

export type ZernioContext = Extract<InstagramContext, { provider: "ZERNIO" }>;
