import { useState, useRef, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Stethoscope, Loader2, CheckCircle2, XCircle, MinusCircle, Download, Play, X } from "lucide-react";

type Status = "pending" | "running" | "pass" | "fail" | "skip";

interface RowState {
  name: string;
  category: string;
  status: Status;
  message?: string;
  durationMs?: number;
  details?: any;
}

interface Summary {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  timestamp: string;
  nodeVersion: string;
  environment: string;
  results: RowState[];
}

const statusBadge = (s: Status) => {
  switch (s) {
    case "pass": return <Badge className="bg-green-600 hover:bg-green-600 text-white">PASS</Badge>;
    case "fail": return <Badge variant="destructive">FAIL</Badge>;
    case "skip": return <Badge variant="secondary">SKIP</Badge>;
    case "running": return <Badge className="bg-blue-600 hover:bg-blue-600 text-white">RUNNING</Badge>;
    default: return <Badge variant="outline">PENDING</Badge>;
  }
};

const StatusIcon = ({ s }: { s: Status }) => {
  if (s === "running") return <Loader2 className="w-4 h-4 animate-spin text-blue-600" />;
  if (s === "pass") return <CheckCircle2 className="w-4 h-4 text-green-600" />;
  if (s === "fail") return <XCircle className="w-4 h-4 text-red-600" />;
  if (s === "skip") return <MinusCircle className="w-4 h-4 text-muted-foreground" />;
  return <span className="w-4 h-4 inline-block rounded-full border border-muted-foreground/40" />;
};

export function SelfTestButton() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<RowState[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = () => {
    setRows([]);
    setLogs([]);
    setSummary(null);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const start = useCallback(async () => {
    reset();
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch("/api/admin/self-test/stream", { signal: ctrl.signal });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() || "";
        for (const block of blocks) {
          if (!block.startsWith("data:")) continue;
          const payload = block.slice(5).trim();
          if (payload === "[DONE]") continue;
          let ev: any;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === "log") {
            setLogs((l) => [...l, ev.data?.message || ""]);
          } else if (ev.type === "start") {
            setRows((rs) => [...rs, {
              name: ev.data.name,
              category: ev.data.category,
              status: "running",
            }]);
          } else if (ev.type === "result") {
            setRows((rs) => rs.map((r) =>
              r.name === ev.data.name && r.status === "running"
                ? { ...r, status: ev.data.status, message: ev.data.message, durationMs: ev.data.durationMs, details: ev.data.details }
                : r
            ));
          } else if (ev.type === "summary") {
            setSummary(ev.data);
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setLogs((l) => [...l, `ERROR: ${err?.message || err}`]);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, []);

  const downloadReport = () => {
    if (!summary) return;
    const lines: string[] = [];
    lines.push(`ASK A GENIUS — SELF-TEST REPORT`);
    lines.push(`========================================`);
    lines.push(`Timestamp:   ${summary.timestamp}`);
    lines.push(`Environment: ${summary.environment}`);
    lines.push(`Node:        ${summary.nodeVersion}`);
    lines.push(`Duration:    ${(summary.durationMs / 1000).toFixed(2)}s`);
    lines.push(``);
    lines.push(`SUMMARY: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (of ${summary.totalTests})`);
    lines.push(``);
    const byCat: Record<string, RowState[]> = {};
    for (const r of summary.results) {
      (byCat[r.category] ||= []).push(r);
    }
    for (const cat of Object.keys(byCat)) {
      lines.push(`--- ${cat} ---`);
      for (const r of byCat[cat]) {
        lines.push(`  [${r.status.toUpperCase().padEnd(4)}]  ${r.name}  (${r.durationMs}ms)`);
        lines.push(`         ${r.message || ""}`);
        if (r.details) lines.push(`         details: ${JSON.stringify(r.details)}`);
      }
      lines.push(``);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `self-test-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Group rows by category for display
  const grouped: Record<string, RowState[]> = {};
  for (const r of rows) (grouped[r.category] ||= []).push(r);

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="outline"
        size="sm"
        className="gap-2"
        data-testid="button-self-test"
        title="Run a live health check of all major systems"
      >
        <Stethoscope className="w-4 h-4" />
        Beta Test
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!running) setOpen(v); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="w-5 h-5" />
              System Self-Test
            </DialogTitle>
            <DialogDescription>
              Runs a live health check across the database, AI providers, voice service, and the long-form generator. Generates a downloadable report.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 border-b pb-3">
            {!running ? (
              <Button onClick={start} className="gap-2" data-testid="button-run-self-test">
                <Play className="w-4 h-4" />
                {summary ? "Run Again" : "Run Test"}
              </Button>
            ) : (
              <Button onClick={stop} variant="destructive" className="gap-2" data-testid="button-stop-self-test">
                <X className="w-4 h-4" />
                Stop
              </Button>
            )}
            {summary && (
              <Button onClick={downloadReport} variant="outline" className="gap-2" data-testid="button-download-report">
                <Download className="w-4 h-4" />
                Download Report
              </Button>
            )}
            {summary && (
              <div className="ml-auto flex items-center gap-3 text-sm">
                <span className="text-green-600 font-medium">{summary.passed} passed</span>
                <span className="text-red-600 font-medium">{summary.failed} failed</span>
                <span className="text-muted-foreground">{summary.skipped} skipped</span>
                <span className="text-muted-foreground">in {(summary.durationMs / 1000).toFixed(1)}s</span>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto pr-1 mt-3 space-y-4">
            {rows.length === 0 && !running && (
              <div className="text-sm text-muted-foreground text-center py-8">
                Click <strong>Run Test</strong> to begin. The test takes about 30–60 seconds and will:
                <ul className="text-left mt-3 list-disc list-inside space-y-1 max-w-md mx-auto">
                  <li>Verify database connectivity and schema</li>
                  <li>Ping every configured AI provider (Anthropic, OpenAI, DeepSeek, Grok, Perplexity)</li>
                  <li>Generate a real embedding</li>
                  <li>Verify Azure Speech configuration</li>
                  <li>Hit the public Figures API</li>
                  <li>Run a small live long-form generation (essay)</li>
                </ul>
              </div>
            )}

            {Object.keys(grouped).map((cat) => (
              <div key={cat}>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{cat}</div>
                <div className="border rounded-md divide-y">
                  {grouped[cat].map((r, i) => (
                    <div key={`${cat}-${i}`} className="p-3 flex items-start gap-3" data-testid={`test-row-${r.name.replace(/\s+/g, "-").toLowerCase()}`}>
                      <div className="pt-0.5"><StatusIcon s={r.status} /></div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-sm">{r.name}</div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {typeof r.durationMs === "number" && r.durationMs > 0 && (
                              <span className="text-xs text-muted-foreground">{r.durationMs}ms</span>
                            )}
                            {statusBadge(r.status)}
                          </div>
                        </div>
                        {r.message && (
                          <div className={`text-xs mt-1 ${r.status === "fail" ? "text-red-600" : "text-muted-foreground"}`}>
                            {r.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {logs.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Log</div>
                <pre className="text-xs bg-muted/30 border rounded-md p-2 whitespace-pre-wrap">{logs.join("\n")}</pre>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
