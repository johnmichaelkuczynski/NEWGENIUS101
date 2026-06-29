import { Button } from "@/components/ui/button";
import { Copy, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { sanitizeForElevenLabs, downloadAsUnixTxt } from "@/lib/elevenlabs";

interface Props {
  rawText: string;
  filename?: string;
}

export function ElevenLabsOutput({ rawText, filename = "dialogue.txt" }: Props) {
  const { toast } = useToast();
  const cleaned = sanitizeForElevenLabs(rawText);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleaned);
      toast({ title: "Copied", description: "ElevenLabs-ready text copied." });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const handleDownload = () => {
    downloadAsUnixTxt(cleaned, filename);
    toast({ title: "Downloaded", description: filename });
  };

  return (
    <div
      className="mt-4 p-4 border border-primary/40 rounded-lg bg-primary/5 space-y-3"
      data-testid="elevenlabs-output-panel"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">ElevenLabs-Ready Output</div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!cleaned}
            data-testid="button-elevenlabs-copy"
          >
            <Copy className="w-4 h-4 mr-1" /> Copy to Clipboard
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={!cleaned}
            data-testid="button-elevenlabs-download"
          >
            <Download className="w-4 h-4 mr-1" /> Download as .txt
          </Button>
        </div>
      </div>
      <pre
        className="whitespace-pre-wrap font-mono text-xs bg-background border rounded p-3 max-h-[300px] overflow-y-auto"
        data-testid="text-elevenlabs-cleaned"
      >
        {cleaned || "(awaiting valid speaker lines)"}
      </pre>
      <p className="text-xs text-muted-foreground">
        Paste this into ElevenLabs Studio, then assign a voice to Speaker 1 and Speaker 2.
      </p>
    </div>
  );
}
