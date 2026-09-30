import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { DemoNotice } from "@/components/demo-notice";
import { DemoSignInPanel } from "@/components/demo-signin-panel";
import { isPublicDemoHost } from "@/lib/env";
import { sanitizeRedirect } from "@/lib/auth-forms";
import { MIN_PASSWORD_LENGTH } from "@/lib/password";
import { SignUpForm } from "./signup-form";

export async function generateMetadata() {
  const { t } = await getI18n();
  return {
    title: t("Create account - A Chat"),
    description: t("Create your A Chat account."),
  };
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  const { t } = await getI18n();

  if (await isPublicDemoHost()) {
    return <DemoSignInPanel />;
  }

  const params = await searchParams;
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = sanitizeRedirect(
    params.callbackUrl ?? templateCallbackUrl,
    "/dashboard"
  );

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            A Chat
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {t("Sign in by email, then connect your Instagram professional account.")}
          </p>
        </div>

        <DemoNotice variant="panel" />

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && (
            <div className="mb-5 border border-accent/20 bg-accent/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                {t("Template selected")}
              </p>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          <h2 className="text-lg font-semibold text-foreground mb-5">
            {t("Create your account")}
          </h2>

          <SignUpForm
            callbackUrl={callbackUrl}
            passwordHint={t("At least {count} characters.", {
              count: MIN_PASSWORD_LENGTH,
            })}
            labels={{
              name: t("Name"),
              email: t("Work email"),
              password: t("Password"),
              createAccount: t("Create account"),
              createAccountPending: t("Creating account..."),
            }}
          />

          <p className="mt-6 text-sm text-muted text-center">
            {t("Already have an account?")}{" "}
            <Link href="/login" className="text-accent hover:underline">
              {t("Sign in")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
