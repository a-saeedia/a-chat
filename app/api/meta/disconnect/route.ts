import { NextResponse } from "next/server";
import { auth, getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Drops the local Facebook connection for the current workspace.
 *
 * This is a LOCAL-ONLY disconnect. It deliberately does not call Meta's
 * DELETE /me/permissions revoke endpoint: revoking at Meta would immediately
 * invalidate the Page-scoped tokens still held by the detached
 * InstagramAccounts described below, so the grant is left intact and only the
 * cached connection is removed.
 *
 * Deliberately does NOT delete the InstagramAccounts that were derived from
 * these Pages. InstagramAccount is referenced by automations, comments, and
 * analytics with onDelete: Cascade, so deleting accounts here would silently
 * destroy the workspace's whole automation history. The composite FK is
 * ON DELETE SET NULL, so accounts survive and simply detach from the Page.
 *
 * The trade-off: a detached Page-derived account keeps a Page-scoped token that
 * will fail once Meta expires it. It stays listed in Settings so the user can
 * see what happened, and reconnecting re-binds it.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Scope to the caller's actual current workspace. A bare findFirst on userId
  // would pick an arbitrary membership and could disconnect a different
  // workspace's connection than the one being viewed.
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: session.user.id, workspaceId },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const connection = await prisma.metaConnection.findUnique({
    where: { workspaceId },
  });
  if (!connection) {
    return NextResponse.json({ ok: true, alreadyDisconnected: true });
  }

  await prisma.metaConnection.delete({ where: { id: connection.id } });

  return NextResponse.json({ ok: true });
}
