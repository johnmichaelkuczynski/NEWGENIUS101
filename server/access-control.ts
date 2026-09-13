import { createHash, timingSafeEqual } from "node:crypto";

const PERMANENT_OWNER_EMAIL_SHA256 =
  "fda68b8a25c292d62e6b7830208f60ed2f31fde9e16c056527e93ecc0e92935f";

type AuthenticatedUser = {
  email?: string | null;
  googleId?: string | null;
} | null | undefined;

function normalizedEmailHash(email: string): Buffer {
  return createHash("sha256").update(email.trim().toLowerCase()).digest();
}

export function isPermanentOwner(user: AuthenticatedUser): boolean {
  if (!user?.googleId || !user.email) return false;
  const actual = normalizedEmailHash(user.email);
  const expected = Buffer.from(PERMANENT_OWNER_EMAIL_SHA256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hasHighestTierAccess(
  user: AuthenticatedUser,
  storedFullAccess = false,
): boolean {
  return isPermanentOwner(user) || storedFullAccess;
}