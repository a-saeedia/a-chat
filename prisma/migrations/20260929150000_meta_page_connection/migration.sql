-- Facebook Login (Business Login) connection. One row per workspace, holding
-- the long-lived user token that /me/accounts is called with. Page and
-- Instagram credentials derived from it live on InstagramAccount, not here.
CREATE TABLE "MetaConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "metaUserId" TEXT NOT NULL,
  "displayName" TEXT,
  "accessToken" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "scopes" TEXT[],
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- Discovery cache of everything one /me/accounts call returned, including
-- channels the user has not connected yet. No credential is stored here.
CREATE TABLE "MetaChannel" (
  "id" TEXT NOT NULL,
  "metaConnectionId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "pageName" TEXT NOT NULL,
  "pictureUrl" TEXT,
  "instagramId" TEXT,
  "instagramUsername" TEXT,
  "hasMessenger" BOOLEAN NOT NULL DEFAULT true,
  "webhooksSubscribed" BOOLEAN NOT NULL DEFAULT false,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MetaChannel_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "InstagramAccount" ADD COLUMN "pageId" TEXT, ADD COLUMN "metaConnectionId" TEXT;

CREATE UNIQUE INDEX "MetaConnection_workspaceId_key" ON "MetaConnection"("workspaceId");
CREATE INDEX "MetaConnection_workspaceId_idx" ON "MetaConnection"("workspaceId");
CREATE UNIQUE INDEX "MetaChannel_metaConnectionId_pageId_key" ON "MetaChannel"("metaConnectionId", "pageId");
CREATE INDEX "MetaChannel_pageId_idx" ON "MetaChannel"("pageId");
CREATE INDEX "InstagramAccount_pageId_idx" ON "InstagramAccount"("pageId");

ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MetaChannel" ADD CONSTRAINT "MetaChannel_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Composite so an account can only be linked to a channel belonging to the
-- same connection that discovered it. SetNull on delete: losing the
-- MetaConnection must not cascade into deleting the connected account and
-- with it every automation pointing at it.
ALTER TABLE "InstagramAccount" ADD CONSTRAINT "InstagramAccount_metaConnectionId_pageId_fkey" FOREIGN KEY ("metaConnectionId", "pageId") REFERENCES "MetaChannel"("metaConnectionId", "pageId") ON DELETE SET NULL ON UPDATE CASCADE;
