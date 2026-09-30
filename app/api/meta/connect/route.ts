import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl, getMissingFacebookOAuthEnv } from "@/lib/env";
import {
  createFacebookOAuthState,
  getFacebookAuthorizationUrl,
} from "@/lib/meta/facebook-oauth";

/**
 * Step 1 of the Facebook Login connect. Issues one user token that /me/accounts
 * then expands into every Page this person can reach, so a workspace with five
 * pages is one consent screen rather than five.
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.redirect(`${getBaseUrl()}/login`);
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?meta=forbidden`);
  }

  // getFacebookAuthorizationUrl calls requireEnv, which throws. Checked up
  // front for the same reason as the Instagram route: a half-filled .env must
  // not surface as a silent 500 on a plain link click.
  const missingEnv = getMissingFacebookOAuthEnv();
  if (missingEnv.length > 0) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?meta=misconfigured&missing=${encodeURIComponent(
        missingEnv.join(",")
      )}`
    );
  }

  const redirectUri = `${getBaseUrl()}/api/meta/callback`;
  const state = createFacebookOAuthState(context.workspaceId);

  return NextResponse.redirect(getFacebookAuthorizationUrl(redirectUri, state));
}
