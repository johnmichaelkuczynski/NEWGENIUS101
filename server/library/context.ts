import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { searchLibrary } from "./service";
import { formatLibraryContext, librarySubjectPassages, type LibraryPassage } from "./text";

interface LibraryScope {
  request: any;
  promise?: Promise<string>;
  context?: string;
  passages?: LibraryPassage[];
  explicitSelection?: boolean;
}
const scope = new AsyncLocalStorage<LibraryScope>();
const suppression = new AsyncLocalStorage<boolean>();

/** Internal retrieval/planning/judging must see only its explicitly supplied evidence. */
export function withoutLibraryContext<T>(work: () => T): T {
  return suppression.run(true, work);
}
export const libraryGenerationPath = (path: string) =>
  path === "/api/chat/stream"
  || /^\/api\/figures\/[^/]+\/(chat|write-paper|rewrite-paper|long-form)$/.test(path)
  || ["/api/dialogue-creator", "/api/interview-creator", "/api/debate/generate",
    "/api/full-document-generator", "/api/generate-strict-outline", "/api/library/generate",
    "/api/model-builder"].includes(path);

export const libraryRequestScope: RequestHandler = (req, _res, next) => {
  if (req.method !== "POST" || !libraryGenerationPath(req.path)) return next();
  scope.run({ request: req }, next);
};

/** Resolved lazily, after multipart parsing; isolated between concurrent thinkers/users. */
export async function getLibraryContext(queryHint = ""): Promise<string> {
  if (suppression.getStore()) return "";
  const current = scope.getStore();
  if (!current) return "";
  if (!current.promise) current.promise = (async () => {
    const req = current.request;
    const body = req.body || {};
    let ids = body.bookIds ?? body.libraryBookIds ?? req.session?.libraryBookIds ?? [];
    if (typeof ids === "string") {
      try { ids = JSON.parse(ids); } catch { ids = []; }
    }
    if (!Array.isArray(ids) || ids.length > 8 || ids.some((id: unknown) => typeof id !== "string" || id.length > 100)) {
      throw new Error("Select at most eight valid library books.");
    }
    const query = [body.question, body.message, body.topic, body.text, body.prompt,
      body.inputText, body.sourceText, body.customInstructions, body.instructions,
      body.paperText, body.documentText, body.originalText, body.originalPaper, body.rewriteInstructions]
      .filter(value => typeof value === "string" && value.trim()).join("\n").slice(0, 12000)
      || queryHint.slice(0, 12000)
      || (ids.length ? "Explain and analyze the selected book." : "");
    if (!query) return "";
    const resolvedQuery = query.length < 100 && /\b(it|that|this|those|he|she|they|continue|further)\b/i.test(query)
      ? `${req.session?.lastLibraryQuery || ""}\n${query}` : query;
    const passages = await searchLibrary(resolvedQuery, ids);
    current.passages = passages;
    current.explicitSelection = ids.length > 0;
    if (passages.length && req.session) req.session.lastLibraryQuery = resolvedQuery.slice(-1600);
    current.context = formatLibraryContext(passages, ids.length > 0);
    return current.context;
  })();
  return current.promise;
}

export async function getLibrarySubjectContext(question: string): Promise<string> {
  await getLibraryContext(question);
  if (suppression.getStore()) return "";
  const current = scope.getStore();
  if (!current) return "";
  return formatLibraryContext(
    librarySubjectPassages(question, current.passages || [], current.explicitSelection),
    current.explicitSelection,
  );
}

export function resolvedLibraryContext(): string {
  if (suppression.getStore()) return "";
  return scope.getStore()?.context || "";
}

export async function withLibraryContext(system: string, queryHint = ""): Promise<string> {
  const context = await getLibraryContext(queryHint);
  return context && !system.includes("END SHARED LIBRARY SUBJECT MATERIAL") ? `${system}\n${context}` : system;
}
