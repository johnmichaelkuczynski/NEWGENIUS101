// Selection only: never repair, complete, paraphrase, or invent quotation text.
export interface RepresentativeQuote {
  quote: string;
  source?: string;
  topic?: string;
  reviewed?: boolean;
}

const apparatus = /\b(?:project gutenberg|copyright|all rights reserved|table of contents|translator['’]s (?:note|preface)|editor['’]s note|https?:\/\/|www\.)\b/i;
const crossReference = /\b(?:chapter|section|appendix|page|volume)\s+(?:\d+|[ivxlcdm]+)\b|\b(?:as (?:noted|mentioned|explained|shown|discussed) (?:above|below|earlier|previously)|see (?:also|above|below)|further references|references (?:will|can|may) be found)\b/i;
const incompleteOpening = /^(?:especially (?:when|if|since|because)|which|whose|whom|whereas|as (?:noted|mentioned) above)\b/i;
const concepts = /\b(?:truth|knowledge|reason|mind|thought|experience|nature|human|life|love|power|freedom|liberty|justice|society|science|law|cause|belief|virtue|good|evil|will|moral|world|consciousness|unconscious|personality|desire|pleasure|pain|meaning|value|logic|existence|principle|soul|religion|education|wealth|property|government|instinct|character|action|evidence|language|perception|evolution|intelligence|wisdom|friendship|friends)\b/gi;

export function isCompleteRepresentativeQuote(raw: string): boolean {
  const text = raw.trim();
  if (!/^[“"'‘(\[]*\p{Lu}/u.test(text) || !/[.!?][”"'’)\]]*$/.test(text)) return false;
  if (text.length < 15 || text.length > 2400 || /…|\.{3}|�/.test(text)) return false;
  if (/[<>{}|\\]|(?:\*_|\_\*)|\[<<\s*back\]|\(<<\s*back\)/i.test(text)) return false;
  if (apparatus.test(text) || crossReference.test(text)) return false;
  const opening = text.replace(/^[“"'‘(\[]+/, "");
  if (incompleteOpening.test(opening)) return false;
  // Reject unfinished clauses even if a bad import appended punctuation.
  if (/\b(?:and|or|but|because|although|whereas|that|which|of|to|from|with|by|the|a|an)[.!?][”"'’)\]]*$/i.test(text)) return false;
  return text.split(/\s+/).length >= 3;
}

export function selectRepresentativeQuotes(
  rows: RepresentativeQuote[], count: number, query = "",
): RepresentativeQuote[] {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])]
    .filter(term => term.length > 2 && !["the", "and", "for", "from", "with", "about", "quotes", "quotations"].includes(term));
  const seen = new Set<string>();
  return rows.filter(row => isCompleteRepresentativeQuote(row.quote))
    .map((row, order) => {
      const text = row.quote.toLowerCase();
      const matches = terms.filter(term => text.includes(term)).length;
      const significance = new Set((row.quote.match(concepts) || []).map(word => word.toLowerCase())).size;
      return { row, order, matches, score: matches * 100 + significance * 2 + (row.reviewed ? 30 : 0) + (row.quote.length >= 50 ? 1 : 0) };
    })
    .filter(item => !terms.length || item.matches > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .filter(({ row }) => {
      const key = row.quote.replace(/\s+/g, " ").trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, count)
    .map(({ row }) => row);
}

export function extractRepresentativeQuotes(text: string, count: number, query = ""): RepresentativeQuote[] {
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
  const candidates: RepresentativeQuote[] = [];
  for (const segment of sentences.segment(text)) {
    const quote = segment.segment.trim();
    if (isCompleteRepresentativeQuote(quote)) candidates.push({ quote });
  }
  return selectRepresentativeQuotes(candidates, count, query);
}
