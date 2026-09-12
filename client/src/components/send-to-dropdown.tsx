import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DestinationType =
  | "chat"
  | "model"
  | "paper"
  | "quote"
  | "position"
  | "argument"
  | "dialogue"
  | "interview"
  | "debate"
  | "reconstructor"
  | "outline"
  | "fullDocument";

export const DESTINATION_TYPES: ReadonlyArray<{ type: DestinationType; label: string }> = [
  { type: "chat", label: "Chat Input" },
  { type: "model", label: "Model Builder" },
  { type: "paper", label: "Paper Writer" },
  { type: "quote", label: "Quote Generator" },
  { type: "position", label: "Position Generator" },
  { type: "argument", label: "Argument Generator" },
  { type: "dialogue", label: "Dialogue Creator" },
  { type: "interview", label: "Interview Creator" },
  { type: "debate", label: "Debate Creator" },
  { type: "reconstructor", label: "Document Reconstructor" },
  { type: "outline", label: "Strict Outline" },
  { type: "fullDocument", label: "Full Document Generator" },
];

interface SendToDropdownProps {
  content: string;
  onTransfer: (content: string, destination: DestinationType) => void;
  testId?: string;
}

/** The shared, intentionally small transfer control used beneath generated outputs. */
export function SendToDropdown({ content, onTransfer, testId = "button-send-to" }: SendToDropdownProps) {
  if (!content.trim()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 gap-1" data-testid={testId}>
          Send to
          <ArrowRight className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {DESTINATION_TYPES.map(({ type, label }) => (
          <DropdownMenuItem
            key={type}
            onClick={() => onTransfer(content, type)}
            data-testid={`menu-send-to-${type}`}
          >
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}