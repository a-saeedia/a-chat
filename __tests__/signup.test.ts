import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSignIn } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  mockSignIn: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// A real class, because the action narrows with `instanceof`. Mocking this as an
// empty object would make every `instanceof` throw and hide the branch under test.
// The constructor mirrors the real signature so the test builds errors the way
// the Prisma client does.
vi.mock("@/app/generated/prisma/client", () => ({
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, options: { code: string; clientVersion: string }) {
        super(message);
        this.code = options.code;
      }
    },
  },
}));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/i18n/server", () => ({
  getI18n: async () => ({ locale: "en", t: (key: string) => key }),
}));
vi.mock("@/lib/env", () => ({ isEmailAllowedToSignIn: vi.fn(() => true) }));
vi.mock("@/lib/workspace", () => ({ ensureWorkspaceForUser: vi.fn() }));
vi.mock("@/lib/password", () => ({
  MIN_PASSWORD_LENGTH: 8,
  hashPassword: vi.fn(async (password: string) => `hashed:${password}`),
}));
vi.mock("@/lib/auth", () => ({
  CREDENTIAL_PROVIDER_ID: "credentials",
  signIn: mockSignIn,
}));

import { Prisma } from "@/app/generated/prisma/client";
import { signUpWithPassword } from "../app/signup/actions";

const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

const valid = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "longenoughpassword",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(null);
  mockPrisma.user.create.mockResolvedValue({ id: "user_1" });
  mockSignIn.mockResolvedValue(undefined);
});

describe("signUpWithPassword", () => {
  it("creates the user, provisions a workspace and signs them in", async () => {
    const state = await signUpWithPassword({}, form(valid));

    expect(state).toEqual({});
    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { name: "Ada Lovelace", email: "ada@example.com", passwordHash: "hashed:longenoughpassword" },
      select: { id: true },
    });
    const { ensureWorkspaceForUser } = await import("@/lib/workspace");
    expect(ensureWorkspaceForUser).toHaveBeenCalledWith("user_1", "ada@example.com");
    expect(mockSignIn).toHaveBeenCalledWith("credentials", {
      email: "ada@example.com",
      password: "longenoughpassword",
      // No callbackUrl in the form, so `sanitizeRedirect` falls back in-app.
      redirectTo: "/dashboard",
    });
  });

  // A `callbackUrl` comes from the query string. Passing it straight through
  // would let a sign-up link hand a brand new session to another origin.
  it("drops an off-site callbackUrl instead of sending the new session there", async () => {
    await signUpWithPassword({}, form({ ...valid, callbackUrl: "https://evil.example" }));

    expect(mockSignIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/dashboard" })
    );
  });

  it("keeps a same-origin callbackUrl", async () => {
    await signUpWithPassword({}, form({ ...valid, callbackUrl: "/dashboard/inbox" }));

    expect(mockSignIn).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/dashboard/inbox" })
    );
  });

  it("normalises the email to lowercase before writing", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await signUpWithPassword({}, form({ ...valid, email: "  Ada@Example.COM " }));

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "ada@example.com" },
      select: { id: true },
    });
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "ada@example.com" }) })
    );
  });

  // The regression this guards: a row left behind by the removed magic-link
  // provider has no password, so it used to be treated as claimable. Possession
  // of the address is not proof of controlling it, and claiming it handed the
  // account plus its workspace to anyone who knew the email.
  it("refuses a passwordless account instead of letting a stranger claim it", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_legacy" });

    const state = await signUpWithPassword({}, form(valid));

    expect(state.error).toBe("An account with this email already exists. Sign in instead.");
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("refuses an account that already has a password", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "user_existing" });

    const state = await signUpWithPassword({}, form(valid));

    expect(state.error).toBe("An account with this email already exists. Sign in instead.");
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("reports a taken address when two sign-ups race the unique index", async () => {
    // Built as a real instance, not a plain object with a `code` property: the
    // production branch is `instanceof Prisma.PrismaClientKnownRequestError`, so
    // a duck-typed error would fall through to `throw` and fail the test for the
    // wrong reason.
    const uniqueViolation = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`email`)",
      { code: "P2002", clientVersion: "test" }
    );
    mockPrisma.user.create.mockRejectedValue(uniqueViolation);

    const state = await signUpWithPassword({}, form(valid));

    expect(state.error).toBe("An account with this email already exists. Sign in instead.");
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("does not swallow an unexpected database failure", async () => {
    mockPrisma.user.create.mockRejectedValue(new Error("connection reset"));

    await expect(signUpWithPassword({}, form(valid))).rejects.toThrow("connection reset");
  });

  it("rejects a password shorter than the minimum before touching the database", async () => {
    const state = await signUpWithPassword({}, form({ ...valid, password: "short" }));

    expect(state.error).toBe("Use at least {count} characters.");
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a malformed email before touching the database", async () => {
    const state = await signUpWithPassword({}, form({ ...valid, email: "not-an-email" }));

    expect(state.error).toBe("Enter a valid email address.");
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a blocked address without writing a row", async () => {
    const { isEmailAllowedToSignIn } = await import("@/lib/env");
    vi.mocked(isEmailAllowedToSignIn).mockReturnValueOnce(false);

    const state = await signUpWithPassword({}, form(valid));

    expect(state.error).toBe("Sign-up is not allowed for this email address.");
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("reports a failed automatic sign-in instead of appearing to do nothing", async () => {
    const { AuthError } = await import("next-auth");
    mockSignIn.mockRejectedValueOnce(new AuthError("bad"));

    const state = await signUpWithPassword({}, form(valid));

    expect(state.error).toBe("Account created, but automatic sign-in failed. Try signing in.");
  });

  it("rethrows a redirect so the successful navigation is not swallowed", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    mockSignIn.mockRejectedValueOnce(redirect);

    await expect(signUpWithPassword({}, form(valid))).rejects.toBe(redirect);
  });
});
