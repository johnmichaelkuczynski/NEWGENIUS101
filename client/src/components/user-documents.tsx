import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { FolderOpen, Upload, Trash2, Download, FileText, X, Send, ClipboardPaste } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type DocMeta = {
  id: number;
  authUserId: number;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  uploadedAt: string;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface Props {
  onUseDocument?: (name: string, text: string) => void;
}

export default function UserDocuments({ onUseDocument }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"upload" | "paste">("upload");
  const [dragging, setDragging] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ documents: DocMeta[] }>({
    queryKey: ["/api/user-documents"],
    enabled: open,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/user-documents", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-documents"] });
      toast({ title: "Document saved" });
      setOpen(false);
    },
    onError: (e: Error) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const pasteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/user-documents/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pasteName, text: pasteText }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-documents"] });
      toast({ title: "Text saved as document" });
      setPasteName("");
      setPasteText("");
      setOpen(false);
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/user-documents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-documents"] });
      toast({ title: "Document deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(f => uploadMutation.mutate(f));
  };

  const handleUse = async (doc: DocMeta) => {
    try {
      const res = await fetch(`/api/user-documents/${doc.id}/text`);
      const data = await res.json();
      if (onUseDocument) onUseDocument(data.originalName, data.text);
      setOpen(false);
      toast({ title: `"${doc.originalName}" loaded into chat` });
    } catch {
      toast({ title: "Failed to load document", variant: "destructive" });
    }
  };

  const handleDownload = (doc: DocMeta) => {
    window.open(`/api/user-documents/${doc.id}/download`, "_blank");
  };

  const docs = data?.documents ?? [];

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(true)}
        data-testid="button-open-documents"
      >
        <FolderOpen className="w-4 h-4" />
        <span className="hidden sm:inline">My Documents</span>
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-background border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-primary" />
                <h2 className="font-semibold text-lg">My Documents</h2>
                <span className="text-sm text-muted-foreground">({docs.length} stored)</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} data-testid="button-close-documents">
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Tabs */}
            <div className="flex border-b px-4">
              <button
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === "upload" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => setTab("upload")}
                data-testid="tab-upload"
              >
                <Upload className="w-4 h-4" /> Upload File
              </button>
              <button
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === "paste" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => setTab("paste")}
                data-testid="tab-paste"
              >
                <ClipboardPaste className="w-4 h-4" /> Paste Text
              </button>
            </div>

            {/* Tab content */}
            <div className="px-4 pt-4">
              {tab === "upload" && (
                <>
                  <div
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${dragging ? "border-primary bg-primary/5" : "border-muted-foreground/30 hover:border-primary/50"}`}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
                    data-testid="dropzone-documents"
                  >
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm font-medium">Drop files here or click to upload</p>
                    <p className="text-xs text-muted-foreground mt-1">.txt · .md · .pdf · .doc · .docx · up to 10 MB each</p>
                    {uploadMutation.isPending && (
                      <p className="text-xs text-primary mt-2 animate-pulse">Uploading…</p>
                    )}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    accept=".txt,.md,.pdf,.doc,.docx"
                    multiple
                    onChange={e => handleFiles(e.target.files)}
                  />
                </>
              )}

              {tab === "paste" && (
                <div className="space-y-3">
                  <input
                    type="text"
                    placeholder="Name this document (optional)"
                    value={pasteName}
                    onChange={e => setPasteName(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    data-testid="input-paste-name"
                  />
                  <textarea
                    placeholder="Paste or type your text here…"
                    value={pasteText}
                    onChange={e => setPasteText(e.target.value)}
                    rows={7}
                    className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                    data-testid="textarea-paste-text"
                  />
                  <Button
                    className="w-full"
                    disabled={!pasteText.trim() || pasteMutation.isPending}
                    onClick={() => pasteMutation.mutate()}
                    data-testid="button-save-paste"
                  >
                    {pasteMutation.isPending ? "Saving…" : "Save as Document"}
                  </Button>
                </div>
              )}
            </div>

            {/* Document list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 mt-2">
              {isLoading && (
                <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
              )}
              {!isLoading && docs.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No documents yet.</p>
              )}
              {docs.map(doc => (
                <div
                  key={doc.id}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors"
                  data-testid={`row-document-${doc.id}`}
                >
                  <FileText className="w-5 h-5 text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" title={doc.originalName}>{doc.originalName}</p>
                    <p className="text-xs text-muted-foreground">{fmtSize(doc.sizeBytes)} · {fmtDate(doc.uploadedAt)}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {onUseDocument && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Load into chat"
                        onClick={() => handleUse(doc)}
                        data-testid={`button-use-document-${doc.id}`}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Download"
                      onClick={() => handleDownload(doc)}
                      data-testid={`button-download-document-${doc.id}`}
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete"
                      onClick={() => deleteMutation.mutate(doc.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-document-${doc.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
