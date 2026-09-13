export type PaperStreamEvent =
  | { type: "content"; content: string }
  | { type: "reset" }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "metadata"; data: Record<string, unknown> };

export interface PaperSseParser {
  push(chunk: string): PaperStreamEvent[];
  finish(): PaperStreamEvent[];
}

function parseDataLine(line: string): PaperStreamEvent | null {
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trimStart().trimEnd();
  if (!data) return null;
  if (data === "[DONE]") return { type: "done" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as Record<string, unknown>;
  if (typeof event.error === "string" && event.error) {
    return { type: "error", message: event.error };
  }
  if (event.reset_content === true) return { type: "reset" };
  if (typeof event.content === "string" && event.content) {
    return { type: "content", content: event.content };
  }
  return { type: "metadata", data: event };
}

export function createPaperSseParser(): PaperSseParser {
  let buffer = "";

  const drain = (includeRemainder: boolean): PaperStreamEvent[] => {
    const lines = buffer.split(/\r?\n/);
    buffer = includeRemainder ? "" : (lines.pop() ?? "");

    return lines
      .map(parseDataLine)
      .filter((event): event is PaperStreamEvent => event !== null);
  };

  return {
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}