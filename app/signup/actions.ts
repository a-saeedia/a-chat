"use server";

import { AuthError } from "next-auth";
import { prisma } from "@/lib/db/client";
import { CREDENTIAL_PROVIDER_ID, signIn } from "@/lib/auth";
import { EMAIL_RE, sanitizeRedirect } from "@/lib/auth-forms";
import { isEmailAllowedToSignIn } from "@/lib/env";
import { getI18n } from "@/lib/i18n/server";
import { MIN_PASSWORD_LENGTH, hashPassword } from "@/lib/password";
import { ensureWorkspaceForUser } from "@/lib/workspace";

export type SignUpState = { error?: string };

/**
 * Create an account from a name, an email and a password, then sign the new
 * user straight in.
 *
 * The account is written here rather than by the auth adapter: the Credentials
 * provider never creates users, so this action owns that step and is the only
 * place a `passwordHash` is ever set.
 */
export async function signUpWithPassword(
  _prevState: SignUpState,
  formData: FormData
): Promise<SignUpState> {
  const { t } = await getI18n();

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const callbackUrl = sanitizeRedirect(formData.get("callbackUrl")?.toString());

  if (!name) {
    return { error: t("Enter your name.") };
  }
  if (!EMAIL_RE.test(email)) {
    return { error: t("Enter a valid email address.") };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: t("Use at least {count} characters.", { count: MIN_PASSWORD_LENGTH }),
    };
  }
  // Refused before anything is written, so a blocked address leaves no row.
  if (!isEmailAllowedToSignIn(email)) {
    return { error: t("Sign-up is not allowed for this email address.") };
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Only an account that already has a password is genuinely taken. One
  // without a hash cannot be signed into at all, so this email owns it and is
  // allowed to claim it rather than be locked out by a row it never set a
  // password on.
  if (existing?.passwordHash) {
    return { error: t("An account with this email already exists. Sign in instead.") };
  }

  const passwordHash = await hashPassword(password);

  const userId = existing
    ? (
        await prisma.user.update({
          where: { id: existing.id },
          data: { name, passwordHash },
          select: { id: true },
        })
      ).id
    : (
        await prisma.user.create({
          data: { name, email, passwordHash },
          select: { id: true },
        })
      ).id;

  // Every user needs a workspace, and the Credentials provider fires no
  // createUser event to make one, so it is made explicitly here.
  await ensureWorkspaceForUser(userId, email);

  try {
    await signIn(CREDENTIAL_PROVIDER_ID, { email, password, redirectTo: callbackUrl });
  } catch (error) {
    if (error instanceof AuthError) {
      // The credentials were just written, so this is not a wrong-password
      // case. Report it and send the user to sign in rather than leave them on
      // a form that appears to have done nothing.
      return { error: t("Account created, but automatic sign-in failed. Try signing in.") };
    }
    throw error;
  }

  return {};
}
