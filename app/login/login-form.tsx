"use client";

import { useActionState } from "react";
import type { LoginFormLabels } from "@/lib/auth-forms";
import { logInWithPassword } from "./actions";

const inputClass =
  "w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors";

const labelClass = "block text-sm font-medium text-foreground";

/**
 * The sign-in form. Labels arrive already translated from the server page:
 * `useI18n()` has no provider above this tree and would fall back to English.
 */
export function LoginForm({
  callbackUrl,
  labels,
}: {
  callbackUrl: string;
  labels: LoginFormLabels;
}) {
  const [state, formAction, pending] = useActionState(logInWithPassword, {});

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

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
          autoComplete="current-password"
          className={inputClass}
        />
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
        {pending ? labels.signInPending : labels.signIn}
      </button>
    </form>
  );
}
