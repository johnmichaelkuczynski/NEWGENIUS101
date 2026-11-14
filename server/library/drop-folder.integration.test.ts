import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pool } from "../db";
import { importLibraryFolder, waitForLibraryFolderBooks } from "./drop-folder";
import { searchLibrary } from "./service";
import { libraryContentHash } from "./text";

test("folder imports become searchable, leave files unchanged, report bad names, and do not duplicate on rerun", {
  skip: process.env.LIBRARY_INTEGRATION !== "1", timeout: 120000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "library-folder-integration-"));
  const ids: string[] = [];
  const body = `This is a fictional automated folder-import test, not a historical work.
The heliotrope token has eleven sides in this invented example. Observing a token supplies evidence about its properties; the validity of an argument concerns its inferential structure. This example distinguishes stipulated book facts from the interpreting thinker's own writings. Test identity: ${path.basename(root)}.`;
  try {
    await mkdir(path.join(root, "Automated Test Author"));
    const filename = path.join(root, "Automated Test Author", "Heliotrope Token Fixture.txt");
    await writeFile(filename, body);
    await writeFile(path.join(root, "missing-author.txt"), body);
    const hash = libraryContentHash(await readFile(filename, "utf8"));
    const dryRun = await importLibraryFolder({ root, dryRun: true });
    assert.equal(dryRun.added, 1);
    assert.equal(dryRun.failed, 1);
    assert.equal(dryRun.books.length, 0);
    const first = await importLibraryFolder({ root });
    ids.push(...first.books.map(book => book.id));
    assert.equal(first.added, 1);
    assert.equal(first.failed, 1);
    assert.ok(first.errors[0].error.includes("Author__Title"));
    const books = await waitForLibraryFolderBooks(ids, 90000);
    assert.equal(books[0].status, "ready");
    assert.equal(books[0].indexed_chunks, books[0].chunk_count);
    const hits = await searchLibrary("How many sides does the heliotrope token have?", ids);
    assert.ok(hits.some(hit => hit.text.includes("eleven sides")));
    assert.equal(libraryContentHash(await readFile(filename, "utf8")), hash);
    const again = await importLibraryFolder({ root });
    assert.equal(again.added, 0);
    assert.equal(again.duplicates, 1);
    assert.equal(again.books[0].id, ids[0]);
  } finally {
    for (const id of ids) await pool.query("DELETE FROM library_books WHERE id=$1", [id]);
    await rm(root, { recursive: true, force: true });
    await pool.end();
  }
});
