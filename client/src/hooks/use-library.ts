import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  filename: string;
  status: "indexing" | "ready" | "failed";
  wordCount: number;
  chunkCount: number;
  indexedChunks: number;
  error: string | null;
  createdAt: string;
}
export interface LibraryPassage {
  id: string;
  bookId: string;
  title: string;
  author: string;
  chunkIndex: number;
  text: string;
}
export interface LibraryCatalog {
  books: LibraryBook[];
  total: number;
  canManage: boolean;
  selectedBookIds: string[];
  dropFolder?: {
    path: string; available: boolean; running: boolean; total: number; processed: number;
    added: number; duplicates: number; failed: number; finishedAt: string | null;
    errors: Array<{ file: string; error: string }>;
  };
}
async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Library request failed.");
  return data;
}
export function useLibrary(search = "") {
  return useQuery<LibraryCatalog>({
    queryKey: ["/api/library", search],
    queryFn: () => jsonRequest(`/api/library?q=${encodeURIComponent(search)}`),
    refetchInterval: query => query.state.data?.dropFolder?.running || query.state.data?.books.some(book => book.status === "indexing") ? 3000 : 30000,
    staleTime: 2000,
  });
}
export function useImportLibraryFolder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => jsonRequest("/api/library/import-folder", { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/library"] }),
  });
}
export function useLibrarySelection() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (bookIds: string[]) => jsonRequest<{ bookIds: string[] }>("/api/library/selection", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bookIds }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/library"] }),
  });
}
export function useUploadLibraryBook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (data: FormData) => jsonRequest<{ book: LibraryBook; duplicate: boolean }>("/api/library/books", { method: "POST", body: data }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/library"] }),
  });
}
export function useRetryLibraryBook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => jsonRequest(`/api/library/books/${id}/retry`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/library"] }),
  });
}
export function useDeleteLibraryBook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => jsonRequest(`/api/library/books/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["/api/library"] }),
  });
}
export function useLibrarySearch() {
  return useMutation({
    mutationFn: (input: { query: string; bookIds?: string[] }) =>
      jsonRequest<{ passages: LibraryPassage[] }>("/api/library/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      }),
  });
}
export type LibraryMode = "answer" | "paper" | "screenplay" | "dialogue" | "debate";
export async function streamLibraryWork(
  input: { question: string; mode: LibraryMode; bookIds: string[]; figureIds: string[]; wordLength: number },
  onEvent: (event: { content?: string; status?: string; error?: string; done?: boolean }) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/library/generate", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input), signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Could not start the library response.");
  }
  if (!res.body) throw new Error("Streaming is unavailable.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const consume = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6).trim();
    if (raw === "[DONE]") { complete = true; onEvent({ done: true }); return; }
    const event = JSON.parse(raw);
    if (event.error) throw new Error(event.error);
    onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(consume);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!complete) throw new Error("The response ended before completion. The text received so far has been preserved.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
