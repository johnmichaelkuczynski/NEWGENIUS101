import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Download, Loader2, Music, FileAudio } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { sanitizeForElevenLabs, downloadAsUnixTxt } from "@/lib/elevenlabs";

interface Props {
  rawText: string;
  filename?: string;
}

export function ElevenLabsOutput({ rawText, filename = "dialogue.txt" }: Props) {
  const { toast } = useToast();
  const cleaned = sanitizeForElevenLabs(rawText);
  const [converting, setConverting] = useState<null | "mp3" | "wav">(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioExt, setAudioExt] = useState<"mp3" | "wav">("mp3");
  const [voiceMap, setVoiceMap] = useState<Record<string, string> | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleaned);
      toast({ title: "Copied", description: "ElevenLabs-ready text copied." });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const handleDownloadTxt = () => {
    downloadAsUnixTxt(cleaned, filename);
    toast({ title: "Downloaded", description: filename });
  };

  const handleConvert = async (format: "mp3" | "wav") => {
    if (converting) return;
    setConverting(format);
    try {
      const res = await fetch("/api/tts/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, format }),
      });

      if (!res.ok) {
        let msg = `Conversion failed (${res.status})`;
        try {
          const err = await res.json();
          if (err?.error) msg = err.error;
        } catch {}
        throw new Error(msg);
      }

      const vmHeader = res.headers.get("X-Voice-Map");
      if (vmHeader) {
        try {
          setVoiceMap(JSON.parse(decodeURIComponent(vmHeader)));
        } catch {}
      }

      const blob = await res.blob();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      setAudioUrl(url);
      setAudioExt(format);
      toast({ title: "Audio ready", description: `Converted to ${format.toUpperCase()}.` });
    } catch (e: any) {
      toast({
        title: "Audio conversion failed",
        description: e?.message || "Unknown error",
        variant: "destructive",
      });
    } finally {
      setConverting(null);
    }
  };

  const handleDownloadAudio = () => {
    if (!audioUrl) return;
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = filename.replace(/\.txt$/i, "") + "." + audioExt;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="mt-4 p-4 border border-primary/40 rounded-lg bg-primary/5 space-y-3"
      data-testid="elevenlabs-output-panel"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">ElevenLabs Audio</div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="default"
            size="sm"
            onClick={() => handleConvert("mp3")}
            disabled={!rawText.trim() || converting !== null}
            data-testid="button-elevenlabs-mp3"
          >
            {converting === "mp3" ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Music className="w-4 h-4 mr-1" />
            )}
            Generate MP3
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => handleConvert("wav")}
            disabled={!rawText.trim() || converting !== null}
            data-testid="button-elevenlabs-wav"
          >
            {converting === "wav" ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <FileAudio className="w-4 h-4 mr-1" />
            )}
            Generate WAV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!cleaned}
            data-testid="button-elevenlabs-copy"
          >
            <Copy className="w-4 h-4 mr-1" /> Copy Text
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownloadTxt}
            disabled={!cleaned}
            data-testid="button-elevenlabs-download"
          >
            <Download className="w-4 h-4 mr-1" /> .txt
          </Button>
        </div>
      </div>

      {converting && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="status-elevenlabs-converting"
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          Converting to {converting.toUpperCase()} — each character gets a distinct voice. Long
          dialogues can take a few minutes...
        </div>
      )}

      {audioUrl && !converting && (
        <div className="space-y-2" data-testid="panel-elevenlabs-audio">
          <div className="flex items-center gap-2 flex-wrap">
            <audio controls src={audioUrl} className="flex-1 min-w-[240px]" data-testid="audio-elevenlabs-player" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadAudio}
              data-testid="button-elevenlabs-download-audio"
            >
              <Download className="w-4 h-4 mr-1" /> Download {audioExt.toUpperCase()}
            </Button>
          </div>
          {voiceMap && (
            <div className="text-xs text-muted-foreground" data-testid="text-elevenlabs-voicemap">
              Voices: {Object.entries(voiceMap).map(([sp, v]) => `${sp} → ${v}`).join(" · ")}
            </div>
          )}
        </div>
      )}

      <pre
        className="whitespace-pre-wrap font-mono text-xs bg-background border rounded p-3 max-h-[300px] overflow-y-auto"
        data-testid="text-elevenlabs-cleaned"
      >
        {cleaned || "(awaiting valid speaker lines)"}
      </pre>
      <p className="text-xs text-muted-foreground">
        Generate MP3/WAV directly, or copy the text into ElevenLabs Studio manually.
      </p>
    </div>
  );
}
