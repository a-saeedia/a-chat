import { redirect } from "next/navigation";

/**
 * Magic links are gone: sign-in is an email and a password at /login. Nothing
 * is left to verify, so this route only exists so that a bookmarked or
 * already-emailed link still lands somewhere real instead of a 404.
 */
export default function VerifyRequestPage() {
  redirect("/login");
}
