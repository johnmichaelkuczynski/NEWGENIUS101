import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Sparkles, Minimize2, Maximize2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ThinkingQuoteResponse } from "@shared/thinking-quotes";

interface ThinkingPanelProps {
  thinkerName: string;
  isActive: boolean;
  figureId?: string;
}

type PanelSize = 'full' | 'compact' | 'minimized';

export function ThinkingPanel({ thinkerName, isActive, figureId }: ThinkingPanelProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [panelSize, setPanelSize] = useState<PanelSize>('full');
  const groupRef = useRef<HTMLDivElement>(null);
  const [flowDuration, setFlowDuration] = useState(1200);
  // Prefetch on author selection, before generation starts, and reuse the bank.
  const { data, isError, isLoading } = useQuery<ThinkingQuoteResponse>({
    queryKey: ["/api/figures", figureId, "thinking-quotes"],
    enabled: !!figureId,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/figures/${encodeURIComponent(figureId!)}/thinking-quotes`, { signal });
      if (!response.ok) throw new Error("Source quotations are unavailable");
      const bank = await response.json() as ThinkingQuoteResponse;
      if (bank.thinkerId !== figureId || !Array.isArray(bank.items) || !bank.items.length) {
        throw new Error("Source quotations are unavailable");
      }
      return bank;
    },
  });
  const thoughts = useMemo(() => {
    if (!isActive || !data || data.thinkerId !== figureId) return [];
    const items = [...data.items];
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }, [data, figureId, isActive]);

  useEffect(() => {
    setCurrentIndex(0);
    if (!isActive || !thoughts.length) return;
    const timer = setInterval(() => setCurrentIndex(prev => (prev + 1) % thoughts.length), 8000);
    return () => clearInterval(timer);
  }, [thoughts, isActive]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => setFlowDuration(Math.max(group.getBoundingClientRect().height / 18, 30));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [thoughts, panelSize, isActive]);

  if (!isActive) return null;
  const statusText = !figureId ? "Select a thinker to view source quotations."
    : isLoading ? "Loading source quotations…"
    : isError || !thoughts.length ? "Source quotations are unavailable for this thinker." : null;

  // Minimized view - just a small bar
  if (panelSize === 'minimized') {
    return (
      <div 
        className="w-48 bg-[#0f172a] border-l border-[#3b82f6]/30 flex items-center justify-between p-2 cursor-pointer hover-elevate"
        onClick={() => setPanelSize('full')}
        data-testid="button-expand-thinking"
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[#3b82f6] animate-pulse" />
          <span className="text-xs text-[#3b82f6]">{thinkerName}</span>
        </div>
        <Maximize2 className="w-3 h-3 text-[#94a3b8]" />
      </div>
    );
  }

  // Compact view - header + current thought only
  if (panelSize === 'compact') {
    const currentThought = thoughts.length ? thoughts[currentIndex % thoughts.length] : undefined;
    return (
      <div className="w-56 bg-[#0f172a] border-l border-[#3b82f6]/30 flex flex-col shadow-inner">
        <div className="p-2 border-b border-[#3b82f6]/30 bg-[#0f172a] shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-[#3b82f6] animate-pulse" />
            <span className="text-xs text-[#3b82f6]">{thinkerName}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPanelSize('full')} data-testid="button-expand-thinking">
              <Maximize2 className="w-3 h-3 text-[#94a3b8]" />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPanelSize('minimized')} data-testid="button-minimize-thinking">
              <ChevronDown className="w-3 h-3 text-[#94a3b8]" />
            </Button>
          </div>
        </div>
        {currentThought && (
          <div className="p-2 text-xs text-[#f8fafc] italic font-serif line-clamp-2" title={`${currentThought.text} — ${currentThought.sourceTitle}`}>
            “{currentThought.text}”
          </div>
        )}
        {statusText && <p className="p-2 text-xs text-[#94a3b8]" role="status">{statusText}</p>}
        <div className="h-1 bg-[#1e293b]">
          <div className="h-full bg-[#3b82f6] animate-pulse" style={{ width: '100%' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-72 h-full min-h-0 bg-[#0f172a] border-l border-[#3b82f6]/30 backdrop-blur-sm flex flex-col shadow-inner">
      <div className="p-3 border-b border-[#3b82f6]/30 bg-[#0f172a] shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Brain className="w-5 h-5 text-[#3b82f6] animate-pulse" />
              <Sparkles className="w-3 h-3 text-[#3b82f6] absolute -top-1 -right-1 animate-bounce" />
            </div>
            <div>
              <p className="text-sm font-medium text-[#3b82f6]">
                {thinkerName} is thinking...
              </p>
              <p className="text-xs text-[#94a3b8] italic">
                From the author's writings
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPanelSize('compact')} data-testid="button-shrink-thinking">
              <Minimize2 className="w-3 h-3 text-[#94a3b8]" />
            </Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setPanelSize('minimized')} data-testid="button-minimize-thinking">
              <ChevronDown className="w-3 h-3 text-[#94a3b8]" />
            </Button>
          </div>
        </div>
      </div>
      
      <div className="flex-1 min-h-0 overflow-hidden motion-reduce:overflow-y-auto relative" data-testid="thinking-quotes-viewport">
        {statusText && <p className="p-4 text-xs text-[#94a3b8]" role="status">{statusText}</p>}
        {thoughts.length > 0 && (
          <div
            key={figureId}
            className="thinking-quote-flow absolute top-0 inset-x-0 px-4"
            style={{ animationDuration: `${flowDuration}s` }}
            data-testid="thinking-quotes-flow"
          >
            {[0, 1].map(copy => (
              <div key={copy} ref={copy === 0 ? groupRef : undefined} aria-hidden={copy === 1 ? true : undefined} className={`space-y-4 pt-4 pb-4${copy === 1 ? " motion-reduce:hidden" : ""}`}>
                {thoughts.map((thought, idx) => (
                  <blockquote
                    key={`${thought.sourceId}-${thought.startOffset}-${idx}`}
                    className="text-xs leading-relaxed text-[#f8fafc] font-serif"
                    title={`${thought.sourceTitle}${thought.sourceFile ? ` · ${thought.sourceFile}` : ""}`}
                    data-source-id={thought.sourceId}
                    data-source-start={thought.startOffset}
                  >
                    <p className="italic"><span className="text-[#3b82f6]">“</span>{thought.text}<span className="text-[#3b82f6]">”</span></p>
                    <cite className="mt-1 block text-[10px] leading-snug text-[#94a3b8] not-italic">— {thinkerName}</cite>
                  </blockquote>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      
      <div className="p-2 border-t border-[#3b82f6]/30 bg-[#0f172a] shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-[#1e293b] rounded-full overflow-hidden">
            <div 
              className="h-full bg-[#3b82f6] rounded-full animate-pulse"
              style={{
                width: '100%',
                animation: 'shimmer 2s ease-in-out infinite'
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
