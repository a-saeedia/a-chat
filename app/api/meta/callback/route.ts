import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { encryptToken } from "@/lib/meta/oauth";
import {
  exchangeFacebookCodeForLongLivedToken,
  getFacebookTokenScopes,
  getFacebookUser,
  verifyFacebookOAuthState,
} from "@/lib/meta/facebook-oauth";
import { syncDiscoveredPages } from "@/lib/meta/pages";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Step 2 of the Facebook Login connect. Trades the code for a long-lived user
 * token, stores it once per workspace, and caches everything /me/accounts
 * returned so the Settings picker renders without a Meta round trip.
 *
 * Deliberately does NOT connect an Instagram account here. A user may have ten
 * Pages and want one; the picker decides, per channel. See /api/meta/channels.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const baseUrl = getBaseUrl();

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?meta=denied`);
  }

  const state = verifyFacebookOAuthState(request.nextUrl.searchParams.get("state"));
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?meta=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  // State is HMAC-signed, but it is not proof of a live session: re-check
  // membership here so a leaked state string cannot bind someone else's
  // Facebook grant to a workspace.
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?meta=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/meta/callback`;
    const { accessToken, expiresIn } =
      await exchangeFacebookCodeForLongLivedToken(code, redirectUri);

    const [user, grantedScopes] = await Promise.all([
      getFacebookUser(accessToken),
      getFacebookTokenScopes(accessToken),
    ]);

    const encryptedToken = encryptToken(accessToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    // One connection per workspace: a second admin re-authorizing replaces the
    // first admin's grant. Page tokens derived from the old grant stop working,
    // so reconnecting must also re-derive any connected channels.
    const connection = await prisma.metaConnection.upsert({
      where: { workspaceId: state.workspaceId },
      create: {
        workspaceId: state.workspaceId,
        metaUserId: user.id,
        displayName: user.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        scopes: grantedScopes,
      },
      update: {
        metaUserId: user.id,
        displayName: user.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        scopes: grantedScopes,
      },
    });

    // Best effort. A Page list that fails to sync still leaves a working
    // connection, and the user can retry from Settings.
    let pageCount = 0;
    try {
      const pages = await syncDiscoveredPages({
        metaConnectionId: connection.id,
        workspaceId: state.workspaceId,
        userAccessToken: accessToken,
      });
      pageCount = pages.length;
    } catch (syncError) {
      console.warn("[Meta Callback] Page discovery failed:", syncError);
    }

    if (pageCount === 0) {
      // Either the token genuinely grants no pages, or discovery failed. Both
      // land the user on the same screen, so say the ambiguous thing.
      return NextResponse.redirect(`${baseUrl}/settings?meta=no_pages`);
    }

    return NextResponse.redirect(`${baseUrl}/settings?meta=connected`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Meta Callback] Error:", err);

    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Facebook connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(
      `${baseUrl}/settings?meta=failed&reason=${encodeURIComponent(
        message.slice(0, 200)
      )}`
    );
  }
}
