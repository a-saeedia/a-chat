"use client";

import { useActionState } from "react";
import type { SignUpFormLabels } from "@/lib/auth-forms";
import { signUpWithPassword } from "./actions";

const inputClass =
  "w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors";

const labelClass = "block text-sm font-medium text-foreground";

/**
 * The sign-up form. Labels and the password hint arrive already translated
 * from the server page, which is where `getI18n()` can actually run.
 */
export function SignUpForm({
  callbackUrl,
  passwordHint,
  labels,
}: {
  callbackUrl: string;
  passwordHint: string;
  labels: SignUpFormLabels;
}) {
  const [state, formAction, pending] = useActionState(signUpWithPassword, {});

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      <div className="space-y-2">
        <label htmlFor="name" className={labelClass}>
          {labels.name}
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoComplete="name"
          placeholder="Ada Lovelace"
          className={inputClass}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="email" className={labelClass}>
          {labels.email}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className={inputClass}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className={labelClass}>
          {labels.password}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          className={inputClass}
        />
        <p className="text-xs text-muted">{passwordHint}</p>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-error">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30 disabled:opacity-60"
      >
        {pending ? labels.createAccountPending : labels.createAccount}
      </button>
    </form>
  );
}
