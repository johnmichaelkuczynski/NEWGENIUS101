import { createPaperSseParser, type PaperStreamEvent } from "./paper-sse";

export async function readDialogueStream(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (event: PaperStreamEvent) => void,
) {
  if (!body) throw new Error("The dialogue response contained no stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createPaperSseParser();
  const deliver = (events: PaperStreamEvent[]) => {
    for (const event of events) {
      if (event.type === "error") throw new Error(event.message);
      onEvent(event);
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      deliver(parser.push(decoder.decode(value, { stream: true })));
    }
    deliver(parser.push(decoder.decode()));
    deliver(parser.finish());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
