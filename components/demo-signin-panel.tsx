import { getI18n } from "@/lib/i18n/server";

const GITHUB_URL = "https://github.com/a-saeedia/a-chat";
const SETUP_DOCS_URL = `${GITHUB_URL}/blob/main/docs/setup.md`;

/**
 * Stands in for the auth forms on the public demo host, where accounts are not
 * real. Shared by /login and /signup so the two cannot drift apart — the
 * caller decides whether the host is a demo and renders this instead.
 */
export async function DemoSignInPanel() {
  const { t } = await getI18n();

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-foreground">
          A Chat
        </h1>
        <div className="panel rounded p-8 mt-8 shadow-black/40">
          <h2 className="text-lg font-semibold text-foreground">
            {t("Sign-in is off on this demo")}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            {t("This is the public demo — it doesn’t create real accounts or send DMs. To use A Chat for real, clone it and run your own instance with your own Meta app and domain.")}
          </p>
          <a
            href={SETUP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30"
          >
            {t("Clone it yourself")} <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}
