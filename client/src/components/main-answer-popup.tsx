import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, LoaderCircle } from "lucide-react";

export type MainAnswerStatus = "waiting" | "streaming" | "complete" | "error";

interface MainAnswerPopupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thinkerName: string;
  content: string;
  status: MainAnswerStatus;
  error: string | null;
}

export function MainAnswerPopup({
  open,
  onOpenChange,
  thinkerName,
  content,
  status,
  error,
}: MainAnswerPopupProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const wasOpenRef = useRef(false);
  const [geometry, setGeometry] = useState(() => {
    if (typeof window === "undefined") {
      return { x: 32, y: 80, width: 620, height: 520 };
    }
    const width = Math.min(620, Math.max(1, window.innerWidth - 24));
    const height = Math.min(520, Math.max(1, window.innerHeight - 24));
    return {
      x: Math.max(12, Math.round((window.innerWidth - width) * 0.22)),
      y: Math.max(12, Math.round((window.innerHeight - height) / 2)),
      width,
      height,
    };
  });
  const interactionRef = useRef<{
    kind: "drag" | "resize";
    pointerId: number;
    startX: number;
    startY: number;
    startGeometry: typeof geometry;
  } | null>(null);

  const constrainGeometry = (next: typeof geometry) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxWidth = Math.max(1, viewportWidth - 24);
    const maxHeight = Math.max(1, viewportHeight - 24);
    const width = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), next.width));
    const height = Math.min(maxHeight, Math.max(Math.min(240, maxHeight), next.height));
    return {
      width,
      height,
      x: Math.max(0, Math.min(viewportWidth - width, next.x)),
      y: Math.max(0, Math.min(viewportHeight - height, next.y)),
    };
  };

  useEffect(() => {
    const keepInViewport = () => setGeometry((current) => constrainGeometry(current));
    window.addEventListener("resize", keepInViewport);
    return () => window.removeEventListener("resize", keepInViewport);
  }, []);

  useEffect(() => {
    if (open) setGeometry((current) => constrainGeometry(current));
  }, [open]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (open && !wasOpenRef.current) nearBottomRef.current = true;
    wasOpenRef.current = open;
    if (open && scrollElement && nearBottomRef.current) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  }, [content, open]);

  if (!open || typeof document === "undefined") return null;

  const startInteraction = (
    kind: "drag" | "resize",
    event: React.PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    interactionRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startGeometry: geometry,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveInteraction = (event: React.PointerEvent<HTMLElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;
    const next =
      interaction.kind === "drag"
        ? {
            ...interaction.startGeometry,
            x: interaction.startGeometry.x + dx,
            y: interaction.startGeometry.y + dy,
          }
        : {
            ...interaction.startGeometry,
            width: interaction.startGeometry.width + dx,
            height: interaction.startGeometry.height + dy,
          };
    setGeometry(constrainGeometry(next));
  };

  const endInteraction = (event: React.PointerEvent<HTMLElement>) => {
    if (interactionRef.current?.pointerId === event.pointerId) {
      interactionRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const distance = event.shiftKey ? 32 : 12;
    const deltas: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -distance, y: 0 },
      ArrowRight: { x: distance, y: 0 },
      ArrowUp: { x: 0, y: -distance },
      ArrowDown: { x: 0, y: distance },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    setGeometry((current) =>
      constrainGeometry({ ...current, x: current.x + delta.x, y: current.y + delta.y }),
    );
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const distance = event.shiftKey ? 32 : 12;
    const deltas: Record<string, { width: number; height: number }> = {
      ArrowLeft: { width: -distance, height: 0 },
      ArrowRight: { width: distance, height: 0 },
      ArrowUp: { width: 0, height: -distance },
      ArrowDown: { width: 0, height: distance },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    setGeometry((current) =>
      constrainGeometry({
        ...current,
        width: current.width + delta.width,
        height: current.height + delta.height,
      }),
    );
  };

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-50">
      <section
        className="pointer-events-auto fixed flex flex-col gap-0 overflow-hidden rounded-2xl border border-amber-200/70 bg-background p-0 shadow-2xl dark:border-slate-700"
        style={{
          left: geometry.x,
          top: geometry.y,
          width: geometry.width,
          height: geometry.height,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100dvh - 24px)",
        }}
        role="dialog"
        aria-modal="false"
        aria-label={`${thinkerName} answer`}
        data-testid="main-answer-popup"
      >
        <header
          className="shrink-0 touch-none cursor-move select-none border-b border-border/70 bg-muted/30 px-5 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-7"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            startInteraction("drag", event);
          }}
          onPointerMove={moveInteraction}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onKeyDown={moveWithKeyboard}
          tabIndex={0}
          role="group"
          aria-label="Move answer window. Use arrow keys to move; hold Shift to move farther."
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {status === "waiting" || status === "streaming" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
            ) : status === "error" ? (
              <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            )}
            <span>
              {status === "waiting"
                ? "Retrieving answer"
                : status === "streaming"
                  ? "Answer in progress"
                  : status === "error"
                    ? "Answer interrupted"
                    : "Answer complete"}
                </span>
              </div>
              <h2 className="text-xl font-semibold tracking-tight">{thinkerName}</h2>
              <p className="text-sm text-muted-foreground">
            {status === "waiting"
              ? "Your message was sent. Waiting for the author-grounded response to arrive."
              : status === "streaming"
                ? "The response is appearing as it is received."
                : status === "error"
                  ? "The response could not finish. Any text received so far is kept below."
                  : "The full response remains here while you continue your chat."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="shrink-0 rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close answer window"
              title="Close answer window"
              data-testid="button-close-main-answer-popup"
            >
              <span aria-hidden="true" className="block text-xl leading-none">×</span>
            </button>
          </div>
        </header>

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            nearBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7"
          aria-live="polite"
          aria-busy={status === "waiting" || status === "streaming"}
          data-testid="main-answer-popup-content"
        >
          {content ? (
            <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground">
              {content}
              {status === "streaming" && (
                <span className="ml-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary/70 align-middle" />
              )}
            </div>
          ) : status === "waiting" ? (
            <div className="flex min-h-[150px] flex-col items-center justify-center gap-3 text-center">
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary/50" />
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary/50 [animation-delay:150ms]" />
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary/50 [animation-delay:300ms]" />
              </div>
              <p className="text-sm text-muted-foreground">Waiting for the first words…</p>
            </div>
          ) : status === "error" ? (
            <p className="text-sm text-muted-foreground">No response text was received.</p>
          ) : (
            <p className="text-sm text-muted-foreground">No response text was returned.</p>
          )}
          {error && (
            <div
              role="alert"
              className="mt-5 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              data-testid="main-answer-popup-error"
            >
              {error}
            </div>
          )}
        </div>
        <div className="shrink-0 border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground sm:px-7">
          Closing this window will not stop the response.
        </div>
        <button
          type="button"
          className="absolute bottom-0 right-0 z-10 h-8 w-8 touch-none cursor-se-resize rounded-tl-lg border-l border-t border-border/70 bg-background/90 p-1.5 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          onPointerDown={(event) => startInteraction("resize", event)}
          onPointerMove={moveInteraction}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onKeyDown={resizeWithKeyboard}
          aria-label="Resize answer window. Use arrow keys to resize; hold Shift to resize farther."
          title="Drag or use arrow keys to resize"
          data-testid="main-answer-popup-resize"
        >
          <span
            aria-hidden="true"
            className="block h-full w-full rounded-sm"
            style={{
              background:
                "repeating-linear-gradient(135deg, transparent 0 3px, hsl(var(--muted-foreground) / .65) 3px 4px, transparent 4px 7px)",
            }}
          />
        </button>
      </section>
    </div>,
    document.body,
  );
}
