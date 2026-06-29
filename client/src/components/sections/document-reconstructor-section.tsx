import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Wand2, StopCircle, Copy, Download, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DragDropUpload } from "@/components/ui/drag-drop-upload";

interface ChunkRow {
  index: number;
  inputWords: number;
  targetWords: number;
  actualWords?: number;
  status: "pending" | "processing" | "complete" | "retry" | "error";
  outputText?: string;
  delta?: { newClaims: string[]; termsUsed: string[]; conflicts: string[] };
}

interface Skeleton {
  thesis: string;
  outline: string[];
  keyTerms: Record<string, string>;
  commitments: { asserts: string[]; rejects: string[]; assumes: string[] };
  entities: string[];
}

interface StitchReport {
  conflictsFound: string[];
  repairPlan: string[];
  summary: string;
}

function countWords(t: string): number {
  return t.trim().split(/\s+/).filter(Boolean).length;
}

export function DocumentReconstructorSection() {
  const [originalText, setOriginalText] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [uploadedFileName, setUploadedFileName] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [jobInfo, setJobInfo] = useState<any>(null);
  const [skeleton, setSkeleton] = useState<Skeleton | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [stitch, setStitch] = useState<StitchReport | null>(null);
  const [completed, setCompleted] = useState<any>(null);
  const [error, setError] = useState<string>("");
  const [showSkeleton, setShowSkeleton] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  // Abort in-flight stream on unmount to avoid lingering fetch / setState.
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        try { abortRef.current.abort(); } catch {}
        abortRef.current = null;
      }
    };
  }, []);

  const inputWordCount = countWords(originalText);

  const handleFileAccepted = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/parse-file", { method: "POST", body: formData });
      if (!response.ok) throw new Error("Failed to parse file");
      const data = await response.json();
      setOriginalText(data.text);
      setUploadedFileName(file.name);
      toast({ title: "File loaded", description: `${file.name} — ${countWords(data.text)} words` });
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  const reset = () => {
    setStatusMessage("");
    setJobInfo(null);
    setSkeleton(null);
    setChunks([]);
    setStitch(null);
    setCompleted(null);
    setError("");
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      setStatusMessage("Stopping...");
    }
  };

  const handleRun = async () => {
    if (!originalText.trim() || originalText.trim().length < 50) {
      toast({ title: "Input too short", description: "Provide at least ~50 chars of input text.", variant: "destructive" });
      return;
    }
    reset();
    setIsRunning(true);
    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/reconstruction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originalText, customInstructions }),
        signal: abortRef.current.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          let evt: any;
          try { evt = JSON.parse(payload); } catch { continue; }

          switch (evt.type) {
            case "status":
              setStatusMessage(evt.data);
              break;
            case "job_init":
              setJobInfo(evt.data);
              // Pre-populate chunk rows
              setChunks(
                Array.from({ length: evt.data.numChunks }, (_, i) => ({
                  index: i,
                  inputWords: 0,
                  targetWords: evt.data.chunkTargetWords,
                  status: "pending" as const,
                }))
              );
              break;
            case "skeleton":
              setSkeleton(evt.data);
              break;
            case "chunk_start":
              setChunks(prev => prev.map(c => c.index === evt.data.index
                ? { ...c, status: "processing", inputWords: evt.data.inputWords, targetWords: evt.data.targetWords }
                : c));
              break;
            case "chunk_retry":
              setChunks(prev => prev.map(c => c.index === evt.data.index
                ? { ...c, status: "retry" }
                : c));
              break;
            case "chunk_done":
              setChunks(prev => prev.map(c => c.index === evt.data.index
                ? { ...c, status: "complete", actualWords: evt.data.actualWords, outputText: evt.data.outputText, delta: evt.data.delta }
                : c));
              break;
            case "stitch":
              setStitch(evt.data);
              break;
            case "complete":
              setCompleted(evt.data);
              setStatusMessage(`Complete — ${evt.data.finalWordCount} words`);
              break;
            case "error":
              setError(String(evt.data));
              break;
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        setStatusMessage("Aborted.");
      } else {
        setError(err.message || String(err));
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
    }
  };

  const getFinalOutput = (): string =>
    chunks.filter(c => c.status === "complete" && c.outputText).map(c => c.outputText).join("\n\n");

  const handleCopy = async () => {
    const text = getFinalOutput();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: `${countWords(text)} words` });
  };

  const handleDownload = () => {
    const text = getFinalOutput();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reconstruction-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const completedCount = chunks.filter(c => c.status === "complete").length;
  const progressPct = jobInfo ? (completedCount / jobInfo.numChunks) * 100 : 0;

  return (
    <Card data-testid="card-document-reconstructor">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wand2 className="w-5 h-5" />
          Document Reconstructor
          <Badge variant="outline" className="ml-2">3-pass CC</Badge>
        </CardTitle>
        <CardDescription>
          Transform long documents (compress, expand, rewrite) with cross-chunk coherence.
          Skeleton → constrained chunk processing with per-chunk length targets → stitch audit.
          All state persisted to Neon — resumable.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Input area */}
        <div className="space-y-2">
          <Label htmlFor="recon-input">Input document</Label>
          <DragDropUpload
            onFileAccepted={handleFileAccepted}
            accept=".txt,.md,.doc,.docx,.pdf"
            disabled={isRunning}
          />
          {uploadedFileName && (
            <div className="text-xs text-muted-foreground">Loaded: {uploadedFileName}</div>
          )}
          <Textarea
            id="recon-input"
            value={originalText}
            onChange={(e) => setOriginalText(e.target.value)}
            placeholder="Paste long text here, or upload a file above..."
            rows={10}
            disabled={isRunning}
            data-testid="textarea-recon-input"
          />
          <div className="text-xs text-muted-foreground">
            {inputWordCount.toLocaleString()} words
          </div>
        </div>

        {/* Instructions */}
        <div className="space-y-2">
          <Label htmlFor="recon-instructions">Transformation instructions</Label>
          <Textarea
            id="recon-instructions"
            value={customInstructions}
            onChange={(e) => setCustomInstructions(e.target.value)}
            placeholder='e.g. "Rewrite in plain English, target 3000 words" or "Compress to half length" or "Expand each section with examples"'
            rows={3}
            disabled={isRunning}
            data-testid="textarea-recon-instructions"
          />
          <div className="text-xs text-muted-foreground">
            Include a target word count (e.g. "5000 words" or "2000-3000 words") or a verbal cue ("half", "double", "compress", "expand"). Defaults to preserve length.
          </div>
        </div>

        {/* Run / Stop */}
        <div className="flex gap-2">
          <Button
            onClick={handleRun}
            disabled={isRunning || !originalText.trim()}
            data-testid="button-recon-run"
          >
            {isRunning ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Wand2 className="w-4 h-4 mr-2" />}
            {isRunning ? "Reconstructing..." : "Run reconstruction"}
          </Button>
          {isRunning && (
            <Button variant="destructive" onClick={handleStop} data-testid="button-recon-stop">
              <StopCircle className="w-4 h-4 mr-2" />
              Stop
            </Button>
          )}
        </div>

        {/* Status */}
        {statusMessage && (
          <div className="text-sm text-muted-foreground" data-testid="text-recon-status">
            {statusMessage}
          </div>
        )}
        {error && (
          <div className="text-sm text-destructive flex items-start gap-2" data-testid="text-recon-error">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Job info */}
        {jobInfo && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs p-3 bg-muted rounded-md" data-testid="grid-recon-jobinfo">
            <div><span className="text-muted-foreground">Input:</span> {jobInfo.totalInputWords.toLocaleString()} w</div>
            <div><span className="text-muted-foreground">Target:</span> {jobInfo.targetMinWords.toLocaleString()}–{jobInfo.targetMaxWords.toLocaleString()} w</div>
            <div><span className="text-muted-foreground">Mode:</span> <Badge variant="secondary" className="text-xs">{jobInfo.lengthMode}</Badge></div>
            <div><span className="text-muted-foreground">Ratio:</span> {jobInfo.lengthRatio.toFixed(2)}x</div>
            <div><span className="text-muted-foreground">Chunks:</span> {jobInfo.numChunks}</div>
            <div><span className="text-muted-foreground">Per chunk:</span> ~{jobInfo.chunkTargetWords} w</div>
            <div className="col-span-2"><span className="text-muted-foreground">Job ID:</span> <code className="text-[10px]">{jobInfo.jobId}</code></div>
          </div>
        )}

        {/* Skeleton */}
        {skeleton && (
          <Card>
            <CardHeader className="pb-2 cursor-pointer" onClick={() => setShowSkeleton(s => !s)}>
              <CardTitle className="text-sm flex items-center justify-between">
                <span>PASS 1 — Global Skeleton</span>
                {showSkeleton ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </CardTitle>
            </CardHeader>
            {showSkeleton && (
              <CardContent className="text-xs space-y-2" data-testid="card-recon-skeleton">
                <div><strong>Thesis:</strong> {skeleton.thesis}</div>
                <div>
                  <strong>Outline ({skeleton.outline.length}):</strong>
                  <ol className="list-decimal ml-5 mt-1 space-y-0.5">
                    {skeleton.outline.map((o, i) => <li key={i}>{o}</li>)}
                  </ol>
                </div>
                {Object.keys(skeleton.keyTerms).length > 0 && (
                  <div>
                    <strong>Key terms ({Object.keys(skeleton.keyTerms).length}):</strong>
                    <ul className="ml-5 mt-1 space-y-0.5">
                      {Object.entries(skeleton.keyTerms).slice(0, 10).map(([k, v]) => (
                        <li key={k}><code className="font-semibold">{k}</code>: {v}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {skeleton.commitments.asserts.length > 0 && (
                  <div>
                    <strong>Asserts:</strong>
                    <ul className="list-disc ml-5">{skeleton.commitments.asserts.slice(0, 6).map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </div>
                )}
                {skeleton.commitments.rejects.length > 0 && (
                  <div>
                    <strong>Rejects:</strong>
                    <ul className="list-disc ml-5">{skeleton.commitments.rejects.slice(0, 4).map((c, i) => <li key={i}>{c}</li>)}</ul>
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        )}

        {/* Chunk progress */}
        {chunks.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>PASS 2 — Chunks ({completedCount}/{chunks.length})</span>
                <Progress value={progressPct} className="w-32 h-2" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-64 overflow-y-auto space-y-1 text-xs" data-testid="list-recon-chunks">
                {chunks.map(c => {
                  const ratio = c.actualWords && c.targetWords ? c.actualWords / c.targetWords : 0;
                  const lengthOk = ratio >= 0.85 && ratio <= 1.15;
                  return (
                    <div key={c.index} className="flex items-center gap-2 p-1.5 rounded border">
                      <span className="font-mono w-10 text-right">#{c.index + 1}</span>
                      <Badge
                        variant={
                          c.status === "complete" ? (lengthOk ? "default" : "secondary") :
                          c.status === "processing" ? "outline" :
                          c.status === "retry" ? "secondary" :
                          c.status === "error" ? "destructive" : "outline"
                        }
                        className="text-[10px]"
                      >
                        {c.status === "processing" && <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />}
                        {c.status}
                      </Badge>
                      <span className="text-muted-foreground">
                        target {c.targetWords}w
                        {c.actualWords !== undefined && (
                          <> → <span className={lengthOk ? "text-foreground" : "text-amber-600 dark:text-amber-400 font-semibold"}>{c.actualWords}w</span></>
                        )}
                      </span>
                      {c.delta?.conflicts && c.delta.conflicts.length > 0 && (
                        <Badge variant="destructive" className="text-[10px]">
                          {c.delta.conflicts.length} conflict
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stitch */}
        {stitch && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">PASS 3 — Stitch Audit</CardTitle>
            </CardHeader>
            <CardContent className="text-xs space-y-2" data-testid="card-recon-stitch">
              <div><strong>Summary:</strong> {stitch.summary}</div>
              {stitch.conflictsFound.length > 0 && (
                <div>
                  <strong className="text-destructive">Conflicts ({stitch.conflictsFound.length}):</strong>
                  <ul className="list-disc ml-5">{stitch.conflictsFound.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
              {stitch.repairPlan.length > 0 && (
                <div>
                  <strong>Repair plan:</strong>
                  <ul className="list-disc ml-5">{stitch.repairPlan.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Final output */}
        {completed && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>Final Output — {completed.finalWordCount.toLocaleString()} words</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleCopy} data-testid="button-recon-copy">
                    <Copy className="w-3.5 h-3.5 mr-1" />Copy
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDownload} data-testid="button-recon-download">
                    <Download className="w-3.5 h-3.5 mr-1" />Download
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                readOnly
                value={getFinalOutput()}
                rows={16}
                className="font-serif text-sm"
                data-testid="textarea-recon-output"
              />
            </CardContent>
          </Card>
        )}
      </CardContent>
    </Card>
  );
}
