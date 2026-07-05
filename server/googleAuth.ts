import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { storage } from "./storage";

// ============================================================
// Clean Google-only OAuth (authorization-code flow, no libraries)
// Routes: GET /api/auth/google, GET /api/auth/google/callback,
//         POST /api/logout, GET /api/admin/logins
// Secrets used: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
// ============================================================

const ADMIN_EMAIL = "johnmichaelkuczynski@gmail.com";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

function getRedirectUri(req: Request): string {
  return `https://${req.get("host")}/api/auth/google/callback`;
}

export function isAdmin(req: any): boolean {
  return (
    req.session?.authProvider === "google" &&
    typeof req.session?.email === "string" &&
    req.session.email.toLowerCase() === ADMIN_EMAIL
  );
}

// Ensure login-tracking tables exist (startup-safe DDL; production shares the same DB)
async function ensureLoginTables(): Promise<void> {
  const { db } = await import("./db");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`CREATE TABLE IF NOT EXISTS login_records (
    email varchar PRIMARY KEY,
    first_visit timestamp NOT NULL DEFAULT now(),
    last_visit timestamp NOT NULL DEFAULT now(),
    visit_count integer NOT NULL DEFAULT 1
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS login_events (
    id serial PRIMARY KEY,
    email varchar NOT NULL,
    logged_in_at timestamp NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_login_events_time" ON login_events (logged_in_at)`);
}

export function setupGoogleAuth(app: Express) {
  ensureLoginTables()
    .then(() => console.log("[Google Auth] login_records/login_events tables verified"))
    .catch((err) => console.error("[Google Auth] FAILED to ensure login tables:", err));

  // ---- Step 1: send the browser to Google's consent screen ----
  app.get("/api/auth/google", (req: any, res: Response) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(500).send("GOOGLE_CLIENT_ID is not configured");
    }

    const state = crypto.randomBytes(24).toString("hex");
    req.session.oauthState = state;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getRedirectUri(req),
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });

    console.log(
      `[Google Auth] /api/auth/google hit — redirecting to Google (redirect_uri=${getRedirectUri(req)})`,
    );
    req.session.save(() => {
      res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
    });
  });

  // ---- Step 2: Google redirects back; exchange code for tokens ----
  app.get("/api/auth/google/callback", async (req: any, res: Response) => {
    try {
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        console.error(`[Google Auth] Google returned error: ${error}`);
        return res.redirect("/?login_error=" + encodeURIComponent(error));
      }
      if (!code) {
        return res.redirect("/?login_error=missing_code");
      }
      if (!state || state !== req.session.oauthState) {
        console.error("[Google Auth] State mismatch — possible CSRF, login rejected");
        return res.redirect("/?login_error=state_mismatch");
      }
      delete req.session.oauthState;

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return res.status(500).send("Google OAuth credentials are not configured");
      }

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: getRedirectUri(req),
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error(`[Google Auth] Token exchange failed (${tokenRes.status}): ${body}`);
        return res.redirect("/?login_error=token_exchange_failed");
      }

      const tokens = (await tokenRes.json()) as { access_token: string };

      const profileRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!profileRes.ok) {
        console.error(`[Google Auth] Userinfo fetch failed (${profileRes.status})`);
        return res.redirect("/?login_error=userinfo_failed");
      }

      const profile = (await profileRes.json()) as {
        sub: string;
        email?: string;
        email_verified?: boolean;
        given_name?: string;
        family_name?: string;
        picture?: string;
      };

      if (!profile.email) {
        return res.redirect("/?login_error=no_email");
      }
      if (profile.email_verified !== true) {
        console.error(`[Google Auth] Rejected unverified email: ${profile.email}`);
        return res.redirect("/?login_error=email_not_verified");
      }

      const email = profile.email.toLowerCase();
      const userId = `google_${profile.sub}`;

      await storage.upsertUser({
        id: userId,
        email,
        firstName: profile.given_name || null,
        lastName: profile.family_name || null,
        profileImageUrl: profile.picture || null,
      });

      // Record login for admin analytics (first visit, last visit, count, timestamps)
      await storage.recordLogin(email);

      req.session.userId = userId;
      req.session.username = email;
      req.session.email = email;
      req.session.authProvider = "google";

      console.log(
        `[Google Auth] /api/auth/google/callback SUCCESS — session created for ${email} (userId=${userId})`,
      );

      req.session.save(() => {
        res.redirect("/");
      });
    } catch (err) {
      console.error("[Google Auth] Callback error:", err);
      res.redirect("/?login_error=internal_error");
    }
  });

  // ---- Logout: destroy the session ----
  app.post("/api/logout", (req: any, res: Response) => {
    const email = req.session?.email;
    req.session.destroy((err: any) => {
      if (err) {
        console.error("[Google Auth] Logout error:", err);
        return res.status(500).json({ error: "Failed to log out" });
      }
      res.clearCookie("connect.sid");
      console.log(`[Google Auth] Logged out ${email || "(anonymous)"}`);
      res.json({ success: true });
    });
  });

  // ---- Admin analytics: ONLY johnmichaelkuczynski@gmail.com ----
  app.get("/api/admin/logins", async (req: any, res: Response) => {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      const [records, analytics] = await Promise.all([
        storage.getLoginRecords(),
        storage.getLoginAnalytics(),
      ]);
      res.json({ records, ...analytics });
    } catch (err) {
      console.error("[Admin] Failed to load login analytics:", err);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });
}
