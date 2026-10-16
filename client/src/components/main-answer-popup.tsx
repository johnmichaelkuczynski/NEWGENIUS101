import { useEffect, useRef } from "react";
import { AlertCircle, Check, LoaderCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (open && !wasOpenRef.current) nearBottomRef.current = true;
    wasOpenRef.current = open;
    if (open && scrollElement && nearBottomRef.current) {
      scrollElement.scrollTop = scrollElement.scrollHeight;
    }
  }, [content, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-2xl border-amber-200/70 bg-background p-0 shadow-2xl dark:border-slate-700 sm:max-h-[78dvh]">
        <DialogHeader className="shrink-0 border-b border-border/70 bg-muted/30 px-5 py-4 pr-12 text-left sm:px-7">
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
          <DialogTitle className="text-xl font-semibold tracking-tight">
            {thinkerName}
          </DialogTitle>
          <DialogDescription className="text-sm">
            {status === "waiting"
              ? "Your message was sent. Waiting for the author-grounded response to arrive."
              : status === "streaming"
                ? "The response is appearing as it is received."
                : status === "error"
                  ? "The response could not finish. Any text received so far is kept below."
                  : "The full response remains here while you continue your chat."}
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            nearBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 72;
          }}
          className="min-h-[180px] flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7"
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
      </DialogContent>
    </Dialog>
  );
}
