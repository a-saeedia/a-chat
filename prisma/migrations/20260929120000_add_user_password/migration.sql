-- Sign-in moved from emailed magic links to email + password. The password is
-- stored as a scrypt hash produced by lib/password.ts, so the column is plain
-- text and nullable: existing rows keep working, and an account that has no
-- hash simply cannot sign in with one until a password is set.
--
-- ADD COLUMN IF NOT EXISTS keeps this file safe to re-run, matching the
-- convention in 20260917160000_tracked_link_position.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
