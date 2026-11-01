import express, { type Request, Response, NextFunction } from "express";
import { clientRoutes, setupVite, serveStatic, log } from "./vite";
import { createServer } from "node:http";
import { registerStartupHealth, logEnvironmentPresence } from "./startup-health";
import path from "path";
import fs from "fs";
import cors from "cors";

const app = express();          // create the app first
const production = process.env.NODE_ENV === "production";
registerStartupHealth(app, production);
logEnvironmentPresence();
const server = createServer(app);
let ready = false;
if (production) {
  app.use((_req, res, next) => {
    if (ready) return next();
    res.status(503).json({ error: "Application services are starting or unavailable" });
  });
}
app.use(cors());                // then enable CORS middleware

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "20mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: false, limit: "20mb" }));


app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const { registerRoutes } = await import("./routes");
  const { ensureApiKeysTable } = await import("./db");
  // Database bootstrap must not delay the homepage or prevent the server listening.
  void ensureApiKeysTable().catch((error) => {
    console.error("[startup] API-key table initialization failed", { code: error?.code || "DATABASE_UNAVAILABLE" });
  });
  await registerRoutes(app, server);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    console.error("[request] Request failed", { path: _req.path, status, code: err.code || "REQUEST_ERROR" });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    const clientPath = path.join(process.cwd(), "dist", "public");

    if (fs.existsSync(clientPath)) {
      log(`Serving static files from: ${clientPath}`);
      app.use(express.static(clientPath));

      app.get(clientRoutes, (_req, res) => {
        res.sendFile(path.join(clientPath, "index.html"));
      });

      app.get("*", (_req, res) => {
        res
          .status(404)
          .type("html")
          .send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\"><title>Page not found | Genius 101</title></head><body><main><h1>Page not found</h1><p>The page you requested does not exist.</p><a href=\"/\">Return to Genius 101</a></main></body></html>");
      });
    } else {
      log(`Warning: ${clientPath} not found, falling back to default`);
      serveStatic(app);
    }
  }
  ready = true;
  if (!production) listen();
})().catch((error) => {
  console.error("[startup] Application services failed to initialize", { code: error?.code || "INITIALIZATION_FAILED", name: error?.name });
  if (!production) process.exitCode = 1;
});


  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
function listen() {
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
}
if (production) listen();
