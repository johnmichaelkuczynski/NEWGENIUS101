import type { KeyboardEventHandler, Ref } from "react";
import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface ExpandableInstructionsProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  dataTestId?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
}

export function ExpandableInstructions({
  label,
  value,
  onChange,
  placeholder = "Enter detailed instructions...",
  description,
  rows = 3,
  disabled,
  className,
  dataTestId,
  inputRef,
  onKeyDown,
}: ExpandableInstructionsProps) {
  const [open, setOpen] = useState(false);
  const id = dataTestId ? `${dataTestId}-field` : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-2"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Open large editor
        </Button>
      </div>
      <Textarea
        id={id}
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
        data-testid={dataTestId}
      />
      {description && <p className="text-sm text-muted-foreground">{description}</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[94vw] max-w-5xl h-[86vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              Type or paste detailed instructions. Changes are retained when you close this editor.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            className="flex-1 min-h-[55vh] resize-none text-base leading-relaxed"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              {value.trim() ? value.trim().split(/\s+/).length.toLocaleString() : 0} words
            </span>
            <Button type="button" onClick={() => setOpen(false)}>
              Use These Instructions
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}