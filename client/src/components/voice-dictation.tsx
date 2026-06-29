import { useEffect, useRef, useState, useCallback } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Mode = "idle" | "recording" | "transcribing";

type Editable = HTMLInputElement | HTMLTextAreaElement | (HTMLElement & { isContentEditable: true });

function isEditable(el: EventTarget | null): el is Editable {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number", "password"].includes(t);
  }
  if (el.isContentEditable) return true;
  return false;
}

function describe(el: Editable): string {
  const placeholder = (el as HTMLInputElement).placeholder || "";
  const aria = el.getAttribute("aria-label") || "";
  const label = placeholder || aria || (el.tagName === "TEXTAREA" ? "text area" : "input");
  return label.length > 40 ? label.slice(0, 40) + "…" : label;
}

function insertText(el: Editable, text: string) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const needsSpaceBefore = before.length > 0 && !/\s$/.test(before) && !/^\s/.test(text);
    const insertion = (needsSpaceBefore ? " " : "") + text;
    const next = before + insertion + after;

    // Use the native setter so React's onChange fires (controlled inputs).
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, next);

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    const cursor = before.length + insertion.length;
    try { el.setSelectionRange(cursor, cursor); } catch {}
    el.focus();
  } else {
    // contenteditable: only reuse the existing selection if it actually lives
    // inside this element. Otherwise place the caret at the end of the element.
    el.focus();
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) range = r;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // place caret at end
    }
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function VoiceDictation() {
  const [mode, setMode] = useState<Mode>("idle");
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const lastFocusedRef = useRef<Editable | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const tickRef = useRef<number | null>(null);
  const { toast } = useToast();

  // Track last-focused editable element across the whole document.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (isEditable(e.target)) {
        lastFocusedRef.current = e.target as Editable;
        setTargetLabel(describe(e.target as Editable));
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Full cleanup on unmount: stop recorder, mic tracks, intervals, and clear buffers.
  useEffect(() => () => {
    try {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") mr.stop();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    streamRef.current = null;
    if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
    chunksRef.current = [];
    mediaRecorderRef.current = null;
  }, []);

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    streamRef.current = null;
    if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
  };

  const startRecording = useCallback(async () => {
    if (!lastFocusedRef.current || !document.body.contains(lastFocusedRef.current)) {
      toast({ title: "Click into a text box first", description: "Voice dictation types into whichever box you last selected.", variant: "destructive" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast({ title: "Microphone not available", description: "Your browser does not expose microphone access.", variant: "destructive" });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // Pick a mime type the browser actually supports.
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      let mimeType: string | undefined;
      for (const c of candidates) { if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) { mimeType = c; break; } }
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        chunksRef.current = []; // release recorded chunks immediately
        stopStream();
        if (blob.size < 500) {
          setMode("idle");
          toast({ title: "Recording too short", description: "Hold longer and try again.", variant: "destructive" });
          return;
        }
        await transcribeAndInsert(blob, mr.mimeType || "audio/webm");
      };
      mr.start();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      tickRef.current = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
      setMode("recording");
    } catch (err: any) {
      toast({ title: "Could not start microphone", description: err?.message || String(err), variant: "destructive" });
      stopStream();
      setMode("idle");
    }
  }, [toast]);

  const stopRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      setMode("transcribing");
      mr.stop();
    }
  }, []);

  const transcribeAndInsert = useCallback(async (blob: Blob, mime: string) => {
    try {
      const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
      const fd = new FormData();
      fd.append("audio", blob, `dictation.${ext}`);
      const resp = await fetch("/api/voice/transcribe", { method: "POST", body: fd });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t}`);
      }
      const data = await resp.json() as { text?: string; error?: string };
      if (data.error) throw new Error(data.error);
      const text = (data.text || "").trim();
      if (!text) {
        toast({ title: "Heard nothing", description: "No speech detected. Try again, closer to the mic.", variant: "destructive" });
        return;
      }
      const target = lastFocusedRef.current;
      if (!target || !document.body.contains(target)) {
        toast({ title: "Lost the target box", description: `Transcript: ${text}` });
        try { await navigator.clipboard.writeText(text); } catch {}
        return;
      }
      insertText(target, text);
    } catch (err: any) {
      toast({ title: "Dictation failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setMode("idle");
    }
  }, [toast]);

  const onClick = () => {
    if (mode === "idle") startRecording();
    else if (mode === "recording") stopRecording();
  };

  const seconds = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  const bg =
    mode === "recording" ? "bg-red-600 hover:bg-red-700"
    : mode === "transcribing" ? "bg-amber-600"
    : "bg-primary hover:bg-primary/90";

  const Icon = mode === "transcribing" ? Loader2 : mode === "recording" ? Square : Mic;

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col items-end gap-2 pointer-events-none">
      {targetLabel && mode !== "idle" && (
        <div
          className="bg-background border shadow-lg rounded-md px-3 py-1.5 text-xs text-muted-foreground pointer-events-auto"
          data-testid="dictation-target-label"
        >
          {mode === "recording" ? `Recording into "${targetLabel}" · ${mm}:${ss}` : `Transcribing into "${targetLabel}"…`}
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={mode === "transcribing"}
        className={`pointer-events-auto rounded-full ${bg} text-white shadow-xl flex items-center justify-center w-14 h-14 transition-colors disabled:opacity-80`}
        title={
          mode === "idle"
            ? targetLabel
              ? `Dictate into "${targetLabel}"`
              : "Click into a text box, then press to dictate"
            : mode === "recording"
            ? "Click to stop and transcribe"
            : "Transcribing…"
        }
        data-testid="button-voice-dictation"
        aria-label="Voice dictation"
      >
        <Icon className={`w-6 h-6 ${mode === "transcribing" ? "animate-spin" : mode === "recording" ? "" : ""}`} />
        {mode === "recording" && (
          <span className="absolute inline-flex h-14 w-14 rounded-full bg-red-500 opacity-40 animate-ping" />
        )}
      </button>
    </div>
  );
}
