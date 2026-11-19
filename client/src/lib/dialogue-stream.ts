import { createPaperSseParser, type PaperStreamEvent } from "./paper-sse";

export class DialogueAccessError extends Error {
  constructor(
    public readonly accessRequired: "google_login" | "payment",
    message: string,
  ) {
    super(message);
    this.name = "DialogueAccessError";
  }
}

/** Check the HTTP response before interpreting any bytes as generated dialogue. */
export async function readDialogueResponse(
  response: Response,
  onEvent: (event: PaperStreamEvent) => void,
) {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("application/json")) {
    let payload: Record<string, unknown>;
    try {
      const value: unknown = await response.json();
      payload = value && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
    } catch {
      throw new Error("The server returned an unreadable dialogue response. Your source has not been discarded.");
    }
    if (payload.accessRequired === "google_login" || payload.accessRequired === "payment") {
      throw new DialogueAccessError(
        payload.accessRequired,
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message
          : payload.accessRequired === "google_login"
            ? "Your free preview is complete. Sign in with Google to generate this dialogue."
            : "Your signed-in preview is complete. Full access is required to generate this dialogue.",
      );
    }
    const message = [payload.error, payload.message]
      .find((value): value is string => typeof value === "string" && !!value.trim());
    throw new Error(message || `The server returned no dialogue stream (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`The dialogue request failed (HTTP ${response.status}). Your source has not been discarded.`);
  }
  if (!contentType.includes("text/event-stream")) {
    throw new Error(contentType.includes("text/html")
      ? "The server returned a webpage instead of a dialogue stream. Your source has not been discarded."
      : "The server returned an unexpected response instead of a dialogue stream. Your source has not been discarded.");
  }

  let receivedText = false;
  let lastStatus = "";
  await readDialogueStream(response.body, event => {
    if (event.type === "content" && event.content.trim()) receivedText = true;
    if (event.type === "metadata" && typeof event.data.status === "string") {
      lastStatus = event.data.status;
    }
    onEvent(event);
  });
  if (!receivedText) {
    throw new Error(
      `The dialogue stream ended before any text arrived.${lastStatus ? ` Last server status: ${lastStatus}` : ""} Your source has not been discarded.`,
    );
  }
}

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
