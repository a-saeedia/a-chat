import { prisma } from '@/lib/db/client';
import { getDMQueue, MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from '@/lib/queue/client';
import {
  isMessagingWebhookObject,
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  remapEntryIds,
  type WebhookPayload,
} from '@/lib/meta/webhook';
import { Prisma, type InstagramProvider } from '@/app/generated/prisma/client';

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;
type InstagramPayload = WebhookPayload;
type WebhookEntry = InstagramPayload['entry'][number];

type ResolvedAccount = {
  id: string;
  instagramId: string;
  pageId: string | null;
  workspaceId: string;
};

/**
 * Turn one verified webhook delivery into queue jobs for every account it
 * belongs to.
 *
 * A Page-linked Instagram account is delivered under the Page id
 * (`object: "page"`), not its own Instagram id. Resolving accounts by both ids
 * and re-keying the payload to the real Instagram id is what keeps a Page
 * delivery from being dropped as "no such account" and from leaking a Page id
 * into job fields the worker resolves by `InstagramAccount.instagramId`.
 */
export async function processInstagramWebhook({ payload: incoming, provider, workspaceId }: {
  payload: InstagramPayload; provider: InstagramProvider; workspaceId?: string;
}) {
  if (!isMessagingWebhookObject(incoming.object) || !Array.isArray(incoming.entry)) return;
  const entryIds = Array.from(
    new Set(incoming.entry.map(e => e.id).filter((id): id is string => Boolean(id)))
  );
  if (!entryIds.length) return;
  // An entry id alone does not say which column to match, so look in both. The
  // provider/workspace filter stays mandatory: a delivery must never resolve to
  // an account outside the caller's workspace.
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      provider,
      ...(workspaceId ? { workspaceId } : {}),
      OR: [{ instagramId: { in: entryIds } }, { pageId: { in: entryIds } }],
    },
    select: { id: true, instagramId: true, pageId: true, workspaceId: true },
  });
  // Key by both ids so a delivery resolves whichever one Meta used, and always
  // queue the real Instagram id.
  const accountByEntryId = new Map<string, ResolvedAccount>();
  for (const account of accounts) {
    accountByEntryId.set(account.instagramId, account);
    if (account.pageId) accountByEntryId.set(account.pageId, account);
  }
  const resolvedEntries = incoming.entry
    .map((entry) => ({ entry, account: accountByEntryId.get(entry.id) }))
    .filter((pair): pair is { entry: WebhookEntry; account: ResolvedAccount } => Boolean(pair.account));
  if (!resolvedEntries.length) return;
  // Keep Meta's own entry ids in the stored record so the audit trail matches
  // what was delivered; parse from a copy rewritten to Instagram ids.
  const recordPayload = { ...incoming, entry: resolvedEntries.map(({ entry }) => entry) };
  const payload = remapEntryIds(
    incoming,
    entryId => accountByEntryId.get(entryId)?.instagramId ?? null
  );
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object: String(incoming.object),
      payload: recordPayload as unknown as Prisma.InputJsonValue,
      // Scoped to the resolved account's workspace when the caller did not
      // already pin one, so a delivery is attributable without a second write.
      workspaceId: workspaceId ?? resolvedEntries[0].account.workspaceId,
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(payload);
    const queue = getDMQueue();

    for (const event of commentEvents) {
      const account = accountByEntryId.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        "process-comment",
        {
          instagramAccountId: account.instagramId,
          accountConnectionId: account.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${account.instagramId}_${event.commentId}`,
        }
      );
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(payload);

    for (const event of postbackEvents) {
      const account = accountByEntryId.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: account.instagramId,
          accountConnectionId: account.id,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${account.instagramId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(payload);

    for (const event of messageEvents) {
      const account = accountByEntryId.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: account.instagramId,
          accountConnectionId: account.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${account.instagramId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(payload);

    for (const event of readEvents) {
      const account = accountByEntryId.get(event.instagramAccountId);
      if (!account) continue;

      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            // The resolved row, not the delivered id: a Page delivery must not
            // silently miss the opening DM it belongs to.
            instagramAccount: { id: account.id },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: account.instagramId,
            accountConnectionId: account.id,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${account.instagramId}_${event.userId}_${automation.id}`,
          }
        );
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });

    throw error;
  }
}
