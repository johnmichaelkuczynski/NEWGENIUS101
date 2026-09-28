import { timingSafeEqual } from "crypto";
import type { Express, NextFunction, Request, Response } from "express";
import OpenAI from "openai";
import { z } from "zod";
import { storage } from "./storage";
import { getArgumentsForThinker, searchPhilosophicalChunks, searchTextChunks } from "./vector-search";
import { registerKuczynskiCorpusRoutes } from "./kuczynski-corpus-api";

export const REMAINING_THINKER_API_REGISTRY = [
  ["kuczynski", "J.-M. Kuczynski", "KUCZYNSKI_API_KEY"],
  ["galileo", "Galileo", "GALILEO_API_KEY"],
  ["bacon", "Francis Bacon", "BACON_API_KEY"],
  ["bergler", "Edmund Bergler", "BERGLER_API_KEY"],
  ["freud", "Sigmund Freud", "FREUD_API_KEY"],
  ["james", "William James", "WILLIAM_JAMES_API_KEY"],
  ["leibniz", "Gottfried Wilhelm Leibniz", "LEIBNIZ_API_KEY"],
  ["le_bon", "Gustave Le Bon", "LEBON_API_KEY"],
  ["kant", "Immanuel Kant", "KANT_API_KEY"],
  ["bergson", "Henri Bergson", "BERGSON_API_KEY"],
  ["popper", "Karl Popper", "POPPER_API_KEY"],
  ["machiavelli", "Niccolò Machiavelli", "MACHIAVELLI_API_KEY"],
  ["hume", "David Hume", "HUME_API_KEY"],
  ["locke", "John Locke", "LOCKE_API_KEY"],
  ["la_rochefoucauld", "François de La Rochefoucauld", "LA_ROCHEFOUCAULD_API_KEY"],
  ["dewey", "John Dewey", "DEWEY_API_KEY"],
  ["descartes", "René Descartes", "DESCARTES_API_KEY"],
  ["hegel", "G.W.F. Hegel", "HEGEL_API_KEY"],
  ["hobbes", "Thomas Hobbes", "HOBBES_API_KEY"],
  ["berkeley", "George Berkeley", "BERKELEY_API_KEY"],
  ["veblen", "Thorstein Veblen", "VEBLEN_API_KEY"],
  ["rousseau", "Jean-Jacques Rousseau", "ROUSSEAU_API_KEY"],
  ["mill", "John Stuart Mill", "MILL_API_KEY"],
  ["engels", "Friedrich Engels", "ENGELS_API_KEY"],
  ["spencer", "Herbert Spencer", "SPENCER_API_KEY"],
  ["adler", "Alfred Adler", "ADLER_API_KEY"],
  ["peirce", "Charles Sanders Peirce", "PEIRCE_API_KEY"],
  ["maimonides", "Moses Maimonides", "MAIMONIDES_API_KEY"],
  ["luther", "Martin Luther", "LUTHER_API_KEY"],
  ["whewell", "William Whewell", "WHEWELL_API_KEY"],
  ["tocqueville", "Alexis de Tocqueville", "TOCQUEVILLE_API_KEY"],
  ["aesop", "Aesop", "AESOP_API_KEY"],
  ["stekel", "Wilhelm Stekel", "STEKEL_API_KEY"],
  ["poincare", "Henri Poincaré", "POINCARE_API_KEY"],
  ["allen", "ALLEN", "ALLEN_API_KEY"],
  ["jung", "Carl Jung", "JUNG_API_KEY"],
  ["dworkin", "Andrea Dworkin", "DWORKIN_API_KEY"],
  ["kernberg", "Otto Kernberg", "KERNBERG_API_KEY"],
  ["laplace", "Pierre-Simon Laplace", "LAPLACE_API_KEY"],
  ["marx", "Karl Marx", "MARX_API_KEY"],
  ["schopenhauer", "Arthur Schopenhauer", "SCHOPENHAUER_API_KEY"],
  ["weyl", "Hermann Weyl", "WEYL_API_KEY"],
] as const;

type ThinkerApiConfig = typeof REMAINING_THINKER_API_REGISTRY[number];
const requestSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(8_000),
  })).max(20).optional(),
  maxWords: z.coerce.number().int().min(50).max(5_000).optional(),
  quotes: z.coerce.number().int().min(0).max(20).optional(),
  stream: z.boolean().optional(),
});

function matchesSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createThinkerKeyMiddleware(config: ThinkerApiConfig, maxRequests = 30) {
  let requestTimes: number[] = [];
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env[config[2]]?.trim();
    if (!expected) return res.status(503).json({ error: `${config[1]} API is not configured` });
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim() : undefined;
    const header = typeof req.headers["x-api-key"] === "string"
      ? req.headers["x-api-key"].trim() : undefined;
    if (!bearer && !header) return res.status(401).json({ error: `${config[1]} API key required` });
    if (!matchesSecret(bearer || header || "", expected)) {
      return res.status(401).json({ error: `Invalid ${config[1]} API key` });
    }
    const now = Date.now();
    requestTimes = requestTimes.filter((time) => now - time < 5 * 60_000);
    if (requestTimes.length >= maxRequests) {
      return res.status(429).json({ error: `Rate limit exceeded: max ${maxRequests} requests per 5 minutes` });
    }
    requestTimes.push(now);
    next();
  };
}

function getCompletionClient(): { client: OpenAI; model: string } | null {
  if (process.env.GEMINI_API_KEY) {
    return { client: new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }), model: "gemini-3.6-flash" };
  }
  if (process.env.PERPLEXITY_API_KEY) {
    return { client: new OpenAI({ apiKey: process.env.PERPLEXITY_API_KEY, baseURL: "https://api.perplexity.ai" }), model: "sonar" };
  }
  if (process.env.OPENAI_API_KEY) return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), model: "gpt-4o" };
  return null;
}

async function handleThinkerRequest(config: ThinkerApiConfig, req: Request, res: Response) {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { message, history = [], stream = false } = parsed.data;
  const targetWords = parsed.data.maxWords ?? 750;
  const targetQuotes = parsed.data.quotes ?? 0;
  const figure = await storage.getThinker(config[0]);
  if (!figure) return res.status(500).json({ error: `${config[1]} figure is not available` });

  const [embeddings, textChunks, argumentsContext] = await Promise.all([
    searchPhilosophicalChunks(message, 6, config[0], config[1]),
    searchTextChunks(config[1], message, 6),
    getArgumentsForThinker(config[1], message, 40),
  ]);
  let grounding = `\n\n--- ${config[1].toUpperCase()} WRITINGS ---\n`;
  for (const chunk of embeddings) grounding += `${chunk.content}\n\n`;
  for (const chunk of textChunks) grounding += `${chunk.chunkText}\n\n`;
  grounding += `--- END ${config[1].toUpperCase()} WRITINGS ---\n`;
  const quoteInstruction = targetQuotes ? ` Include at least ${targetQuotes} verbatim quotes from the supplied writings.` : "";
  const system = `${figure.systemPrompt}${argumentsContext}${grounding}\nAnswer only as ${config[1]}, grounding claims in the supplied writings where relevant. Target approximately ${targetWords} words.${quoteInstruction} Plain text only.`;
  const historyText = history.map((item) => `${item.role === "user" ? "Interlocutor" : config[1]}: ${item.content}`).join("\n\n");
  const user = historyText ? `[Conversation so far]\n${historyText}\n\n[Current message]\n${message}` : message;
  const completion = getCompletionClient();
  if (!completion) return res.status(503).json({ error: "No language-model provider is configured" });
  const params = { model: completion.model, messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: user }], max_tokens: Math.min(Math.max(targetWords * 2, 1000), 16_000), temperature: 0.7 };
  if (stream) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const result = await completion.client.chat.completions.create({ ...params, stream: true });
    for await (const chunk of result) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }
  const result = await completion.client.chat.completions.create(params);
  const response = result.choices[0]?.message?.content || "";
  return res.json({ response, character: config[0], words: response.split(/\s+/).filter(Boolean).length });
}

export function registerRemainingThinkerApiRoutes(app: Express) {
  const ids = new Set<string>();
  const envs = new Set<string>();
  const paths = new Set<string>();
  for (const config of REMAINING_THINKER_API_REGISTRY) {
    const [id] = config;
    // The legacy Kuczynski proxy already owns /api/external/kuczynski.
    // Keep it unchanged and expose this separately credentialed endpoint beside it.
    const pathSlug = id === "kuczynski" ? "kuczynski-standalone" : id;
    if (ids.has(id) || envs.has(config[2]) || paths.has(`/api/external/${pathSlug}`)) throw new Error(`Duplicate thinker API registry entry: ${id}`);
    ids.add(id); envs.add(config[2]); paths.add(`/api/external/${pathSlug}`);
    const authenticate = createThinkerKeyMiddleware(config);
    app.post(`/api/external/${pathSlug}`, authenticate, (req, res) => {
      handleThinkerRequest(config, req, res).catch((error) => {
        console.error(`[${config[1]} API] Error:`, error);
        if (!res.headersSent) res.status(500).json({ error: "Failed to generate response" });
      });
    });
    if (id === "kuczynski") {
      // Read-only corpus access can require many pages; keep its budget separate
      // from the more expensive generated-answer limit.
      registerKuczynskiCorpusRoutes(app, createThinkerKeyMiddleware(config, 300));
    }
  }
}