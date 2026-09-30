/**
 * Webhook intake — Unit Tests
 *
 * Covers how a verified delivery is matched to a connected account and turned
 * into queue jobs. The case that matters most: a Page-linked Instagram account
 * is delivered under the Page id with `object: "page"`, so the intake has to
 * resolve that id and queue the real Instagram id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockQueueAdd } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    dmLog: { findMany: vi.fn() },
  },
  mockQueueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  MESSAGE_JOB_NAME: "process-message",
  POSTBACK_JOB_NAME: "process-postback",
}));

import { processInstagramWebhook } from "@/lib/queue/process-webhook";

const PAGE_ID = "page_123";
const INSTAGRAM_ID = "ig_456";
const ACCOUNT_ID = "acct_789";
const WORKSPACE_ID = "ws_1";

/** An account connected through a Page, as `connectPageChannel` writes it. */
const pageLinkedAccount = {
  id: ACCOUNT_ID,
  instagramId: INSTAGRAM_ID,
  pageId: PAGE_ID,
  workspaceId: WORKSPACE_ID,
};

/** An account connected straight through an Instagram-Login app. */
const directAccount = {
  id: "acct_direct",
  instagramId: INSTAGRAM_ID,
  pageId: null,
  workspaceId: WORKSPACE_ID,
};

function pageMessagePayload() {
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: 1,
        messaging: [
          {
            sender: { id: "user_999" },
            recipient: { id: PAGE_ID },
            timestamp: 1,
            message: { mid: "mid_abc", text: "send link" },
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "wh_1" });
  mockPrisma.webhookEvent.update.mockResolvedValue({});
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  mockQueueAdd.mockResolvedValue({ id: "job_1" });
});

describe("processInstagramWebhook — Page-linked accounts", () => {
  it("queues an inbound DM from a Page payload against the Instagram id", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data] = mockQueueAdd.mock.calls[0];
    expect(name).toBe("process-message");
    // The Page id must never reach a field the worker resolves as an Instagram
    // id, or the reply is attributed to no account and silently dropped.
    expect(data.instagramAccountId).toBe(INSTAGRAM_ID);
    expect(data.accountConnectionId).toBe(ACCOUNT_ID);
    expect(data.messageId).toBe("mid_abc");
    expect(data.messageText).toBe("send link");
    expect(data.senderId).toBe("user_999");
    expect(mockQueueAdd.mock.calls[0][2].jobId).toBe(
      `message_${INSTAGRAM_ID}_${Buffer.from("mid_abc").toString("base64url")}`
    );
  });

  it("looks accounts up by both the Instagram id and the Page id", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    const [where] = mockPrisma.instagramAccount.findMany.mock.calls[0];
    expect(where.where.OR).toEqual([
      { instagramId: { in: [PAGE_ID] } },
      { pageId: { in: [PAGE_ID] } },
    ]);
  });

  it("scopes the lookup to the caller's workspace and provider", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({
      payload: pageMessagePayload(),
      provider: "ZERNIO",
      workspaceId: WORKSPACE_ID,
    });

    const [where] = mockPrisma.instagramAccount.findMany.mock.calls[0];
    expect(where.where.provider).toBe("ZERNIO");
    expect(where.where.workspaceId).toBe(WORKSPACE_ID);
  });

  it("records the delivery against the resolved account's workspace", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    const [create] = mockPrisma.webhookEvent.create.mock.calls[0];
    expect(create.data.object).toBe("page");
    expect(create.data.workspaceId).toBe(WORKSPACE_ID);
    expect(create.data.status).toBe("PENDING");
  });

  it("stores the payload exactly as Meta sent it, Page id included", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    const [create] = mockPrisma.webhookEvent.create.mock.calls[0];
    // The audit record has to match the delivery; only the parse copy is
    // rewritten to Instagram ids.
    expect(create.data.payload.entry[0].id).toBe(PAGE_ID);
  });

  it("marks the delivery processed and touches no other event row", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) })
    );
  });

  it("ignores a Page that is not connected", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([]);

    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("drops the unconnected Page and still serves the connected one", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);
    const payload = {
      object: "page",
      entry: [
        ...pageMessagePayload().entry,
        {
          id: "page_unknown",
          time: 1,
          messaging: [
            { sender: { id: "user_1" }, message: { mid: "mid_x", text: "hi" } },
          ],
        },
      ],
    };

    await processInstagramWebhook({ payload, provider: "META" });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][1].messageId).toBe("mid_abc");
  });
});

describe("processInstagramWebhook — direct Instagram accounts", () => {
  const directPayload = {
    object: "instagram",
    entry: [
      {
        id: INSTAGRAM_ID,
        time: 1,
        messaging: [
          {
            sender: { id: "user_999" },
            recipient: { id: INSTAGRAM_ID },
            message: { mid: "mid_abc", text: "send link" },
          },
        ],
      },
    ],
  };

  it("still queues DMs for an Instagram-Login app payload", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([directAccount]);

    await processInstagramWebhook({ payload: directPayload, provider: "META" });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, data] = mockQueueAdd.mock.calls[0];
    expect(data.instagramAccountId).toBe(INSTAGRAM_ID);
    expect(data.accountConnectionId).toBe("acct_direct");
  });

  it("still queues comments for an Instagram-Login app payload", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([directAccount]);

    await processInstagramWebhook({
      payload: {
        object: "instagram",
        entry: [
          {
            id: INSTAGRAM_ID,
            time: 1,
            changes: [
              {
                field: "comments",
                value: {
                  id: "comment_1",
                  text: "LINK",
                  from: { id: "user_1", username: "u" },
                  media: { id: "media_1" },
                },
              },
            ],
          },
        ],
      },
      provider: "META",
    });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data] = mockQueueAdd.mock.calls[0];
    expect(name).toBe("process-comment");
    expect(data.instagramAccountId).toBe(INSTAGRAM_ID);
    expect(data.accountConnectionId).toBe("acct_direct");
    expect(data.source).toBe("WEBHOOK");
  });

  it("resolves the same account whichever id the delivery used", async () => {
    // Meta can key the same connected account by either id. Both must land on
    // the same account, or a retry under the other id re-processes the traffic.
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({ payload: directPayload, provider: "META" });
    await processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" });

    const ids = mockQueueAdd.mock.calls.map((call) => call[1].instagramAccountId);
    expect(ids).toEqual([INSTAGRAM_ID, INSTAGRAM_ID]);
  });
});

describe("processInstagramWebhook — read receipts and postbacks", () => {
  it("schedules the opening-DM fallback for a Page read receipt", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);
    mockPrisma.dmLog.findMany.mockResolvedValue([{ automation: { id: "auto_1" } }]);

    await processInstagramWebhook({
      payload: {
        object: "page",
        entry: [
          {
            id: PAGE_ID,
            time: 1,
            messaging: [
              {
                sender: { id: "user_999" },
                recipient: { id: PAGE_ID },
                read: { watermark: 1 },
              },
            ],
          },
        ],
      },
      provider: "META",
    });

    // The fallback has to find the opening DM of the *resolved* account, so the
    // query is keyed by the account row, not by the delivered Page id.
    const [where] = mockPrisma.dmLog.findMany.mock.calls[0];
    expect(where.where.automation.instagramAccount).toEqual({ id: ACCOUNT_ID });

    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe("process-postback");
    expect(data.instagramAccountId).toBe(INSTAGRAM_ID);
    expect(data.accountConnectionId).toBe(ACCOUNT_ID);
    expect(data.payload).toBe("reveal:auto_1");
    expect(data.fallback).toBe(true);
    expect(opts.jobId).toBe(`read_fallback_${INSTAGRAM_ID}_user_999_auto_1`);
  });

  it("queues a button tap from a Page payload", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);

    await processInstagramWebhook({
      payload: {
        object: "page",
        entry: [
          {
            id: PAGE_ID,
            time: 1,
            messaging: [
              {
                sender: { id: "user_999" },
                recipient: { id: PAGE_ID },
                postback: { mid: "mid_1", payload: "reveal:auto_1" },
              },
            ],
          },
        ],
      },
      provider: "META",
    });

    const [name, data] = mockQueueAdd.mock.calls[0];
    expect(name).toBe("process-postback");
    expect(data.instagramAccountId).toBe(INSTAGRAM_ID);
    expect(data.accountConnectionId).toBe(ACCOUNT_ID);
    expect(data.userId).toBe("user_999");
    expect(data.payload).toBe("reveal:auto_1");
  });
});

describe("processInstagramWebhook — guard rails", () => {
  it("ignores an object it has no parsers for", async () => {
    await processInstagramWebhook({
      payload: {
        object: "instagram_business_account",
        entry: [{ id: INSTAGRAM_ID, time: 1, messaging: [] }],
      },
      provider: "META",
    });

    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("ignores a payload with no entries", async () => {
    await processInstagramWebhook({
      payload: { object: "page", entry: [] },
      provider: "META",
    });

    expect(mockPrisma.instagramAccount.findMany).not.toHaveBeenCalled();
  });

  it("marks the delivery failed and rethrows when a job cannot be queued", async () => {
    mockPrisma.instagramAccount.findMany.mockResolvedValue([pageLinkedAccount]);
    mockQueueAdd.mockRejectedValue(new Error("redis down"));

    await expect(
      processInstagramWebhook({ payload: pageMessagePayload(), provider: "META" })
    ).rejects.toThrow("redis down");

    expect(mockPrisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorMessage: "redis down" }),
      })
    );
  });
});
