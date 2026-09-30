"use server";

import { AuthError } from "next-auth";
import { CREDENTIAL_PROVIDER_ID, signIn } from "@/lib/auth";
import { sanitizeRedirect } from "@/lib/auth-forms";
import { getI18n } from "@/lib/i18n/server";

export type LoginState = { error?: string };

/**
 * Sign in with an email and a password.
 *
 * `useActionState` passes the previous state as the first argument; it is
 * unused here because every failure reports the same generic message.
 *
 * A wrong email and a wrong password are answered identically. Saying which
 * one was wrong would turn this form into a way to discover who has an
 * account, so the distinction is dropped on purpose even though the
 * `authorize` callback does know it.
 */
export async function logInWithPassword(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const { t } = await getI18n();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const callbackUrl = sanitizeRedirect(formData.get("callbackUrl")?.toString());

  if (!email || !password) {
    return { error: t("Enter your email and password.") };
  }

  try {
    // On success this redirects by throwing NEXT_REDIRECT, which must not be
    // caught below — only AuthError is.
    await signIn(CREDENTIAL_PROVIDER_ID, { email, password, redirectTo: callbackUrl });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: t("Incorrect email or password.") };
    }
    throw error;
  }

  return {};
}
