import { useState, useRef, useCallback } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Copy,
  Play,
  X,
  Download,
  ArrowLeft,
  Stethoscope,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
  averageScore?: number;
  durationMs: number;
  timestamp: string;
  nodeVersion: string;
  environment: string;
  results: RowState[];
}

interface Check {
  key: string;
  label: string;
  endpoint: string;
  blurb: string;
}

const CHECKS: Check[] = [
  {
    key: "system",
    label: "System check",
    endpoint: "/api/admin/self-test/stream",
    blurb: "Checks the backend, database, AI providers, voice service, and the long-form generator.",
  },
  {
    key: "synthetic",
    label: "Synthetic-user test",
    endpoint: "/api/admin/synthetic-test/stream",
    blurb: "Acts like a real user: drives every feature (chat, paper, essay, model, quotes, dialogue, interview, debate) and verifies each one returns real output.",
  },
  {
    key: "accuracy",
    label: "Accuracy test",
    endpoint: "/api/admin/accuracy-test/stream",
    blurb: "Asks the app factual questions, then has Claude grade each answer 0–100 for accuracy.",
  },
];

const StatusIcon = ({ s }: { s: Status }) => {
  if (s === "running") return <Loader2 className="w-5 h-5 animate-spin text-blue-600" />;
  if (s === "pass") return <CheckCircle2 className="w-5 h-5 text-green-600" />;
  if (s === "fail") return <XCircle className="w-5 h-5 text-red-600" />;
  if (s === "skip") return <MinusCircle className="w-5 h-5 text-muted-foreground" />;
  return <span className="w-5 h-5 inline-block rounded-full border-2 border-muted-foreground/40" />;
};

function rowBg(s: Status): string {
  if (s === "pass") return "bg-green-50/70 border-green-200 dark:bg-green-950/20 dark:border-green-900";
  if (s === "fail") return "bg-red-50/70 border-red-200 dark:bg-red-950/20 dark:border-red-900";
  if (s === "skip") return "bg-muted/30 border-muted";
  if (s === "running") return "bg-blue-50/70 border-blue-200 dark:bg-blue-950/20 dark:border-blue-900";
  return "bg-card border-border";
}

export default function Diagnostics() {
  const [running, setRunning] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();

  const reset = () => {
    setRows([]);
    setSummary(null);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  };

  const start = useCallback(async (check: Check) => {
    reset();
    setRunning(true);
    setActiveKey(check.key);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch(check.endpoint, { signal: ctrl.signal });
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
          if (ev.type === "start") {
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
        toast({ title: "Diagnostics error", description: err?.message || String(err), variant: "destructive" });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [toast]);

  const buildReportText = (s: Summary): string => {
    const lines: string[] = [];
    lines.push(`ASK A GENIUS — DIAGNOSTICS REPORT`);
    lines.push(`========================================`);
    lines.push(`Timestamp:   ${s.timestamp}`);
    lines.push(`Environment: ${s.environment}`);
    lines.push(`Node:        ${s.nodeVersion}`);
    lines.push(`Duration:    ${(s.durationMs / 1000).toFixed(2)}s`);
    lines.push(``);
    lines.push(`SUMMARY: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (of ${s.totalTests})`);
    if (typeof s.averageScore === "number") lines.push(`AVERAGE ACCURACY: ${s.averageScore}/100`);
    lines.push(``);
    const byCat: Record<string, RowState[]> = {};
    for (const r of s.results) (byCat[r.category] ||= []).push(r);
    for (const cat of Object.keys(byCat)) {
      lines.push(`--- ${cat} ---`);
      for (const r of byCat[cat]) {
        lines.push(`  [${r.status.toUpperCase().padEnd(4)}]  ${r.name}  (${r.durationMs}ms)`);
        if (r.message) lines.push(`         ${r.message}`);
        if (r.details) lines.push(`         details: ${JSON.stringify(r.details)}`);
      }
      lines.push(``);
    }
    return lines.join("\n");
  };

  const copyReport = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(buildReportText(summary));
      toast({ title: "Report copied", description: "Paste it into an email to support." });
    } catch (e: any) {
      toast({ title: "Copy failed", description: e?.message || String(e), variant: "destructive" });
    }
  };

  const downloadReport = () => {
    if (!summary) return;
    const blob = new Blob([buildReportText(summary)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const allPass = summary && summary.failed === 0 && summary.skipped === 0;
  const someFail = summary && summary.failed > 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav */}
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Stethoscope className="w-5 h-5 text-primary" />
            <span className="font-semibold">Genius 101</span>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-muted-foreground hover:text-foreground" data-testid="link-home">
              Home
            </Link>
            <span className="font-semibold text-foreground border-b-2 border-primary pb-1" data-testid="nav-diagnostics-active">
              Diagnostics
            </span>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-6">
          <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4" data-testid="link-back-home">
            <ArrowLeft className="w-4 h-4" />
            Back to app
          </Link>
          <h1 className="text-4xl font-bold mb-3" data-testid="heading-diagnostics">Diagnostics</h1>
          <p className="text-muted-foreground max-w-2xl">
            Run these if anything in the app is not working. The <strong>System check</strong> tests
            the plumbing (backend, database, AI providers, voice). The{" "}
            <strong>Synthetic-user test</strong> acts like a real person and drives every feature to
            confirm it produces real output. The <strong>Accuracy test</strong> grades the app's
            answers against Claude. Each gives you a report you can copy and email to support.
          </p>
        </div>

        <div className="border rounded-lg bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 mb-5">
            <div className="flex flex-wrap items-center gap-2">
              {!running ? (
                CHECKS.map((c) => (
                  <Button
                    key={c.key}
                    onClick={() => start(c)}
                    variant={c.key === "system" ? "default" : "outline"}
                    className="gap-2"
                    data-testid={`button-run-${c.key}`}
                  >
                    <Play className="w-4 h-4" />
                    {c.label}
                  </Button>
                ))
              ) : (
                <Button onClick={stop} variant="destructive" className="gap-2" data-testid="button-stop-diagnostics">
                  <X className="w-4 h-4" />
                  Stop {CHECKS.find((c) => c.key === activeKey)?.label || "test"}
                </Button>
              )}
              {summary && !running && (
                <>
                  <Button onClick={copyReport} variant="outline" className="gap-2" data-testid="button-copy-report">
                    <Copy className="w-4 h-4" />
                    Copy report
                  </Button>
                  <Button onClick={downloadReport} variant="outline" className="gap-2" data-testid="button-download-report">
                    <Download className="w-4 h-4" />
                    Download
                  </Button>
                </>
              )}
            </div>
            {(running || summary) && activeKey && (
              <p className="text-xs text-muted-foreground" data-testid="text-active-check">
                {CHECKS.find((c) => c.key === activeKey)?.blurb}
              </p>
            )}
          </div>

          {/* Summary banner */}
          {summary && (
            <div
              className={`border rounded-md px-4 py-3 mb-3 flex items-center gap-3 ${
                allPass
                  ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-900"
                  : someFail
                  ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900"
                  : "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900"
              }`}
              data-testid="summary-banner"
            >
              {allPass ? (
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              ) : someFail ? (
                <XCircle className="w-5 h-5 text-red-600" />
              ) : (
                <MinusCircle className="w-5 h-5 text-amber-600" />
              )}
              <div>
                <div className="font-semibold text-sm">
                  {allPass
                    ? "All systems operational"
                    : someFail
                    ? `${summary.failed} system${summary.failed === 1 ? "" : "s"} failing`
                    : `${summary.skipped} skipped`}
                </div>
                <div className="text-xs text-muted-foreground">
                  Checked {summary.timestamp} · {summary.passed}/{summary.totalTests} passed
                  {typeof summary.averageScore === "number" && (
                    <> · avg accuracy <strong>{summary.averageScore}/100</strong></>
                  )}{" "}
                  · ran in {(summary.durationMs / 1000).toFixed(1)}s
                </div>
              </div>
            </div>
          )}

          {/* Empty state */}
          {rows.length === 0 && !running && !summary && (
            <div className="text-sm text-muted-foreground text-center py-12 border-2 border-dashed border-muted rounded-md">
              <Stethoscope className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="mb-1">Pick a check above to begin.</p>
              <p className="text-xs">System check ~30–60s · Synthetic-user and Accuracy tests can take a few minutes.</p>
            </div>
          )}

          {/* Test rows */}
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div
                key={`${r.name}-${i}`}
                className={`border rounded-md p-3 flex items-start gap-3 ${rowBg(r.status)}`}
                data-testid={`row-test-${r.name.replace(/\s+/g, "-").toLowerCase()}`}
              >
                <div className="pt-0.5"><StatusIcon s={r.status} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-sm">{r.name}</div>
                    <div className="text-xs text-muted-foreground flex-shrink-0">
                      {typeof r.durationMs === "number" && r.durationMs >= 0 ? `${r.durationMs} ms` : ""}
                    </div>
                  </div>
                  {r.message && (
                    <div
                      className={`text-xs mt-1 font-mono break-words ${
                        r.status === "fail" ? "text-red-700 dark:text-red-400" : "text-muted-foreground"
                      }`}
                    >
                      {r.message}
                    </div>
                  )}
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mt-1">{r.category}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center mt-6">
          This page is currently public. Anyone with the link can run diagnostics.
        </p>
      </main>
    </div>
  );
}
