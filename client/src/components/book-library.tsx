import { useMemo, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { libraryWindowPosition } from "@/lib/library-window";
import {
  BookOpen, Search, Upload, X, Grip, Check, Clock3, AlertCircle, RotateCw,
  Trash2, FileText, Sparkles, Copy, Download, Square, LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  LibraryBook, LibraryMode, LibraryPassage, streamLibraryWork, useDeleteLibraryBook,
  useImportLibraryFolder, useLibrary, useLibrarySearch, useLibrarySelection, useRetryLibraryBook, useUploadLibraryBook,
} from "@/hooks/use-library";

type Figure = { id: string | number; name: string };
type Tab = "catalog" | "passages" | "work";
const MODES: { id: LibraryMode; label: string; figures: string }[] = [
  { id: "answer", label: "Answer", figures: "1 thinker" },
  { id: "paper", label: "Paper", figures: "1 thinker" },
  { id: "screenplay", label: "Screenplay", figures: "1–4 thinkers" },
  { id: "dialogue", label: "Dialogue", figures: "2–4 thinkers" },
  { id: "debate", label: "Debate", figures: "2–4 thinkers" },
];

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function statusLabel(book: LibraryBook) {
  if (book.status === "ready") return "Ready";
  if (book.status === "failed") return "Needs attention";
  return "Indexing";
}

export function BookLibrary() {
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get("library") === "open");
  const [tab, setTab] = useState<Tab>("catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [passageQuery, setPassageQuery] = useState("");
  const [passageFilter, setPassageFilter] = useState("");
  const [passages, setPassages] = useState<LibraryPassage[]>([]);
  const [passageError, setPassageError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [mode, setMode] = useState<LibraryMode>("answer");
  const [topic, setTopic] = useState("");
  const [wordLength, setWordLength] = useState(1200);
  const [figureIds, setFigureIds] = useState<string[]>([]);
  const [streamText, setStreamText] = useState("");
  const [streamStatus, setStreamStatus] = useState("");
  const [streamError, setStreamError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragOrigin = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const catalog = useLibrary(catalogSearch);
  const selection = useLibrarySelection();
  const upload = useUploadLibraryBook();
  const folderImport = useImportLibraryFolder();
  const retry = useRetryLibraryBook();
  const remove = useDeleteLibraryBook();
  const searchPassages = useLibrarySearch();
  const figuresQuery = useQuery<Figure[]>({
    queryKey: ["/api/figures"],
    queryFn: async () => {
      const response = await fetch("/api/figures", { credentials: "include" });
      if (!response.ok) throw new Error("Could not load thinkers.");
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("The thinkers list had an unexpected format.");
      return payload;
    },
    enabled: open,
    staleTime: 60_000,
  });

  const books = catalog.data?.books ?? [];
  const selectedIds = catalog.data?.selectedBookIds ?? [];
  const readyBooks = useMemo(() => books.filter(book => book.status === "ready"), [books]);
  const selectedCount = selectedIds.length;
  const currentMode = MODES.find(item => item.id === mode)!;
  const minFigures = mode === "dialogue" || mode === "debate" ? 2 : 1;
  const maxFigures = mode === "screenplay" || mode === "dialogue" || mode === "debate" ? 4 : 1;
  const chosenFigures = figuresQuery.data?.filter(figure => figureIds.includes(String(figure.id))) ?? [];
  const windowStyle = positioned
    ? { left: `${position.x}px`, top: `${position.y}px`, right: "auto",
      maxHeight: `calc(100dvh - ${position.y + 12}px)`, maxWidth: `calc(100vw - ${position.x + 12}px)` }
    : undefined;

  const moveWindow = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    dragOrigin.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    setPosition(libraryWindowPosition(
      dragOrigin.current.left + event.clientX - dragOrigin.current.x,
      dragOrigin.current.top + event.clientY - dragOrigin.current.y,
      rect.width, rect.height, window.innerWidth, window.innerHeight,
    ));
    setPositioned(true);
  };

  const toggleBook = (id: string) => {
    if (!selectedIds.includes(id) && selectedIds.length >= 8) return;
    const next = selectedIds.includes(id) ? selectedIds.filter(bookId => bookId !== id) : [...selectedIds, id];
    selection.mutate(next);
  };

  const chooseFile = (candidate?: File) => {
    if (!candidate) return;
    const extension = candidate.name.split(".").pop()?.toLowerCase();
    if (!["txt", "md", "pdf", "docx"].includes(extension ?? "")) {
      setUploadError("Choose a .txt, .md, .pdf, or .docx file.");
      return;
    }
    if (candidate.size > 30 * 1024 * 1024) {
      setUploadError("This file is larger than the 30 MB limit.");
      return;
    }
    setUploadError("");
    setFile(candidate);
    if (!title.trim()) setTitle(candidate.name.replace(/\.[^.]+$/, ""));
  };

  const submitUpload = () => {
    if (!file || !title.trim() || !author.trim() || upload.isPending) return;
    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim());
    form.append("author", author.trim());
    setUploadError("");
    upload.mutate(form, {
      onSuccess: () => {
        setFile(null);
        setTitle("");
        setAuthor("");
        if (fileInput.current) fileInput.current.value = "";
      },
      onError: error => setUploadError(messageOf(error, "The book could not be uploaded.")),
    });
  };

  const runPassageSearch = () => {
    if (!passageQuery.trim() || searchPassages.isPending) return;
    setPassageError("");
    searchPassages.mutate(
      { query: passageQuery.trim(), ...(passageFilter ? { bookIds: [passageFilter] } : {}) },
      {
        onSuccess: result => setPassages(result.passages),
        onError: error => setPassageError(messageOf(error, "Passage search failed.")),
      },
    );
  };

  const toggleFigure = (id: string) => {
    setFigureIds(current => {
      if (current.includes(id)) return current.filter(item => item !== id);
      if (current.length >= maxFigures) return current;
      return [...current, id];
    });
  };

  const startGeneration = async () => {
    if (!topic.trim() || streaming || chosenFigures.length < minFigures || chosenFigures.length > maxFigures) return;
    setStreamText("");
    setStreamError("");
    setStreamStatus("Opening the conversation…");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamLibraryWork(
        { question: topic.trim(), mode, bookIds: selectedIds, figureIds, wordLength },
        event => {
          if (event.content) setStreamText(previous => previous + event.content);
          if (event.status) setStreamStatus(event.status);
          if (event.error) setStreamError(event.error);
          if (event.done) setStreamStatus("Complete");
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) setStreamStatus("Stopped");
      else setStreamError(messageOf(error, "The response could not be completed."));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const copyOutput = async () => {
    if (!streamText) return;
    try {
      await navigator.clipboard.writeText(streamText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setStreamError("Clipboard access was unavailable. Select and copy the response text instead.");
    }
  };
  const downloadOutput = () => {
    if (!streamText) return;
    const blob = new Blob([streamText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${mode}-from-the-library.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="button-open-book-library"
      >
        <BookOpen className="w-4 h-4" />
        <span className="hidden sm:inline">Shared Library</span>
        {selectedCount > 0 && (
          <span className="inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-semibold text-primary" aria-label={`${selectedCount} selected books`}>
            {selectedCount}
          </span>
        )}
      </Button>

      {open && createPortal(
        <div className="book-library-layer" role="presentation">
          <section
            className="book-library-window"
            style={windowStyle}
            aria-label="Shared standing book library"
          >
            <header
              className="book-library-header"
              onPointerDown={moveWindow}
              onPointerMove={dragMove}
              onPointerUp={() => { dragOrigin.current = null; }}
              onPointerCancel={() => { dragOrigin.current = null; }}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="book-library-mark"><BookOpen className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <h2 className="truncate text-xl font-semibold leading-tight">The standing library</h2>
                    <span className="book-library-kicker hidden sm:inline">GENIUS 101</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">Texts to think with, not merely about.</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="mr-2 hidden items-center gap-1 text-[10px] uppercase tracking-[.16em] text-muted-foreground sm:flex"><Grip className="h-3 w-3" /> Move</span>
                <Button variant="ghost" size="icon" aria-label="Close library window" onClick={() => setOpen(false)} data-testid="button-close-book-library">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </header>

            <nav className="book-library-tabs" aria-label="Library sections">
              {([
                ["catalog", "Catalog"],
                ["passages", "Search passages"],
                ["work", "Create with the library"],
              ] as [Tab, string][]).map(([id, label]) => (
                <button key={id} type="button" className={`book-library-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                  {label}
                  {id === "catalog" && selectedCount > 0 && <span className="book-library-tab-count">{selectedCount}</span>}
                </button>
              ))}
            </nav>

            <div className="book-library-body">
              {tab === "catalog" && (
                <div className="book-library-catalog">
                  <div className="book-library-intro">
                    <div>
                      <p className="book-library-eyebrow">A shared shelf</p>
                      <h3>Find the words behind the ideas.</h3>
                      <p>Browse the actual texts, follow their indexing, and choose ready sources for your next conversation.</p>
                    </div>
                    <div className="book-library-count"><strong>{catalog.data?.total ?? "—"}</strong><span>works</span></div>
                  </div>
                  <label className="book-library-search">
                    <Search className="h-4 w-4" />
                    <input value={catalogSearch} onChange={event => setCatalogSearch(event.target.value)} placeholder="Search titles and authors" aria-label="Search books by title or author" />
                    {catalogSearch && <button type="button" onClick={() => setCatalogSearch("")} aria-label="Clear search"><X className="h-4 w-4" /></button>}
                  </label>
                  <div className="book-library-shelf-heading">
                    <span>On the shelf</span><span>{books.length} {books.length === 1 ? "work" : "works"}</span>
                  </div>
                  <div className="book-library-list">
                    {catalog.isLoading && <div className="book-library-loading">{[1, 2, 3].map(item => <div key={item} className="book-library-skeleton" />)}</div>}
                    {catalog.isError && (
                      <div className="book-library-state error">
                        <AlertCircle className="h-5 w-5" /><div><strong>The shelf could not be reached.</strong><p>{messageOf(catalog.error, "Library request failed.")}</p></div>
                        <Button variant="outline" size="sm" onClick={() => catalog.refetch()}>Try again</Button>
                      </div>
                    )}
                    {!catalog.isLoading && !catalog.isError && books.length === 0 && (
                      <div className="book-library-empty">
                        <span className="book-library-empty-mark"><BookOpen className="h-6 w-6" /></span>
                        <strong>{catalogSearch ? "No matching works" : "The shelf is waiting for its first book."}</strong>
                        <p>{catalogSearch ? "Try another title or author." : "No books are listed yet. When a work is added, it will appear here with its real indexing status."}</p>
                      </div>
                    )}
                    {books.map(book => (
                      <BookRow
                        key={book.id}
                        book={book}
                        selected={selectedIds.includes(book.id)}
                        limitReached={selectedIds.length >= 8}
                        canManage={catalog.data?.canManage ?? false}
                        selectionPending={selection.isPending}
                        retryPending={retry.isPending}
                        deletePending={remove.isPending}
                        onSelect={() => toggleBook(book.id)}
                        onRetry={() => retry.mutate(book.id)}
                        onDelete={() => {
                          setDeleteError("");
                          remove.mutate(book.id, { onError: error => setDeleteError(messageOf(error, "The book could not be removed.")) });
                        }}
                      />
                    ))}
                    {selection.isError && <p className="book-library-inline-error">{messageOf(selection.error, "Could not update selected sources.")}</p>}
                    {retry.isError && <p className="book-library-inline-error">{messageOf(retry.error, "Retry failed.")}</p>}
                    {deleteError && <p className="book-library-inline-error">{deleteError}</p>}
                  </div>

                  {catalog.data?.canManage ? (
                    <section className="book-library-upload">
                      <div className="flex items-center justify-between gap-3">
                        <div><p className="book-library-eyebrow">Add a primary source</p><h4>Put a work on the shelf</h4></div>
                        <span className="book-library-upload-note">Only you manage · books are available to everyone</span>
                      </div>
                      {catalog.data.dropFolder?.available ? (
                        <div className="book-library-folder-import">
                          <div className="book-library-folder-copy">
                            <strong>Import project drop folder</strong>
                            <p>Project Files → {catalog.data.dropFolder.path} → author-named folder → book file. Filename becomes the title and folder name becomes the author; root files can use <code>Author__Title.ext</code>.</p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => folderImport.mutate()}
                            disabled={catalog.data.dropFolder.running || folderImport.isPending}
                          >
                            {catalog.data.dropFolder.running || folderImport.isPending
                              ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                              : <FileText className="mr-2 h-4 w-4" />}
                            {catalog.data.dropFolder.running ? "Import running…" : folderImport.isPending ? "Starting…" : "Import drop folder"}
                          </Button>
                          {catalog.data.dropFolder.running && (
                            <p className="book-library-folder-progress" aria-live="polite">
                              Scanned {catalog.data.dropFolder.processed} of {catalog.data.dropFolder.total} files. Added {catalog.data.dropFolder.added}; existing {catalog.data.dropFolder.duplicates}; errors {catalog.data.dropFolder.failed}.
                            </p>
                          )}
                          {!catalog.data.dropFolder.running && catalog.data.dropFolder.finishedAt && (
                            <div className="book-library-folder-summary" aria-live="polite">
                              {catalog.data.dropFolder.total === 0
                                ? <strong>No files found in the drop folder.</strong>
                                : <strong>Scan complete: {catalog.data.dropFolder.processed}/{catalog.data.dropFolder.total} processed · {catalog.data.dropFolder.added} added · {catalog.data.dropFolder.duplicates} existing · {catalog.data.dropFolder.failed} errors.</strong>}
                              {catalog.data.dropFolder.added > 0 && <p>Newly added books continue indexing after the scan. They become usable when their status is Ready.</p>}
                              {catalog.data.dropFolder.errors.length > 0 && (
                                <ul>{catalog.data.dropFolder.errors.map((item, index) => <li key={`${item.file}-${index}`}><strong>{item.file}</strong><span>{item.error}</span></li>)}</ul>
                              )}
                            </div>
                          )}
                          {folderImport.isError && <p className="book-library-inline-error">{messageOf(folderImport.error, "The project drop folder could not be imported.")}</p>}
                        </div>
                      ) : (
                        <p className="book-library-folder-unavailable">Project-folder imports are available from Preview. Browser upload remains available here.</p>
                      )}
                      <div
                        className={`book-library-drop ${dragging ? "is-dragging" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => fileInput.current?.click()}
                        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") fileInput.current?.click(); }}
                        onDragOver={event => { event.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
                      >
                        <Upload className="h-4 w-4" />
                        <span>{file ? file.name : "Drop a book file here or choose a file"}</span>
                        <small>.txt · .md · .pdf · .docx · up to 30 MB</small>
                      </div>
                      <input ref={fileInput} type="file" className="hidden" accept=".txt,.md,.pdf,.docx" onChange={event => chooseFile(event.target.files?.[0])} />
                      <div className="book-library-upload-fields">
                        <input aria-label="Book title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Title" />
                        <input aria-label="Book author" value={author} onChange={event => setAuthor(event.target.value)} placeholder="Author" />
                        <Button size="sm" onClick={submitUpload} disabled={!file || !title.trim() || !author.trim() || upload.isPending}>
                          {upload.isPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                          {upload.isPending ? "Adding…" : "Add to library"}
                        </Button>
                      </div>
                      {uploadError && <p className="book-library-inline-error">{uploadError}</p>}
                      {!uploadError && upload.isError && <p className="book-library-inline-error">{messageOf(upload.error, "Upload failed.")}</p>}
                    </section>
                  ) : (
                    <p className="book-library-owner-note">This is a shared shelf. Library works are added and maintained by its owner; everyone can browse, search, and use ready books.</p>
                  )}
                </div>
              )}

              {tab === "passages" && (
                <section className="book-library-feature">
                  <p className="book-library-eyebrow">Search the actual text</p>
                  <h3>Find a passage.</h3>
                  <p className="book-library-feature-copy">Search indexed passages across the shelf, or narrow the search to one ready work.</p>
                  <div className="book-library-search-form">
                    <input value={passageQuery} onChange={event => setPassageQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") runPassageSearch(); }} placeholder="A phrase, question, or idea" aria-label="Passage search query" />
                    <select value={passageFilter} onChange={event => setPassageFilter(event.target.value)} aria-label="Limit passage search to a book">
                      <option value="">All ready works</option>
                      {readyBooks.map(book => <option value={book.id} key={book.id}>{book.title} — {book.author}</option>)}
                    </select>
                    <Button onClick={runPassageSearch} disabled={!passageQuery.trim() || searchPassages.isPending}>
                      {searchPassages.isPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                      Search
                    </Button>
                  </div>
                  {passageError && <p className="book-library-inline-error">{passageError}</p>}
                  {searchPassages.isError && !passageError && <p className="book-library-inline-error">{messageOf(searchPassages.error, "Passage search failed.")}</p>}
                  <div className="book-library-passages">
                    {passages.length > 0 ? passages.map(passage => (
                      <article className="book-library-passage" key={passage.id}>
                        <div className="flex items-start justify-between gap-4">
                          <div><h4>{passage.title}</h4><p>{passage.author} <span>·</span> Passage {passage.chunkIndex + 1}</p></div>
                          <FileText className="mt-1 h-4 w-4 shrink-0 text-primary/70" />
                        </div>
                        <blockquote>{passage.text}</blockquote>
                      </article>
                    )) : (
                      <div className="book-library-empty compact">
                        <Search className="h-5 w-5" />
                        <strong>{searchPassages.isSuccess ? "No passages found." : "Passages, in context."}</strong>
                        <p>{searchPassages.isSuccess ? "Try a broader phrase or search across all ready works." : "Results will include the exact text and its work attribution."}</p>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {tab === "work" && (
                <section className="book-library-work">
                  <div className="book-library-work-heading">
                    <div><p className="book-library-eyebrow">A workshop in the words themselves</p><h3>Make something with the library.</h3></div>
                    <Sparkles className="h-5 w-5 text-primary/70" />
                  </div>
                  <p className="book-library-feature-copy">Sources ground the factual material. Each thinker speaks from their own perspective. Automatic library search still happens when no books are selected.</p>
                  <div className="book-library-work-grid">
                    <label className="book-library-field book-library-topic">
                      <span>Question or topic <b>Required</b></span>
                      <textarea value={topic} onChange={event => setTopic(event.target.value)} disabled={streaming} placeholder="What question should these thinkers take up?" rows={3} />
                    </label>
                    <label className="book-library-field">
                      <span>Form</span>
                      <select value={mode} onChange={event => { setMode(event.target.value as LibraryMode); setFigureIds([]); }} disabled={streaming}>
                        {MODES.map(item => <option key={item.id} value={item.id}>{item.label} · {item.figures}</option>)}
                      </select>
                    </label>
                    <label className="book-library-field">
                      <span>Length <b>{wordLength.toLocaleString()} words</b></span>
                      <input type="range" min={100} max={10000} step={100} value={wordLength} onChange={event => setWordLength(Number(event.target.value))} disabled={streaming} />
                      <small>100–10,000 words</small>
                    </label>
                  </div>
                  <div className="book-library-picker-row">
                    <div className="book-library-picker-heading">
                      <div><strong>Thinkers</strong><span>{minFigures === 1 && maxFigures === 1 ? "Choose 1" : `Choose ${minFigures}–${maxFigures}`}</span></div>
                      <span>{chosenFigures.length} selected</span>
                    </div>
                    {figuresQuery.isLoading ? <p className="book-library-subtle">Loading thinkers…</p>
                      : figuresQuery.isError ? <div className="book-library-inline-error">{messageOf(figuresQuery.error, "Thinkers could not be loaded.")} <button onClick={() => figuresQuery.refetch()}>Retry</button></div>
                      : <div className="book-library-chips">{(figuresQuery.data ?? []).map(figure => {
                        const id = String(figure.id);
                        const active = figureIds.includes(id);
                        return <button type="button" key={id} className={`book-library-chip ${active ? "selected" : ""}`} onClick={() => toggleFigure(id)} disabled={streaming || (!active && figureIds.length >= maxFigures)}>{active && <Check className="h-3 w-3" />}{figure.name}</button>;
                      })}</div>}
                  </div>
                  <div className="book-library-picker-row">
                    <div className="book-library-picker-heading">
                      <div><strong>Sources</strong><span>Choose up to 8 ready works</span></div>
                      <button className="book-library-clear" type="button" disabled={streaming || selectedIds.length === 0} onClick={() => selection.mutate([])}>Clear selection</button>
                    </div>
                    {readyBooks.length === 0 ? <p className="book-library-subtle">There are no ready books to select yet. You can still create a response; automatic search will look across available library content.</p> :
                      <div className="book-library-chips book-chips-books">{readyBooks.map(book => {
                        const active = selectedIds.includes(book.id);
                        const capped = !active && selectedIds.length >= 8;
                        return <button type="button" key={book.id} className={`book-library-chip ${active ? "selected" : ""}`} disabled={streaming || selection.isPending || capped} onClick={() => toggleBook(book.id)} title={book.author}>{active && <Check className="h-3 w-3" />}{book.title}</button>;
                      })}</div>}
                    <p className="book-library-subtle">Manual selections focus this session on those books. With none selected, the library still searches automatically.</p>
                  </div>
                  {selection.isError && <p className="book-library-inline-error">{messageOf(selection.error, "Could not update selected sources.")}</p>}
                  <div className="book-library-generate-row">
                    <span>{selectedIds.length ? `${selectedIds.length} focused ${selectedIds.length === 1 ? "source" : "sources"}` : "Automatic source search enabled"}</span>
                    <Button onClick={startGeneration} disabled={!topic.trim() || streaming || chosenFigures.length < minFigures || chosenFigures.length > maxFigures}>
                      <Sparkles className="mr-2 h-4 w-4" />Begin
                    </Button>
                  </div>
                  {(streaming || streamText || streamError) && (
                    <section className="book-library-output" aria-live="polite">
                      <div className="book-library-output-top">
                        <div><span className={`book-library-live-dot ${streaming ? "live" : ""}`} /><strong>{streaming ? "In progress" : streamStatus || (streamError ? "Response interrupted" : "Response")}</strong><span className="book-library-output-status">{streamStatus}</span></div>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={copyOutput} disabled={!streamText}>{copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}{copied ? "Copied" : "Copy"}</Button>
                          <Button variant="ghost" size="sm" onClick={downloadOutput} disabled={!streamText}><Download className="mr-1 h-3.5 w-3.5" />Download</Button>
                          {streaming && <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}><Square className="mr-1 h-3 w-3" />Stop</Button>}
                        </div>
                      </div>
                      {streamError && <p className="book-library-inline-error">{streamError}</p>}
                      {streamText ? <pre className="book-library-response">{streamText}</pre> : streaming ? <div className="book-library-output-wait"><span /><span /><span /></div> : !streamError ? <p className="book-library-subtle">No response text was received.</p> : null}
                    </section>
                  )}
                </section>
              )}
            </div>
            <div className="book-library-resize-hint" aria-hidden="true">Resize</div>
          </section>
        </div>,
        document.body,
      )}
      <style>{`
        .book-library-layer{position:fixed;inset:0;z-index:100;pointer-events:none}
        .book-library-window{pointer-events:auto;position:absolute;top:72px;right:22px;width:min(930px,calc(100vw - 28px));height:min(790px,calc(100dvh - 92px));min-width:min(340px,calc(100vw - 20px));min-height:360px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 20px);display:flex;flex-direction:column;overflow:hidden;resize:both;background:hsl(var(--background));color:hsl(var(--foreground));border:1px solid hsl(var(--border));border-radius:15px;box-shadow:0 22px 70px hsl(220 30% 10% / .22),0 3px 12px hsl(220 30% 10% / .10);font-family:var(--font-sans)}
        .book-library-header{min-height:72px;display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid hsl(var(--border));cursor:grab;touch-action:none;background:linear-gradient(110deg,hsl(var(--card)) 0%,hsl(var(--background)) 58%)}
        .book-library-header:active{cursor:grabbing}.book-library-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));box-shadow:inset 0 1px 0 hsl(var(--primary-foreground)/.18)}
        .book-library-kicker,.book-library-eyebrow{font-size:9px;letter-spacing:.18em;font-weight:700;color:hsl(var(--primary));text-transform:uppercase}
        .book-library-tabs{display:flex;gap:4px;padding:0 18px;border-bottom:1px solid hsl(var(--border));overflow-x:auto}
        .book-library-tab{position:relative;display:flex;align-items:center;gap:8px;white-space:nowrap;border:0;background:transparent;padding:13px 12px 12px;color:hsl(var(--muted-foreground));font-size:12px;font-weight:600;border-bottom:2px solid transparent;cursor:pointer}
        .book-library-tab.active{color:hsl(var(--foreground));border-color:hsl(var(--primary))}
        .book-library-tab-count{display:grid;place-items:center;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:hsl(var(--primary)/.12);color:hsl(var(--primary));font-size:10px}
        .book-library-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
        .book-library-catalog{padding:20px 22px 30px}.book-library-intro{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:18px}
        .book-library-intro h3,.book-library-feature h3,.book-library-work-heading h3{margin:4px 0 5px;font-size:25px;line-height:1.1;letter-spacing:-.025em}
        .book-library-intro p:not(.book-library-eyebrow),.book-library-feature-copy{margin:0;max-width:620px;color:hsl(var(--muted-foreground));font-size:12px;line-height:1.65}
        .book-library-count{height:57px;min-width:72px;padding:8px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-left:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}
        .book-library-count strong{font-family:var(--font-display);font-size:25px;line-height:1;color:hsl(var(--foreground));font-weight:500}.book-library-count span{font-size:10px;letter-spacing:.12em;text-transform:uppercase}
        .book-library-search{height:40px;display:flex;align-items:center;gap:9px;padding:0 12px;border:1px solid hsl(var(--border));border-radius:8px;color:hsl(var(--muted-foreground));background:hsl(var(--card)/.5)}
        .book-library-search input{width:100%;outline:0;border:0;background:transparent;color:hsl(var(--foreground));font-size:12px}.book-library-search button{border:0;background:transparent;color:hsl(var(--muted-foreground));cursor:pointer}
        .book-library-shelf-heading{display:flex;justify-content:space-between;margin:18px 1px 8px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:hsl(var(--muted-foreground))}
        .book-library-list{display:flex;flex-direction:column;gap:7px}.book-library-row{display:flex;align-items:center;gap:12px;min-height:66px;padding:9px 11px;border:1px solid hsl(var(--border));border-radius:9px;background:hsl(var(--card)/.48);transition:transform .16s}
        .book-library-row:hover{border-color:hsl(var(--primary)/.35);transform:translateY(-1px)}.book-library-cover{width:36px;height:44px;display:grid;place-items:center;flex:0 0 auto;color:hsl(var(--primary));background:linear-gradient(145deg,hsl(var(--primary)/.15),hsl(var(--primary)/.04));border:1px solid hsl(var(--primary)/.14);border-radius:3px 6px 6px 3px;box-shadow:inset 3px 0 hsl(var(--primary)/.12)}
        .book-library-book-meta{min-width:0;flex:1}.book-library-book-meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-display);font-size:17px;font-weight:600;line-height:1.1}
        .book-library-book-meta p{margin:4px 0 0;color:hsl(var(--muted-foreground));font-size:10px}.book-library-book-meta p span{margin:0 4px;color:hsl(var(--border))}
        .book-library-status{display:inline-flex;align-items:center;gap:5px;margin-top:5px;font-size:9px;font-weight:600;color:hsl(var(--muted-foreground))}.book-library-status.ready{color:hsl(151 38% 36%)}.book-library-status.failed{color:hsl(var(--destructive))}.book-library-status.indexing{color:hsl(36 61% 43%)}
        .book-library-progress{width:78px;height:3px;margin-top:4px;overflow:hidden;border-radius:8px;background:hsl(var(--muted))}.book-library-progress span{display:block;height:100%;background:hsl(var(--primary))}
        .book-library-row-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}.book-library-focus{display:flex;align-items:center;gap:6px;white-space:nowrap;border:1px solid hsl(var(--border));border-radius:6px;padding:6px 8px;background:transparent;color:hsl(var(--muted-foreground));font-size:10px;cursor:pointer}
        .book-library-focus.selected{background:hsl(var(--primary));border-color:hsl(var(--primary));color:hsl(var(--primary-foreground))}.book-library-focus:disabled{opacity:.5;cursor:default}
        .book-library-manage{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;color:hsl(var(--muted-foreground));background:transparent;cursor:pointer}.book-library-manage:hover{background:hsl(var(--destructive)/.08);color:hsl(var(--destructive))}.book-library-manage:disabled{opacity:.45;cursor:default}
        .book-library-empty,.book-library-state{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 18px;border:1px dashed hsl(var(--border));border-radius:10px;background:hsl(var(--card)/.36);color:hsl(var(--muted-foreground))}
        .book-library-empty-mark{width:40px;height:40px;display:grid;place-items:center;margin-bottom:11px;border-radius:50%;background:hsl(var(--primary)/.08);color:hsl(var(--primary))}
        .book-library-empty strong,.book-library-state strong{font-family:var(--font-display);font-size:18px;font-weight:600;color:hsl(var(--foreground))}
        .book-library-empty p,.book-library-state p{max-width:390px;margin:5px 0 0;font-size:11px;line-height:1.6}.book-library-empty.compact{min-height:128px}.book-library-state{flex-direction:row;gap:12px;text-align:left}
        .book-library-loading{display:grid;gap:7px}.book-library-skeleton{height:66px;border-radius:9px;background:hsl(var(--card));animation:book-library-pulse 1.3s ease-in-out infinite}
        .book-library-inline-error{margin:8px 0 0;color:hsl(var(--destructive));font-size:11px;line-height:1.5}.book-library-inline-error button{margin-left:6px;border:0;background:transparent;color:hsl(var(--primary));text-decoration:underline;cursor:pointer}
        .book-library-upload{margin-top:18px;padding:14px;border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--card)/.42)}
        .book-library-upload h4{margin:2px 0 0;font-family:var(--font-display);font-size:18px}.book-library-upload-note{font-size:9px;color:hsl(var(--muted-foreground))}
        .book-library-folder-import{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:9px 14px;margin-top:12px;padding:11px 12px;border:1px solid hsl(var(--primary)/.2);border-radius:8px;background:hsl(var(--primary)/.035)}
        .book-library-folder-copy strong{font-size:11px}.book-library-folder-copy p{margin:3px 0 0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.55}
        .book-library-folder-copy code{font-size:9px;color:hsl(var(--foreground));white-space:nowrap}.book-library-folder-progress,.book-library-folder-summary{grid-column:1 / -1;margin:0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.55}
        .book-library-folder-summary strong{color:hsl(var(--foreground));font-weight:600}.book-library-folder-summary p{margin:4px 0 0}
        .book-library-folder-summary ul{display:grid;gap:5px;margin:8px 0 0;padding:8px 0 0;list-style:none;border-top:1px solid hsl(var(--border))}
        .book-library-folder-summary li{display:grid;grid-template-columns:minmax(100px,.65fr) minmax(0,1fr);gap:9px;color:hsl(var(--destructive));font-size:10px}
        .book-library-folder-summary li strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:hsl(var(--foreground))}.book-library-folder-summary li span{overflow-wrap:anywhere}
        .book-library-folder-unavailable{margin:10px 0 0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.5}
        .book-library-drop{min-height:48px;display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;border:1px dashed hsl(var(--primary)/.42);border-radius:7px;color:hsl(var(--foreground));font-size:11px;cursor:pointer}
        .book-library-drop svg{color:hsl(var(--primary))}.book-library-drop small{margin-left:auto;color:hsl(var(--muted-foreground));font-size:9px}.book-library-drop.is-dragging{background:hsl(var(--primary)/.07);border-color:hsl(var(--primary))}
        .book-library-upload-fields{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-top:8px}.book-library-upload-fields input,.book-library-field input:not([type=range]),.book-library-field select,.book-library-field textarea,.book-library-search-form input,.book-library-search-form select{min-width:0;width:100%;border:1px solid hsl(var(--border));border-radius:6px;padding:8px 10px;background:hsl(var(--background));color:hsl(var(--foreground));font:inherit;font-size:11px;outline:none}
        .book-library-upload-fields input:focus,.book-library-field input:focus,.book-library-field select:focus,.book-library-field textarea:focus,.book-library-search-form input:focus,.book-library-search-form select:focus{border-color:hsl(var(--primary)/.6);box-shadow:0 0 0 2px hsl(var(--primary)/.09)}
        .book-library-owner-note{margin:15px 0 0;padding:12px 14px;border-left:2px solid hsl(var(--primary)/.5);background:hsl(var(--primary)/.035);color:hsl(var(--muted-foreground));font-size:11px;line-height:1.6}
        .book-library-feature,.book-library-work{padding:24px 24px 32px}.book-library-feature h3{font-size:29px}.book-library-feature-copy{margin:5px 0 16px}
        .book-library-search-form{display:grid;grid-template-columns:minmax(170px,1fr) minmax(150px,.8fr) auto;gap:8px}
        .book-library-passages{display:grid;gap:10px;margin-top:18px}.book-library-passage{padding:15px 16px;border:1px solid hsl(var(--border));border-radius:9px;background:hsl(var(--card)/.48)}
        .book-library-passage h4{margin:0;font-family:var(--font-display);font-size:18px}.book-library-passage p{margin:2px 0 0;color:hsl(var(--muted-foreground));font-size:10px}.book-library-passage p span{padding:0 4px}
        .book-library-passage blockquote{margin:12px 0 0;padding-left:12px;border-left:2px solid hsl(var(--primary)/.35);font-family:var(--font-verse);font-size:16px;line-height:1.6;white-space:pre-wrap;color:hsl(var(--foreground))}
        .book-library-work-heading{display:flex;justify-content:space-between;align-items:flex-start}.book-library-work-heading h3{font-size:27px}.book-library-work-grid{display:grid;grid-template-columns:1fr 190px;gap:12px;margin-top:19px}
        .book-library-field{display:grid;gap:7px;align-content:start}.book-library-field>span,.book-library-picker-heading strong{font-size:11px;font-weight:700}.book-library-field>span{display:flex;justify-content:space-between;gap:6px}.book-library-field b{color:hsl(var(--primary));font-weight:600}
        .book-library-topic{grid-row:span 2}.book-library-field textarea{resize:vertical;min-height:94px;line-height:1.5}.book-library-field input[type=range]{width:100%;accent-color:hsl(var(--primary));margin:6px 0}.book-library-field small{color:hsl(var(--muted-foreground));font-size:9px}
        .book-library-picker-row{margin-top:16px;padding-top:12px;border-top:1px solid hsl(var(--border))}.book-library-picker-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}
        .book-library-picker-heading>div{display:flex;align-items:baseline;gap:9px}.book-library-picker-heading span,.book-library-clear{color:hsl(var(--muted-foreground));font-size:10px}.book-library-clear{border:0;background:transparent;cursor:pointer}.book-library-clear:disabled{opacity:.45;cursor:default}
        .book-library-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:102px;overflow:auto}.book-library-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;border:1px solid hsl(var(--border));border-radius:99px;padding:5px 9px;background:transparent;color:hsl(var(--muted-foreground));font-size:10px;cursor:pointer}
        .book-library-chip.selected{border-color:hsl(var(--primary)/.5);background:hsl(var(--primary)/.1);color:hsl(var(--primary))}.book-library-chip:disabled{opacity:.48;cursor:default}.book-chips-books{max-height:82px}
        .book-library-subtle{margin:8px 0 0;color:hsl(var(--muted-foreground));font-size:10px;line-height:1.5}
        .book-library-generate-row{display:flex;justify-content:space-between;align-items:center;margin-top:17px;padding-top:14px;border-top:1px solid hsl(var(--border));color:hsl(var(--muted-foreground));font-size:10px}
        .book-library-output{margin-top:16px;border:1px solid hsl(var(--border));border-radius:9px;overflow:hidden;background:hsl(var(--card)/.48)}
        .book-library-output-top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid hsl(var(--border));background:hsl(var(--card)/.7)}
        .book-library-output-top>div:first-child{display:flex;align-items:center;gap:7px;min-width:0;font-size:10px}.book-library-output-status{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:hsl(var(--muted-foreground));font-size:9px}
        .book-library-live-dot{width:7px;height:7px;flex:none;border-radius:50%;background:hsl(var(--muted-foreground))}.book-library-live-dot.live{background:hsl(151 38% 39%);animation:book-library-pulse 1.4s ease-in-out infinite}
        @keyframes book-library-pulse{50%{opacity:.35}}
        .book-library-response{max-height:300px;overflow:auto;margin:0;padding:16px;font-family:var(--font-verse);font-size:15px;line-height:1.7;white-space:pre-wrap;color:hsl(var(--foreground))}
        .book-library-output-wait{display:flex;gap:5px;padding:20px}.book-library-output-wait span{width:5px;height:5px;border-radius:50%;background:hsl(var(--primary)/.65);animation:book-library-pulse 1s infinite}.book-library-output-wait span:nth-child(2){animation-delay:.18s}.book-library-output-wait span:nth-child(3){animation-delay:.36s}
        .book-library-resize-hint{position:absolute;right:4px;bottom:1px;pointer-events:none;color:hsl(var(--muted-foreground)/.4);font-size:8px;letter-spacing:.08em}
        @media(max-width:640px){.book-library-folder-import{grid-template-columns:1fr}.book-library-folder-import>button{justify-self:start}}
        @media(max-width:640px){.book-library-window{top:10px;right:10px;width:calc(100vw - 20px);height:calc(100dvh - 20px);min-width:0;min-height:0;border-radius:12px}.book-library-header{min-height:64px;padding:10px 12px}.book-library-catalog,.book-library-feature,.book-library-work{padding:17px 14px 24px}.book-library-intro h3,.book-library-feature h3,.book-library-work-heading h3{font-size:22px}.book-library-intro p:not(.book-library-eyebrow){max-width:260px}.book-library-row{gap:8px;padding:8px}.book-library-row-actions{gap:2px}.book-library-focus{padding:6px}.book-library-focus span{display:none}.book-library-upload-fields{grid-template-columns:1fr 1fr}.book-library-upload-fields button{grid-column:span 2}.book-library-drop{flex-wrap:wrap}.book-library-drop small{width:100%;margin:0 0 0 23px}.book-library-search-form{grid-template-columns:1fr auto}.book-library-search-form select{grid-column:1 / -1;grid-row:2}.book-library-work-grid{grid-template-columns:1fr 1fr}.book-library-topic{grid-column:1 / -1;grid-row:auto}.book-library-output-top{align-items:flex-start;flex-direction:column}.book-library-output-top>div:last-child{align-self:flex-end}.book-library-tabs{padding:0 8px}.book-library-tab{padding:12px 8px;font-size:10px}.book-library-upload-note{display:none}}
        @media(prefers-reduced-motion:reduce){.book-library-window *{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
      `}</style>
    </>
  );
}

function BookRow({
  book, selected, canManage, selectionPending, retryPending, deletePending, onSelect, onRetry, onDelete,
  limitReached,
}: {
  book: LibraryBook;
  selected: boolean;
  limitReached: boolean;
  canManage: boolean;
  selectionPending: boolean;
  retryPending: boolean;
  deletePending: boolean;
  onSelect: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const progress = book.chunkCount > 0 ? Math.min(100, Math.round((book.indexedChunks / book.chunkCount) * 100)) : 0;
  return (
    <article className="book-library-row" data-testid={`library-book-${book.id}`}>
      <span className="book-library-cover"><BookOpen className="h-4 w-4" /></span>
      <div className="book-library-book-meta">
        <strong title={book.title}>{book.title}</strong>
        <p title={book.author}>{book.author}<span>·</span>{book.wordCount.toLocaleString()} words</p>
        <span className={`book-library-status ${book.status}`}>
          {book.status === "ready" ? <Check className="h-3 w-3" /> : book.status === "failed" ? <AlertCircle className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
          {statusLabel(book)}
          {book.status === "indexing" && <span>· {book.indexedChunks}/{book.chunkCount} passages</span>}
        </span>
        {book.status === "indexing" && <div className="book-library-progress" aria-label={`${progress}% indexed`}><span style={{ width: `${progress}%` }} /></div>}
        {book.status === "failed" && book.error && <p className="book-library-inline-error" title={book.error}>{book.error}</p>}
      </div>
      <div className="book-library-row-actions">
        {book.status === "ready" && <button type="button" className={`book-library-focus ${selected ? "selected" : ""}`} onClick={onSelect} disabled={selectionPending || (!selected && limitReached)} aria-pressed={selected} title={selected ? "Remove from session focus" : limitReached ? "A session can focus up to 8 works" : "Focus this source for the session"}>
          {selected ? <Check className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}<span>{selected ? "Focused" : "Focus"}</span>
        </button>}
        {canManage && book.status === "failed" && <button className="book-library-manage" type="button" aria-label={`Retry indexing ${book.title}`} title="Retry indexing" onClick={onRetry} disabled={retryPending}><RotateCw className={`h-4 w-4 ${retryPending ? "animate-spin" : ""}`} /></button>}
        {canManage && <button className="book-library-manage" type="button" aria-label={`Remove ${book.title} from the shared library`} title="Remove from library" onClick={onDelete} disabled={deletePending}><Trash2 className="h-4 w-4" /></button>}
      </div>
    </article>
  );
}
