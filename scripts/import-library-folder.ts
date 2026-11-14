import { pool } from "../server/db";
import { importLibraryFolder, waitForLibraryFolderBooks } from "../server/library/drop-folder";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const report = await importLibraryFolder({ dryRun, progress: state => {
    console.log(`${dryRun ? "Inspecting" : "Importing"}: ${state.processed}/${state.total} files; ${state.added} added; ${state.duplicates} existing; ${state.failed} errors`);
  } });
  for (const error of report.errors) console.error(`${error.file}: ${error.error}`);
  if (!dryRun) {
    const books = await waitForLibraryFolderBooks(report.books.map(book => book.id));
    for (const book of books) console.log(`${book.title}: ${book.status} (${book.indexed_chunks}/${book.chunk_count} passages)${book.error ? ` — ${book.error}` : ""}`);
    if (books.some(book => book.status !== "ready")) process.exitCode = 1;
  }
  if (report.failed) process.exitCode = 1;
  console.log(dryRun ? "Inspection finished. No database writes or embedding requests were made." : "Folder import finished. Original files were left unchanged.");
}
main().catch(error => {
  console.error("Folder import stopped:", error?.code || error?.message || "IMPORT_FAILED");
  process.exitCode = 1;
}).finally(() => pool.end());
