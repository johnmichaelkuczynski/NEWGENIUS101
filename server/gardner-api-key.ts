import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
let requestTimes: number[] = [];

function secretsMatch(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function withinRateLimit(): boolean {
  const now = Date.now();
  requestTimes = requestTimes.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  if (requestTimes.length >= RATE_LIMIT_MAX) return false;
  requestTimes.push(now);
  return true;
}

export function verifyGardnerApiKey(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.GARDNER_API_KEY?.trim();
  if (!configuredKey) {
    console.error("[Gardner API] GARDNER_API_KEY is not configured");
    return res.status(503).json({ error: "Gardner API is not configured" });
  }

  const authorization = req.headers.authorization;
  const bearerKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : undefined;
  const headerKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : undefined;
  const providedKey = bearerKey || headerKey;

  if (!providedKey) {
    return res.status(401).json({
      error: "Gardner API key required. Send it as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'.",
    });
  }
  if (!secretsMatch(providedKey, configuredKey)) {
    console.log("[Gardner API] Rejected invalid key");
    return res.status(401).json({ error: "Invalid Gardner API key" });
  }
  if (!withinRateLimit()) {
    return res.status(429).json({
      error: `Rate limit exceeded: max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 60000} minutes`,
    });
  }

  console.log(`[Gardner API] Authenticated → ${req.originalUrl}`);
  next();
}