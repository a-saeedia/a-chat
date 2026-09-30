"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

interface Channel {
  id: string;
  pageId: string;
  pageName: string;
  pictureUrl: string | null;
  instagramId: string | null;
  instagramUsername: string | null;
  hasInstagram: boolean;
  hasMessenger: boolean;
  webhooksSubscribed: boolean;
  connectedAccountId: string | null;
  connectedUsername: string | null;
}

interface ChannelsResponse {
  connected: boolean;
  connectedAt?: string;
  channels: Channel[];
}

/**
 * Facebook Login for Business surface: discover the user's Pages, then connect
 * each Page's linked professional Instagram account.
 *
 * Only OWNER/ADMIN can reach any of this, so the component renders read-only
 * for members rather than rendering controls that would 403.
 */
export function MetaConnection({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "unconnected" | "ready">(
    "loading"
  );
  const [channels, setChannels] = useState<Channel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Apply a server payload to component state. Kept separate from the fetch so
  // the mount effect can pass it as a .then() callback instead of calling an
  // async state-setter directly inside the effect body.
  const apply = useCallback((payload: ChannelsResponse & { error?: string }, ok: boolean) => {
    // 404/409 "not_connected" is a normal first-run state, not a failure.
    if (!ok && payload.error !== "not_connected") {
      setError(payload.error ?? "unknown");
      setState("unconnected");
      return;
    }
    setError(null);
    setChannels(payload.channels ?? []);
    setState(payload.connected ? "ready" : "unconnected");
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/meta/channels");
      const payload: ChannelsResponse & { error?: string } = await res.json();
      apply(payload, res.ok);
    } catch {
      setError("network");
      setState("unconnected");
    }
  }, [apply]);

  useEffect(() => {
    void fetch("/api/meta/channels")
      .then(async (res) => apply((await res.json()) as ChannelsResponse & { error?: string }, res.ok))
      .catch(() => {
        setError("network");
        setState("unconnected");
      });
  }, [apply]);

  async function post(body: Record<string, string>) {
    const res = await fetch("/api/meta/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as { error?: string; reason?: string };
    if (!res.ok) throw new Error(payload.error ?? "unknown");
  }

  async function rescan() {
    setBusy("rescan");
    setError(null);
    try {
      await post({ action: "resync" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setBusy(null);
    }
  }

  async function connectChannel(pageId: string) {
    setBusy(`connect:${pageId}`);
    setError(null);
    try {
      await post({ action: "connect", pageId });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!confirm(t("This disconnects the Facebook account. Linked Instagram accounts stay connected."))) {
      return;
    }
    setBusy("disconnect");
    setError(null);
    try {
      await fetch("/api/meta/disconnect", { method: "POST" });
      setChannels([]);
      setState("unconnected");
    } catch {
      setError("network");
    } finally {
      setBusy(null);
    }
  }

  if (state === "loading") return <div className="panel rounded p-4 sm:p-6 h-40" />;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t("Facebook Pages")}</h2>
        {state === "ready" && (
          <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-success/10 text-success">
            {t("Connected")}
          </span>
        )}
      </div>

      <p className="mt-1 text-xs text-muted">
        {t("Connect a Facebook Page to link its Instagram professional account and start receiving DMs.")}
      </p>

      {state === "unconnected" && canManage && (
        <a
          href="/api/meta/connect"
          className="mt-4 inline-flex items-center justify-center rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t("Connect Facebook")}
        </a>
      )}

      {state === "unconnected" && !canManage && (
        <p className="mt-4 text-sm text-muted">
          {t("Only owners and admins can manage Facebook Pages.")}
        </p>
      )}

      {state === "ready" && (
        <div className="mt-4 space-y-3">
          {channels.length === 0 && (
            <p className="text-sm text-muted">
              {t("No Facebook Pages found. Make sure you have a Page task role, then rescan.")}
            </p>
          )}

          {channels.map((channel) => (
            <div
              key={channel.id}
              className="flex flex-col gap-3 rounded border border-border bg-surface/70 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                {channel.pictureUrl && (
                  // Meta CDN host, not user input.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={channel.pictureUrl}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover"
                  />
                )}
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {channel.pageName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {channel.connectedUsername
                      ? `@${channel.connectedUsername}`
                      : channel.instagramUsername
                        ? `@${channel.instagramUsername}`
                        : t("No Instagram account is linked to this Page.")}
                    {channel.hasMessenger ? ` · ${t("Messenger")}` : ""} ·{" "}
                    {channel.webhooksSubscribed
                      ? t("Webhook ready")
                      : t("Webhook pending")}
                  </p>
                </div>
              </div>

              {canManage &&
                (channel.connectedAccountId ? (
                  <span className="text-xs font-medium text-success">
                    {t("Connected")}
                  </span>
                ) : (
                  <button
                    onClick={() => connectChannel(channel.pageId)}
                    disabled={!channel.hasInstagram || busy !== null}
                    className="inline-flex items-center justify-center rounded border border-border px-4 py-2 text-sm font-medium text-foreground transition-all hover:border-primary/40 hover:bg-primary/10 disabled:opacity-50"
                  >
                    {busy === `connect:${channel.pageId}`
                      ? t("Connecting...")
                      : t("Connect this Page")}
                  </button>
                ))}
            </div>
          ))}

          {canManage && (
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={rescan}
                disabled={busy !== null}
                className="inline-flex items-center justify-center rounded border border-border px-4 py-2 text-sm font-medium text-foreground transition-all hover:border-primary/40 disabled:opacity-50"
              >
                {busy === "rescan" ? t("Rescanning...") : t("Rescan")}
              </button>
              <button
                onClick={disconnect}
                disabled={busy !== null}
                className="inline-flex items-center justify-center rounded border border-error/20 px-4 py-2 text-sm font-medium text-error transition-all hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
              >
                {busy === "disconnect" ? t("Disconnecting...") : t("Disconnect Facebook")}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
          {error === "already_connected"
            ? t("That Instagram account is connected to another workspace. Disconnect it there first.")
            : error === "no_instagram"
              ? t("No Instagram account is linked to this Page.")
              : error === "resync_failed"
                ? t("Rescan failed. Try again in a moment.")
                : t("Facebook request failed. Try again in a moment.")}
        </p>
      )}
    </section>
  );
}
