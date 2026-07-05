import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { storage } from "./storage";

const ADMIN_EMAIL = "johnmichaelkuczynski@gmail.com";

function getBaseUrl(req: Request): string {
  const host = req.get("host");
  return `https://${host}`;
}

function getRedirectUri(req: Request): string {
  return `${getBaseUrl(req)}/api/auth/google/callback`;
}

export function isAdmin(req: any): boolean {
  return (
    req.session?.authProvider === "google" &&
    typeof req.session?.email === "string" &&
    req.session.email.toLowerCase() === ADMIN_EMAIL
  );
}

export function setupGoogleAuth(app: Express) {
  // Step 1: redirect the browser to Google's consent screen
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

    console.log(`[Google Auth] Login initiated, redirecting to Google (redirect_uri=${getRedirectUri(req)})`);
    req.session.save(() => {
      res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    });
  });

  // Step 2: Google redirects back with a code; exchange it for tokens
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
        console.error("[Google Auth] State mismatch — possible CSRF");
        return res.redirect("/?login_error=state_mismatch");
      }
      delete req.session.oauthState;

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return res.status(500).send("Google OAuth credentials are not configured");
      }

      // Exchange authorization code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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

      // Fetch the user's profile
      const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
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

      // Upsert the user record
      await storage.upsertUser({
        id: userId,
        email,
        firstName: profile.given_name || null,
        lastName: profile.family_name || null,
        profileImageUrl: profile.picture || null,
      });

      // Record the login for admin analytics
      await storage.recordLogin(email);

      // Establish the session
      req.session.userId = userId;
      req.session.username = email;
      req.session.email = email;
      req.session.authProvider = "google";

      console.log(`[Google Auth] Login successful, session created for ${email} (userId=${userId})`);

      req.session.save(() => {
        res.redirect("/");
      });
    } catch (err) {
      console.error("[Google Auth] Callback error:", err);
      res.redirect("/?login_error=internal_error");
    }
  });

  // Logout: destroy the session entirely
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

  // Admin analytics — only for the admin email
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
