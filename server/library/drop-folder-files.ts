import path from "node:path";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import { cleanLibraryText } from "./text";

export const libraryDropRoot = path.resolve("STANDING_LIBRARY");

export function dropBookMetadata(relativePath: string) {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Use a regular book file inside STANDING_LIBRARY.");
  }
  const filename = parts.at(-1)!;
  if (!/\.(txt|md|pdf|docx)$/i.test(filename)) throw new Error("Use TXT, Markdown, PDF, or DOCX.");
  const stem = filename.replace(/\.[^.]+$/, "");
  const separator = stem.indexOf("__");
  const author = (parts.length > 1 ? parts[0] : separator > 0 ? stem.slice(0, separator) : "").replace(/_/g, " ").trim();
  const title = (parts.length > 1 ? stem : separator > 0 ? stem.slice(separator + 2) : "").replace(/_/g, " ").trim();
  if (!author || !title) throw new Error("Put the book in an author-named folder, or name it Author__Title.ext with two underscores.");
  if (author.length > 300 || title.length > 500) throw new Error("Shorten the author name or book title.");
  return { author, title, filename: relativePath };
}

/** Shared by browser uploads and project-folder imports. No original is edited. */
export async function extractLibraryFile(filename: string, buffer: Buffer): Promise<string> {
  if (buffer.length > 30 * 1024 * 1024) throw new Error("Each book must be at most 30 MB.");
  const ext = filename.split(".").pop()?.toLowerCase();
  let text: string;
  try {
    if (ext === "txt" || ext === "md") text = buffer.toString("utf8");
    else if (ext === "docx") text = (await mammoth.extractRawText({ buffer })).value;
    else if (ext === "pdf") {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else throw new Error("unsupported");
  } catch {
    throw new Error("Could not read this file. Use TXT, Markdown, text-based PDF, or DOCX; scanned PDFs need OCR.");
  }
  text = cleanLibraryText(text);
  if (text.length < 200 || text.length > 15000000) {
    throw new Error("The book must contain 200–15 million readable characters. Scanned PDFs need OCR.");
  }
  return text;
}

export async function scanLibraryDropFolder(root = libraryDropRoot): Promise<string[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("The drop folder must not be a symbolic link.");
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || /^readme\.md$/i.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      // Never follow links, including links to folders outside this repository.
      if (entry.isDirectory()) await walk(filename);
      else files.push(path.relative(root, filename));
    }
  }
  await walk(root);
  return files.sort();
}

export async function readDropBook(relativePath: string, root = libraryDropRoot) {
  const metadata = dropBookMetadata(relativePath);
  const file = path.resolve(root, relativePath);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error("The file is outside the standing-library folder.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Only regular book files can be imported.");
    if (before.size > 30 * 1024 * 1024) throw new Error("Each book must be at most 30 MB.");
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("This file is still changing. Retry after its upload finishes.");
    return { ...metadata, text: await extractLibraryFile(metadata.filename, buffer) };
  } finally { await handle.close(); }
}
