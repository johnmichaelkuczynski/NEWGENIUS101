const REFERENCE_HEADING = /\n#{1,3}\s+Direct Quotations(?: Used)?\b/i;

export function getPaperBody(content: string): string {
  return content.split(REFERENCE_HEADING)[0].trim();
}

export function countWords(content: string): number {
  return content.split(/\s+/).filter((word) => word.length > 0).length;
}

export function countPaperBodyWords(content: string): number {
  return countWords(getPaperBody(content));
}