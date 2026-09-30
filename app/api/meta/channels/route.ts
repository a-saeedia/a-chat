import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { connectPageChannel, syncDiscoveredPages } from "@/lib/meta/pages";
import { decryptToken } from "@/lib/meta/oauth";

/**
 * Channels are scoped through MetaConnection, which is unique per workspace.
 * Every query here joins from workspaceId down to that connection rather than
 * trusting a client-supplied metaConnectionId, so a crafted request cannot
 * reach another workspace's Pages.
 */
type ConnectionResult =
  | {
      ok: true;
      workspaceId: string;
      connection: {
        id: string;
        accessToken: string;
        connectedAt: Date;
        metaUserId: string;
      };
    }
  | { ok: false; error: "unauthorized" | "forbidden" | "not_connected" };

async function getConnectionForWorkspace(): Promise<ConnectionResult> {
  const context = await getCurrentWorkspaceContext();
  if (!context) return { ok: false, error: "unauthorized" };
  if (!canManageWorkspace(context.role)) return { ok: false, error: "forbidden" };

  const connection = await prisma.metaConnection.findUnique({
    where: { workspaceId: context.workspaceId },
  });
  if (!connection) return { ok: false, error: "not_connected" };

  return { ok: true, workspaceId: context.workspaceId, connection };
}

/** GET: everything /me/accounts found, plus whether it is connected yet. */
export async function GET() {
  const result = await getConnectionForWorkspace();
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: statusFor(result.error) }
    );
  }

  const channels = await prisma.metaChannel.findMany({
    where: { metaConnectionId: result.connection.id },
    orderBy: { pageName: "asc" },
    include: {
      accounts: {
        where: { workspaceId: result.workspaceId },
        select: { id: true, username: true, pageId: true },
      },
    },
  });

  return NextResponse.json({
    connected: true,
    connectedAt: result.connection.connectedAt,
    metaUserId: result.connection.metaUserId,
    channels: channels.map((channel) => ({
      id: channel.id,
      pageId: channel.pageId,
      pageName: channel.pageName,
      pictureUrl: channel.pictureUrl,
      instagramId: channel.instagramId,
      instagramUsername: channel.instagramUsername,
      hasInstagram: Boolean(channel.instagramId),
      hasMessenger: channel.hasMessenger,
      webhooksSubscribed: channel.webhooksSubscribed,
      connectedAccountId: channel.accounts[0]?.id ?? null,
      connectedUsername: channel.accounts[0]?.username ?? null,
    })),
  });
}

/**
 * POST: connect one Page's linked Instagram account.
 *
 * Body: { action: "connect" | "resync", pageId?: string }
 *   connect - derive Page token, subscribe webhooks, upsert InstagramAccount
 *   resync  - re-run /me/accounts without a new consent round trip
 */
export async function POST(request: NextRequest) {
  const result = await getConnectionForWorkspace();
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: statusFor(result.error) }
    );
  }

  let body: { action?: string; pageId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body.action === "resync") {
    try {
      const userAccessToken = decryptToken(result.connection.accessToken);
      const pages = await syncDiscoveredPages({
        metaConnectionId: result.connection.id,
        workspaceId: result.workspaceId,
        userAccessToken,
      });
      return NextResponse.json({ ok: true, discovered: pages.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[Meta Channels] Resync failed:", err);
      return NextResponse.json({ error: "resync_failed", reason: message }, { status: 502 });
    }
  }

  if (body.action !== "connect" || !body.pageId) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const outcome = await connectPageChannel({
    workspaceId: result.workspaceId,
    metaConnectionId: result.connection.id,
    pageId: body.pageId,
  });

  if (!outcome.ok) {
    const status = outcome.reason === "not_found" ? 404 : 409;
    return NextResponse.json({ error: outcome.reason }, { status });
  }

  return NextResponse.json({
    ok: true,
    instagramAccountId: outcome.instagramAccountId,
    webhookSubscribed: outcome.webhookSubscribed,
  });
}

function statusFor(error: string): number {
  switch (error) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_connected":
      return 409;
    default:
      return 400;
  }
}
