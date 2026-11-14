import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dropBookMetadata, extractLibraryFile, readDropBook, scanLibraryDropFolder } from "./drop-folder-files";

test("author folders and flat author/title filenames both route to the shared library", () => {
  assert.deepEqual(dropBookMetadata("Ernst Mach/The Science of Mechanics.txt"), {
    author: "Ernst Mach", title: "The Science of Mechanics", filename: "Ernst Mach/The Science of Mechanics.txt",
  });
  assert.equal(dropBookMetadata("Ernst_Mach__The_Science_of_Mechanics.PDF").author, "Ernst Mach");
  assert.equal(dropBookMetadata("Ernst Mach__The Science of Mechanics.docx").title, "The Science of Mechanics");
  for (const file of ["Unattributed.txt", "Author__.txt", "../Author__Book.txt", "/Author__Book.txt", "Author/Book.exe"]) {
    assert.throws(() => dropBookMetadata(file));
  }
});

test("scanning ignores instructions and hidden files; reading preserves originals and rejects links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "library-drop-"));
  try {
    await mkdir(path.join(root, "Test Author"));
    const body = "This is a fictional test source about the nature of knowledge, observation, and inference. ".repeat(8);
    const raw = `Legal notice\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n${body}\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\nLegal terms`;
    const source = path.join(root, "Test Author", "Test Book.txt");
    await writeFile(source, raw);
    await writeFile(path.join(root, "README.md"), "Instructions, not a book.");
    await writeFile(path.join(root, ".hidden.txt"), "Not a book.");
    assert.deepEqual(await scanLibraryDropFolder(root), ["Test Author/Test Book.txt"]);
    const parsed = await readDropBook("Test Author/Test Book.txt", root);
    assert.equal(parsed.text, body.trim());
    assert.equal(await readFile(source, "utf8"), raw);
    await symlink(source, path.join(root, "Test Author", "Linked Book.txt"));
    await assert.rejects(readDropBook("Test Author/Linked Book.txt", root), error => (error as NodeJS.ErrnoException).code === "ELOOP");
    await assert.rejects(extractLibraryFile("empty.txt", Buffer.from("too short")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
