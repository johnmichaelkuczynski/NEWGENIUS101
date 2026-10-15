import { createPaperSseParser } from "./paper-sse";

/** Each call owns its reader, decoder, parser and text: columns cannot share state. */
export async function readComparisonStream(
  response: Response,
  onText: (text: string) => void,
): Promise<string> {
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream was received.");
  const decoder = new TextDecoder();
  const parser = createPaperSseParser();
  let text = "";
  let completed = false;
  const apply = (events: ReturnType<typeof parser.push>) => {
    for (const event of events) {
      if (completed) break;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "reset") {
        text = "";
        onText(text);
      } else if (event.type === "content") {
        text += event.content;
        onText(text);
      } else if (event.type === "done") {
        completed = true;
      } else if (event.type === "metadata") {
        // Older deployments can return a finished coherence answer as metadata.
        const coherence = event.data.coherenceEvent as { type?: string; data?: { output?: string } } | undefined;
        if (coherence?.type === "complete" && typeof coherence.data?.output === "string") {
          text = coherence.data.output;
          onText(text);
        }
      }
    }
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        apply(parser.push(decoder.decode()));
        apply(parser.finish());
        break;
      }
      apply(parser.push(decoder.decode(value, { stream: true })));
    }
    if (!completed) throw new Error("The response was interrupted. Any received text has been retained.");
    if (!text.trim()) throw new Error("The thinker returned no answer. Please retry.");
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
