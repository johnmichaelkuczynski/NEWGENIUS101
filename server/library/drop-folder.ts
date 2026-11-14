import { existsSync } from "node:fs";
import { pool } from "../db";
import { addLibraryBook, enqueueLibraryBook } from "./service";
import { libraryDropRoot, readDropBook, scanLibraryDropFolder } from "./drop-folder-files";

export interface FolderImportReport {
  running: boolean;
  total: number;
  processed: number;
  added: number;
  duplicates: number;
  failed: number;
  books: Array<{ id: string; file: string; title: string }>;
  errors: Array<{ file: string; error: string }>;
  finishedAt: string | null;
}
const freshReport = (): FolderImportReport => ({
  running: false, total: 0, processed: 0, added: 0, duplicates: 0,
  failed: 0, books: [], errors: [], finishedAt: null,
});
let report = freshReport();

export const libraryDropFolderStatus = () => ({
  path: "STANDING_LIBRARY", available: existsSync(libraryDropRoot), ...report,
});

export async function importLibraryFolder(options: {
  root?: string;
  dryRun?: boolean;
  progress?: (state: FolderImportReport) => void;
} = {}) {
  const result = { ...freshReport(), running: true };
  const update = () => options.progress?.(result);
  try {
    const files = await scanLibraryDropFolder(options.root);
    result.total = files.length;
    update();
    for (const file of files) {
      try {
        const input = await readDropBook(file, options.root);
        if (options.dryRun) result.added++;
        else {
          const saved = await addLibraryBook(input);
          if (saved.duplicate) result.duplicates++;
          else result.added++;
          if (saved.book.status === "failed") {
            await pool.query("UPDATE library_books SET status='indexing',error=NULL,updated_at=now() WHERE id=$1 AND status='failed'", [saved.book.id]);
            enqueueLibraryBook(saved.book.id);
          }
          result.books.push({ id: saved.book.id, file, title: saved.book.title });
        }
      } catch (error) {
        result.failed++;
        const code = (error as NodeJS.ErrnoException).code;
        result.errors.push({ file, error: code
          ? code === "ELOOP" ? "Symbolic links are not imported." : "Could not read or save this book. Check the file and retry."
          : (error as Error).message });
      }
      result.processed++;
      update();
    }
  } finally {
    result.running = false;
    result.finishedAt = new Date().toISOString();
    update();
  }
  return result;
}

export function startLibraryFolderImport() {
  if (report.running) return libraryDropFolderStatus();
  report = { ...freshReport(), running: true };
  void importLibraryFolder({ progress: state => { report = state; } }).catch(() => {
    report.running = false;
    report.failed++;
    report.errors.push({ file: "STANDING_LIBRARY", error: "Could not scan the drop folder. Check that it exists and is readable." });
  });
  return libraryDropFolderStatus();
}

export async function waitForLibraryFolderBooks(ids: string[], timeoutMs = 45 * 60 * 1000) {
  if (!ids.length) return [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await pool.query("SELECT id,title,status,error,indexed_chunks,chunk_count FROM library_books WHERE id=ANY($1::text[])", [ids]);
    if (result.rowCount !== new Set(ids).size) throw new Error("An imported book was removed while indexing; no deleted book was recreated.");
    if (!result.rows.some(book => book.status === "indexing")) return result.rows;
    if (Date.now() >= deadline) throw new Error("Indexing is still running. Check the library's saved progress; original files are unchanged.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
