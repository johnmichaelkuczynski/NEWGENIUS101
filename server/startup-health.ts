import type { Express } from "express";
import path from "node:path";
import fs from "node:fs";

export const productionIndex = path.resolve(process.cwd(), "dist/public/index.html");

// These routes deliberately precede sessions, authentication, and database work.
export function registerStartupHealth(app: Express, production: boolean) {
  app.get("/healthz", (_req, res) => res.status(200).type("text").send("ok"));
  if (production) {
    app.get("/", (_req, res) => {
      res.sendFile(productionIndex, (error) => {
        if (!error) return;
        console.error("[startup] Homepage could not be served", { code: (error as NodeJS.ErrnoException).code });
        if (!res.headersSent) res.status(503).type("text").send("Application build unavailable");
      });
    });
    console.log(`[startup] dist/public/index.html: ${fs.existsSync(productionIndex) ? "present" : "MISSING"}`);
  }
}

export function logEnvironmentPresence() {
  const present = (name: string) => Boolean(process.env[name]?.trim());
  const groups = {
    database: ["EXTERNAL_DATABASE_URL", "DATABASE_URL"],
    session: ["SESSION_SECRET"],
    googleClient: ["GOOGLE_LOGIN_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_CLIENT_ID"],
    googleSecret: ["GOOGLE_LOGIN_CLIENT_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
    generationProvider: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "GROK_API_KEY", "PERPLEXITY_API_KEY", "VENICE_API_KEY"],
  };
  for (const [group, keys] of Object.entries(groups)) {
    console.log(`[startup] ${group}: ${keys.some(present) ? "configured" : `MISSING (${keys.join(" or ")})`}`);
  }
  const keys = [
    ...`ADAM_SMITH ADLER AESOP ALLEN ARISTOTLE BACON BERGLER BERGSON BERKELEY CONFUCIUS DARWIN DESCARTES DEWEY DWORKIN EMMA_GOLDMAN ENGELS FREUD GALILEO GARDNER GENIUS HEGEL HOBBES HUME JUNG KANT KERNBERG KUCZYNSKI LAPLACE LA_ROCHEFOUCAULD LEBON LEIBNIZ LOCKE LUTHER MACHIAVELLI MAIMONIDES MARDEN MARX MILL NIETZSCHE PARADOXES PEIRCE PLATO POINCARE POPPER ROUSSEAU RUSSELL SARTRE SCHOPENHAUER SPENCER STEKEL TOCQUEVILLE VEBLEN WEYL WHEWELL WILLIAM_JAMES ANTHROPIC OPENAI GEMINI DEEPSEEK GROK PERPLEXITY VENICE ELEVENLABS ASSEMBLYAI`.split(" ").map((name) => `${name}_API_KEY`),
    "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "ZHI_PRIVATE_KEY",
  ];
  const missing = keys.filter((name) => !present(name));
  console.log(`[startup] API credentials missing (affected features unavailable): ${missing.join(", ") || "none"}`);
}
