import type { Express, RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../db";
import { isAdmin } from "../auth";
import { isPermanentOwner } from "../access-control";
import { addLibraryBook, bookColumns, enqueueLibraryBook, resumeLibraryImports, searchLibrary } from "./service";
import { extractLibraryFile } from "./drop-folder-files";
import { libraryDropFolderStatus, startLibraryFolderImport } from "./drop-folder";

export const libraryWorkSchema = z.object({
  question: z.string().trim().min(3).max(12000),
  mode: z.enum(["answer", "paper", "screenplay", "dialogue", "debate"]),
  bookIds: z.array(z.string().min(1).max(100)).max(8).default([]),
  figureIds: z.array(z.string().min(1).max(100)).min(1).max(4),
  wordLength: z.number().int().min(100).max(10000).default(750),
}).superRefine((input, ctx) => {
  if (new Set(input.figureIds).size !== input.figureIds.length) ctx.addIssue({ code: "custom", message: "Choose different thinkers." });
  if (["dialogue", "debate"].includes(input.mode) && input.figureIds.length < 2) ctx.addIssue({ code: "custom", message: "Choose at least two thinkers for a dialogue or debate." });
  if (["answer", "paper"].includes(input.mode) && input.figureIds.length !== 1) ctx.addIssue({ code: "custom", message: "Choose one thinker for an answer or paper." });
});
export type LibraryWork = z.infer<typeof libraryWorkSchema>;
const idsSchema = z.array(z.string().min(1).max(100)).max(8);
type WorkGenerator = (input: LibraryWork) => AsyncGenerator<{ status?: string; content?: string }>;

export function registerLibraryRoutes(app: Express, generate: WorkGenerator) {
  const guarded = (fn: RequestHandler): RequestHandler => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(error => {
      console.error("[Library] Request failed", { code: error?.code || error?.name || "LIBRARY_ERROR" });
      if (!res.headersSent) res.status(503).json({ error: "The library service is temporarily unavailable. Existing books have not been removed." });
    });
  };
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 4 },
  }).single("file");

  app.get("/api/library", guarded(async (req: any, res) => {
    const q = String(req.query.q || "").slice(0, 300);
    const result = await pool.query(`SELECT ${bookColumns},count(*) OVER()::int AS total
      FROM library_books WHERE title ILIKE $1 OR author ILIKE $1 ORDER BY author,title`, [`%${q}%`]);
    res.json({
      books: result.rows, total: result.rows[0]?.total || 0,
      canManage: !!req.isAuthenticated?.() && isPermanentOwner(req.user),
      selectedBookIds: req.session?.libraryBookIds || [],
      dropFolder: req.isAuthenticated?.() && isPermanentOwner(req.user) ? libraryDropFolderStatus() : undefined,
    });
  }));

  app.post("/api/library/import-folder", isAdmin, guarded(async (_req, res) => {
    if (!libraryDropFolderStatus().available) {
      return void res.status(409).json({ error: "The STANDING_LIBRARY folder is in the project workspace. Import it from Preview, or use the regular book upload here." });
    }
    res.status(202).json(startLibraryFolderImport());
  }));

  app.post("/api/library/selection", guarded(async (req: any, res) => {
    const parsed = idsSchema.safeParse(req.body.bookIds);
    if (!parsed.success) return void res.status(400).json({ error: "Select at most eight valid books." });
    const ids = Array.from(new Set(parsed.data));
    const ready = await pool.query("SELECT id FROM library_books WHERE id=ANY($1::text[]) AND status='ready'", [ids]);
    if (ready.rowCount !== ids.length) return void res.status(400).json({ error: "Only fully indexed library books can be selected." });
    req.session.libraryBookIds = ids;
    await new Promise<void>((resolve, reject) => req.session.save((error: unknown) => error ? reject(error) : resolve()));
    res.json({ bookIds: ids });
  }));

  app.post("/api/library/search", guarded(async (req, res) => {
    const parsed = z.object({ query: z.string().trim().min(2).max(4000), bookIds: idsSchema.optional() }).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Enter a search of 2–4,000 characters and at most eight books." });
    const passages = await searchLibrary(parsed.data.query, parsed.data.bookIds);
    res.json({ passages });
  }));

  app.post("/api/library/books", isAdmin, (req, res, next) => {
    upload(req, res, error => {
      if (error) return void res.status(400).json({ error: "Upload one book of at most 30 MB." });
      next();
    });
  }, guarded(async (req, res) => {
    const meta = z.object({ title: z.string().trim().min(1).max(500), author: z.string().trim().min(1).max(300) }).safeParse(req.body);
    if (!meta.success || !req.file) return void res.status(400).json({ error: "Provide the book title, its author, and a file." });
    let text: string;
    try {
      text = await extractLibraryFile(req.file.originalname, req.file.buffer);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    const result = await addLibraryBook({ ...meta.data, filename: req.file.originalname, text });
    res.status(result.duplicate ? 200 : 202).json(result);
  }));

  app.post("/api/library/books/:id/retry", isAdmin, guarded(async (req, res) => {
    const result = await pool.query(`UPDATE library_books SET status='indexing',error=NULL,updated_at=now()
      WHERE id=$1 AND status='failed' RETURNING ${bookColumns}`, [req.params.id]);
    if (!result.rowCount) return void res.status(404).json({ error: "No failed import was found to retry." });
    enqueueLibraryBook(req.params.id);
    res.status(202).json({ book: result.rows[0] });
  }));

  app.delete("/api/library/books/:id", isAdmin, guarded(async (req: any, res) => {
    const deleted = await pool.query("DELETE FROM library_books WHERE id=$1 RETURNING id", [req.params.id]);
    if (!deleted.rowCount) return void res.status(404).json({ error: "This library book was not found." });
    req.session.libraryBookIds = (req.session.libraryBookIds || []).filter((id: string) => id !== req.params.id);
    res.json({ deleted: true });
  }));

  app.post("/api/library/generate", guarded(async (req: any, res) => {
    const parsed = libraryWorkSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message || "Choose a topic, books, and valid thinkers." });
    const input = parsed.data;
    if (!input.bookIds.length) input.bookIds = req.session?.libraryBookIds || [];
    if (input.bookIds.length) {
      const books = await pool.query("SELECT id FROM library_books WHERE id=ANY($1::text[]) AND status='ready'", [input.bookIds]);
      if (books.rowCount !== new Set(input.bookIds).size) return void res.status(400).json({ error: "A selected book is missing or has not finished indexing." });
    }
    // Keep the validated source selection visible to the request-local retriever.
    req.body.bookIds = input.bookIds;
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keep-alive\n\n"); }, 12000);
    res.on("close", () => clearInterval(heartbeat));
    try {
      for await (const event of generate(input)) {
        if (res.destroyed || res.writableEnded) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!res.destroyed) res.write("data: [DONE]\n\n");
    } catch (error) {
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ error: "The source-grounded response could not finish. Any text already received has been preserved. Please retry." })}\n\n`);
      console.error("[Library] Generation failed", { code: (error as any)?.code || (error as any)?.name || "GENERATION_FAILED" });
    } finally { clearInterval(heartbeat); res.end(); }
  }));

  // Only resume saved jobs. Schema creation is an explicit setup step, never
  // a blocking startup dependency or a migration of another database.
  void resumeLibraryImports().catch(error =>
    console.error("[Library] Could not resume imports", { code: error?.code || "DATABASE_UNAVAILABLE" }));
}
