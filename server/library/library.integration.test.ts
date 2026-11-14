import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import { pool } from "../db";
import { libraryRequestScope, getLibraryContext, libraryGenerationPath } from "./context";
import { registerLibraryRoutes } from "./routes";

test("real uploads persist, index, deduplicate, search, isolate sessions, and feed all library modes", {
  skip: process.env.LIBRARY_INTEGRATION !== "1",
  timeout: 180000,
}, async () => {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, any>();
  // Test-only identities in an isolated loopback server, never the app's auth.
  const authSource = await readFile("server/auth.ts", "utf8");
  const ownerEmail = /const ADMIN_EMAIL = "([^"]+)"/.exec(authSource)?.[1];
  assert.ok(ownerEmail);
  app.use((req: any, _res, next) => {
    const owner = req.headers["x-library-test-owner"] === "yes";
    req.isAuthenticated = () => owner;
    req.user = owner ? { email: ownerEmail, googleId: "isolated-library-test" } : undefined;
    const sessionId = String(req.headers["x-library-test-session"] || "visitor");
    if (!sessions.has(sessionId)) sessions.set(sessionId, { save: (cb: (e?: Error) => void) => cb() });
    req.session = sessions.get(sessionId);
    next();
  });
  app.use(libraryRequestScope);
  registerLibraryRoutes(app, async function* (input) {
    const context = await getLibraryContext();
    assert.ok(context.includes("Violet Token Integration Fixture"));
    assert.ok(context.includes("NOT evidence that the selected thinker held these views"));
    yield { status: "Real source context resolved" };
    yield { content: `Verified ${input.mode} source propagation.` };
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = (url: string, init: RequestInit = {}, owner = false, session = "visitor") =>
    fetch(`${base}${url}`, { ...init, headers: { ...init.headers, "x-library-test-owner": owner ? "yes" : "no", "x-library-test-session": session } });
  const ids: string[] = [];
  const before = (await pool.query("SELECT (SELECT count(*)::int FROM texts) AS texts,(SELECT count(*)::int FROM chunks) AS chunks")).rows[0];
  try {
    const original = `The Violet Token Integration Fixture is a synthetic test document, not a historical work.
In its fictional example the violet token has exactly nine sides. Its color and shape are invented test facts.
The example separates the truth of premises from the validity of an inference. A valid inference preserves truth if its premises are true; calling an inference valid does not by itself establish that its premises are true.
This fixture is removed after the test and must not be attributed to any historical thinker.`;
    const upload = async (owner: boolean) => {
      const form = new FormData();
      form.set("title", "Violet Token Integration Fixture");
      form.set("author", "Automated test fixture");
      form.set("file", new Blob([original], { type: "text/plain" }), "library-integration-fixture.txt");
      return request("/api/library/books", { method: "POST", body: form }, owner);
    };
    assert.equal((await upload(false)).status, 403);
    const uploaded = await upload(true);
    assert.equal(uploaded.status, 202);
    const payload = await uploaded.json();
    ids.push(payload.book.id);
    const id = payload.book.id;
    assert.equal(payload.duplicate, false);
    const duplicate = await (await upload(true)).json();
    assert.equal(duplicate.book.id, id);
    assert.equal(duplicate.duplicate, true);
    let book: any;
    for (let i = 0; i < 240; i++) {
      const catalog = await (await request("/api/library?q=Violet%20Token")).json();
      book = catalog.books.find((b: any) => b.id === id);
      if (book?.status === "failed") throw new Error(book.error);
      if (book?.status === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(book?.status, "ready");
    assert.equal(book.indexedChunks, book.chunkCount);
    const stored = (await pool.query("SELECT content FROM library_books WHERE id=$1", [id])).rows[0];
    assert.equal(stored.content, original);
    const result = await (await request("/api/library/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "How many sides does the violet token have?", bookIds: [id] }),
    })).json();
    assert.ok(result.passages.some((passage: any) => passage.bookId === id && passage.text.includes("exactly nine sides")));
    const select = await request("/api/library/selection", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookIds: [id] }),
    }, false, "focused");
    assert.equal(select.status, 200);
    assert.deepEqual((await (await request("/api/library", {}, false, "focused")).json()).selectedBookIds, [id]);
    assert.deepEqual((await (await request("/api/library", {}, false, "another")).json()).selectedBookIds, []);
    assert.equal((await request(`/api/library/books/${id}`, { method: "DELETE" })).status, 403);
    for (const mode of ["answer", "paper", "screenplay", "dialogue", "debate"]) {
      const response = await request("/api/library/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Explain the violet token example and validity.", mode, bookIds: [id],
          figureIds: ["dialogue", "debate"].includes(mode) ? ["freud", "jung"] : ["kuczynski"], wordLength: 200 }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(text.includes(`Verified ${mode} source propagation.`));
      assert.ok(text.includes("[DONE]"));
    }
    const invalid = await request("/api/library/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Discuss this book.", mode: "debate", figureIds: ["freud"], wordLength: 200 }),
    });
    assert.equal(invalid.status, 400);
    for (const pathname of ["/api/chat/stream", "/api/figures/freud/chat", "/api/figures/galileo/write-paper",
      "/api/figures/jung/long-form", "/api/dialogue-creator", "/api/interview-creator",
      "/api/debate/generate", "/api/model-builder", "/api/full-document-generator"]) {
      assert.equal(libraryGenerationPath(pathname), true);
    }
    assert.equal(libraryGenerationPath("/api/external/kuczynski"), false);
    const after = (await pool.query("SELECT (SELECT count(*)::int FROM texts) AS texts,(SELECT count(*)::int FROM chunks) AS chunks")).rows[0];
    assert.deepEqual(after, before);
    const deleted = await request(`/api/library/books/${id}`, { method: "DELETE" }, true);
    assert.equal(deleted.status, 200);
    assert.equal(Number((await pool.query("SELECT count(*) FROM library_chunks WHERE book_id=$1", [id])).rows[0].count), 0);
  } finally {
    for (const id of ids) await pool.query("DELETE FROM library_books WHERE id=$1", [id]);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  }
});
