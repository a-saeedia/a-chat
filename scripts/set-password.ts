/**
 * Give an existing account a password.
 *
 * This exists because sign-up deliberately refuses to claim a row that is
 * already in the `User` table. Rows left behind by the removed magic-link
 * provider have no `passwordHash`, so nobody can sign in to them and nothing in
 * the product can set a first password for them. That is the safe failure: an
 * address is not proof of controlling it, and a public form that assumed it was
 * would hand the account to anyone who knew the address. Migrating one is
 * therefore an operator decision made with database access, not a user action.
 *
 * It can also reset a password that is already set, which is destructive and so
 * needs `--force`.
 *
 * Run it against the database you actually intend to change: `DATABASE_URL`
 * decides which one, and this script writes to whatever it is given.
 *
 * The password is read from the environment rather than an argument so it stays
 * out of the repository and out of the process list. Type it at a hidden prompt
 * rather than assigning it literally, because a literal assignment lands in
 * PowerShell history and in any transcript of the session:
 *
 *   $pw = Read-Host "New password" -AsSecureString
 *   $env:A_CHAT_NEW_PASSWORD = [System.Net.NetworkCredential]::new("", $pw).Password
 *   npm run user:set-password -- you@example.com
 *   Remove-Item Env:A_CHAT_NEW_PASSWORD
 *
 * Add `--force` after the email to replace a password that already exists.
 */
import { prisma } from "../lib/db/client";
import { MIN_PASSWORD_LENGTH, hashPassword } from "../lib/password";

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const email = args.find((arg) => !arg.startsWith("--"))?.trim().toLowerCase();

  if (!email) {
    fail(`Usage: npm run user:set-password -- <email>${force ? " --force" : ""}`);
  }

  const password = process.env.A_CHAT_NEW_PASSWORD;
  if (!password) {
    fail(
      "A_CHAT_NEW_PASSWORD is not set. Read it at a hidden prompt so the secret\n" +
        "never reaches shell history, then run this again:\n" +
        '  $pw = Read-Host "New password" -AsSecureString\n' +
        '  $env:A_CHAT_NEW_PASSWORD = [System.Net.NetworkCredential]::new("", $pw).Password\n' +
        "  npm run user:set-password -- you@example.com\n" +
        "  Remove-Item Env:A_CHAT_NEW_PASSWORD"
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, passwordHash: true },
  });

  if (!user) {
    // Deliberately refusing to create: this tool is for accounts that already
    // exist. Creating one here would skip the sign-up allowlist, and a script
    // that can mint an operator account is not something to leave lying around.
    fail(`No account exists for ${email}. Use /signup to create an account.`);
  }

  if (user.passwordHash && !force) {
    fail(
      `${email} already has a password. Re-run with --force to replace it.\n` +
        "The old password stops working at once, but sessions are self-contained\n" +
        "signed JWTs: anyone already signed in stays signed in until their token\n" +
        "expires. A stolen or shared session is not closed by this script."
    );
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password) },
    select: { updatedAt: true },
  });

  console.log(
    `\n  ${user.passwordHash ? "Password reset" : "Password set"} for ${email}.\n` +
      `  Row updated at ${updated.updatedAt.toISOString()}.\n`
  );
}

main()
  .catch((error) => {
    console.error("\n  Failed:", error instanceof Error ? error.message : error, "\n");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
