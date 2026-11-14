import { createHash } from "node:crypto";

export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
export const contentIdentity = (text: string) => fingerprint(
  text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""),
);

/** Database copy only: callers must never overwrite the uploaded original. */
export function cleanGutenberg(raw: string) {
  let text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const start = /^[^\n]*\*{3}\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*$/im.exec(text);
  if (start) text = text.slice(start.index + start[0].length);
  const end = /^[^\n]*(?:\*{3}\s*END OF (?:THE|THIS) PROJECT GUTENBERG|End of (?:the )?Project Gutenberg)[^\n]*$/im.exec(text);
  if (end) text = text.slice(0, end.index);
  // Some uploaded books already have the wrapper manually removed, leaving a
  // truncated header or the credited digitization paragraph after the marker.
  text = text.replace(/^\s*The Project Gutenb[^\n]*\n/i, "");
  text = text.replace(/^\s*Produced by [\s\S]*?(?:\n[ \t]*\n)/i, "");
  const transcriber = /^(?:[ \t]*\[\s*Transcriber['’]s Notes?\s*[:\]]|[ \t]*Transcriber['’]s Notes?\s*:)/gim;
  for (const marker of text.matchAll(transcriber)) {
    if (marker.index! > text.length * 0.8) {
      text = text.slice(0, marker.index);
      break;
    }
  }
  return text.trim();
}

export function importChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1500, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf(".", end), text.lastIndexOf("\n", end));
      if (boundary > start + 750) end = boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 100) chunks.push(chunk);
    // An explicit final-boundary stop prevents repeatedly emitting the last
    // overlap forever, including when the final tail is under 200 characters.
    if (end === text.length) break;
    start = Math.max(start + 1, end - 200);
  }
  return chunks;
}
