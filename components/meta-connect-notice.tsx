"use client";

import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import { useSearchParams } from "next/navigation";

type Tone = "error" | "warning" | "success";

const TONE_CLASSES: Record<Tone, string> = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

const MESSAGES: Record<string, { tone: Tone; title: StaticMessageKey; detail: StaticMessageKey }> = {
  connected: {
    tone: "success",
    title: "Facebook connected",
    detail:
      "Choose which Pages to link below. Each Page can back one Instagram professional account.",
  },
  denied: {
    tone: "warning",
    title: "Facebook connection cancelled",
    detail:
      "You declined the permission prompt. Start again and accept every requested permission — a partial grant cannot read Pages.",
  },
  invalid: {
    tone: "error",
    title: "Facebook connection expired",
    detail:
      "The login link was missing or older than 10 minutes. Click Connect Facebook to start a fresh attempt.",
  },
  forbidden: {
    tone: "error",
    title: "Not permitted",
    detail: "Only workspace owners and admins can connect a Facebook Page.",
  },
  no_pages: {
    tone: "warning",
    title: "No Facebook Pages found",
    detail:
      "The account connected, but it has no Page roles. Ask for a task role on the Page, then rescan.",
  },
};

export function MetaConnectNotice() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const status = searchParams.get("meta");

  if (!status) return null;

  if (status === "misconfigured") {
    const missing = (searchParams.get("missing") ?? "").split(",").filter(Boolean);

    return (
      <Notice tone="error" title={t("Facebook app not configured")}>
        <p>
          {t("Set")}{" "}
          {missing.length > 0
            ? t("these environment variables")
            : t("the required environment variables")}{" "}
          {t("and restart the server:")}
        </p>
        {missing.length > 0 && (
          <ul className="mt-2 space-y-1">
            {missing.map((name) => (
              <li key={name} className="font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          {t("Facebook Login for Business needs")} <span className="font-mono text-xs">META_APP_ID</span>,{" "}
          <span className="font-mono text-xs">META_APP_SECRET</span> {t("and")}{" "}
          <span className="font-mono text-xs">META_LOGIN_CONFIG_ID</span>.
        </p>
      </Notice>
    );
  }

  if (status === "failed") {
    const reason = searchParams.get("reason");

    return (
      <Notice tone="error" title={t("Facebook connection failed")}>
        <p>
          {t("Facebook accepted the login but the connection could not be completed. This is usually a redirect URI that does not match the dashboard, or an app missing required permissions.")}
        </p>
        {reason && (
          <p className="mt-2 font-mono text-xs break-words opacity-80">{reason}</p>
        )}
      </Notice>
    );
  }

  const known = MESSAGES[status];
  if (!known) return null;

  return (
    <Notice tone={known.tone} title={t(known.title)}>
      <p>{t(known.detail)}</p>
    </Notice>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded border p-4 text-sm ${TONE_CLASSES[tone]}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 opacity-90">{children}</div>
    </div>
  );
}
