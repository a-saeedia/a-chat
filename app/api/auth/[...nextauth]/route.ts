/**
 * NextAuth.js v5 — Auth Route Handler
 *
 * Uses the shared auth config from lib/auth.ts
 */

import { handlers } from "@/lib/auth";

// The Credentials provider hashes and verifies passwords with node:crypto
// (scrypt), which is not available on the edge runtime. Pinned explicitly
// rather than left to the default.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
