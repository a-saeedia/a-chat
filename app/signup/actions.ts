"use server";

import { AuthError } from "next-auth";
import { Prisma } from "@/app/generated/prisma/client";
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

  // Every existing row counts as taken, including a passwordless one left
  // behind by the removed magic-link provider. Possession of an address is
  // never proof of controlling it, so letting a sign-up claim such a row would
  // hand the account, its workspace and its Instagram connection to anyone who
  // knew the address. Those accounts are migrated deliberately by an operator
  // with `npm run user:set-password` instead of being won in a public form.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    return { error: t("An account with this email already exists. Sign in instead.") };
  }

  const passwordHash = await hashPassword(password);

  let userId: string;
  try {
    userId = (
      await prisma.user.create({
        data: { name, email, passwordHash },
        select: { id: true },
      })
    ).id;
  } catch (error) {
    // Two sign-ups for one address can both pass the check above, since the row
    // does not exist yet in either. The unique index settles it, and the loser
    // is told the address is taken rather than shown a crash.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { error: t("An account with this email already exists. Sign in instead.") };
    }
    throw error;
  }

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
