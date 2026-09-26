import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();
export const clientRoutes = [
  "/",
  "/v2",
  "/diagnostics",
  "/admin",
  "/model-builder",
  "/paper-writer",
] as const;

function sendNotFound(res: express.Response) {
  res
    .status(404)
    .type("html")
    .send("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\"><title>Page not found | Genius 101</title></head><body><main><h1>Page not found</h1><p>The page you requested does not exist.</p><a href=\"/\">Return to Genius 101</a></main></body></html>");
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.get(clientRoutes, async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

  app.get("*", (req, res, next) => {
    if (
      !path.extname(req.path) &&
      !req.path.startsWith("/@") &&
      !req.path.startsWith("/src/")
    ) {
      sendNotFound(res);
      return;
    }
    next();
  });

  app.use(vite.middlewares);
  app.get("*", (_req, res) => sendNotFound(res));
}

export function serveStatic(app: Express) {
  const clientPath = path.join(process.cwd(), "dist", "public");

  app.use(express.static(clientPath));

  app.get(clientRoutes, (_req, res) => {
    res.sendFile(path.join(clientPath, "index.html"));
  });

  app.get("*", (_req, res) => sendNotFound(res));
}

