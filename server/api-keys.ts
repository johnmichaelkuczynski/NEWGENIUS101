import { Request, Response, NextFunction } from "express";
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "./db";
import { apiKeys, type ApiKey } from "@shared/schema";

/**
 * API key system for external apps calling the public Kuczynski API.
 *
 * Keys look like: gk_<48 hex chars>. Only a sha256 hash is stored in the
 * database — the raw key is shown once at creation time.
 *
 * Callers authenticate with either:
 *   Authorization: Bearer gk_...
 *   X-API-Key: gk_...
 */

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = "gk_" + randomBytes(24).toString("hex");
  return {
    rawKey,
    keyHash: hashKey(rawKey),
    keyPrefix: rawKey.slice(0, 10), // e.g. "gk_a1b2c3d"
  };
}

export async function createApiKey(label: string): Promise<{ rawKey: string; record: ApiKey }> {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  const [record] = await db
    .insert(apiKeys)
    .values({ keyHash, keyPrefix, label })
    .returning();
  return { rawKey, record };
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return db.select().from(apiKeys).orderBy(apiKeys.createdAt);
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revoked: true })
    .where(eq(apiKeys.id, id))
    .returning({ id: apiKeys.id });
  return result.length > 0;
}

// Simple in-memory per-key rate limiting: max requests per rolling window
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const rateBuckets = new Map<number, number[]>();
const GENIUS_API_KEY_BUCKET_ID = -1;

function checkRateLimit(keyId: number): boolean {
  const now = Date.now();
  const bucket = (rateBuckets.get(keyId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(keyId, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(keyId, bucket);
  return true;
}

function secretsMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

/** Express middleware: require a valid, non-revoked API key. */
export async function verifyApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    let rawKey: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      rawKey = authHeader.slice(7).trim();
    }
    if (!rawKey && typeof req.headers["x-api-key"] === "string") {
      rawKey = (req.headers["x-api-key"] as string).trim();
    }

    if (!rawKey) {
      return res.status(401).json({
        error: "API key required. Send it as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
      });
    }

    // GENIUS_API_KEY is the shared credential for the owner's other apps.
    // It remains in Replit Secrets and is never stored in the database.
    const geniusApiKey = process.env.GENIUS_API_KEY?.trim();
    if (geniusApiKey && secretsMatch(rawKey, geniusApiKey)) {
      if (!checkRateLimit(GENIUS_API_KEY_BUCKET_ID)) {
        console.log("[API Key] Rate limited \"GENIUS_API_KEY\"");
        return res.status(429).json({ error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 60000} minutes` });
      }

      (req as any).apiKey = { id: GENIUS_API_KEY_BUCKET_ID, label: "GENIUS_API_KEY" };
      console.log(`[API Key] Authenticated "GENIUS_API_KEY" → ${req.originalUrl}`);
      return next();
    }

    const keyHash = hashKey(rawKey);
    const [record] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);

    if (!record || record.revoked) {
      console.log("[API Key] Rejected: invalid or revoked key");
      return res.status(401).json({ error: "Invalid or revoked API key" });
    }

    if (!checkRateLimit(record.id)) {
      console.log(`[API Key] Rate limited "${record.label}"`);
      return res.status(429).json({ error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 60000} minutes` });
    }

    // Fire-and-forget usage tracking
    db.update(apiKeys)
      .set({ lastUsedAt: new Date(), requestCount: sql`${apiKeys.requestCount} + 1` })
      .where(eq(apiKeys.id, record.id))
      .then(() => {})
      .catch((err) => console.warn("[API Key] usage update failed:", err.message));

    (req as any).apiKey = record;
    console.log(`[API Key] Authenticated "${record.label}" → ${req.originalUrl}`);
    next();
  } catch (err) {
    console.error("[API Key] Verification error:", err);
    res.status(500).json({ error: "Authentication error" });
  }
}
