import type { ThinkingQuotation } from "../../shared/thinking-quotes";

export interface QuotationSource {
  id: string;
  title: string;
  file: string | null;
  kind: ThinkingQuotation["sourceKind"];
  content: string;
}

export const prepareQuotationText = (text: string) => text.replace(/\s+/g, " ").trim();

export function normalizeWithOffsets(raw: string) {
  const breaks: Array<[number, number]> = [];
  let removed = 0;
  const text = raw.replace(/\s+/g, (space: string, index: number) => {
    if (space.length > 1) {
      const normalizedEnd = index - removed + 1;
      removed += space.length - 1;
      breaks.push([normalizedEnd, removed]);
    }
    return " ";
  });
  return {
    text,
    rawOffset(offset: number) {
      let low = 0;
      let high = breaks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (breaks[mid][0] <= offset) low = mid + 1;
        else high = mid;
      }
      return offset + (low ? breaks[low - 1][1] : 0);
    },
  };
}

// Only exact aliases. In particular, "james" must never match James Allen.
export function corpusThinkerId(id: string): string {
  return ({
    allen: "jamesallen",
    la_rochefoucauld: "larouchefoucauld",
    le_bon: "lebon",
  } as Record<string, string>)[id] || id;
}

const editorial = /\b(project gutenberg|ebook|e-book|copyright|all rights reserved|isbn|www\.|https?:|translat(?:or|ed by)|table of contents|printed (?:by|in)|published by|editor's|footnote|illustration|figure \d|page \d|chapter \d|vol\.)\b/i;
const dependentOpening = /^(?:he|she|they|his|her|their|these|those|this|thus|hence|however|moreover|furthermore|nevertheless|for example|for instance|as we have seen|as mentioned|in the preceding|in the following|let us now|we shall now|see also)\b/i;
const substance = /\b(?:truth|knowledge|reason|mind|thought|experience|nature|human|man|men|women|life|love|power|freedom|liberty|justice|society|science|law|cause|effect|belief|virtue|good|evil|will|moral|world|reality|consciousness|unconscious|personality|feeling|emotion|desire|pleasure|pain|meaning|value|beauty|art|logic|necessary|necessity|possible|impossible|existence|being|exist|understanding|principle|motion|body|bodies|space|time|number|quantity|matter|force|soul|religion|god|probability|certainty|education|learning|work|wealth|labor|labour|capital|property|government|state|democracy|crowd|instinct|self|character|habit|action|conduct|fact|evidence|explanation|infinite|finite|mathematics|language|idea|perception|sense|sensation|culture|opinion|attention|memory|theory|hypothesis|observation|animal|species|evolution|struggle|growth|development|equality|inequality|intelligence|success|courage|ambition|wisdom|pride|vanity|interest|selfishness|hypocrisy|honesty|sincerity)\b/gi;

export function isStandaloneQuotation(text: string): boolean {
  const opening = text.replace(/^["“‘]+/, "");
  if (/^(?:but|and|also|so|given|in conclusion|it follows|he|she|his|her|they|their|this|these|those|such|thus|hence|however|moreover|furthermore|nevertheless|therefore|let us|in this case|in that case)\b/i.test(opening)) return false;
  if (/\b(?:for example|for instance|e\.g\.|let us suppose|let us assume|suppose that|suppose we|imagine that|Larry|Sally|above-stated|aforementioned|aforesaid|one just given|in this story|as noted above|as we have seen|in the preceding)\b/i.test(text)) return false;
  return true;
}

/** Editorial screening, not an authorship claim: provenance is checked separately. */
export function quotationScore(text: string): number | null {
  if (text.length < 70 || text.length > 650) return null;
  if (!/^["“‘(]?[A-Z]/.test(text) || !/[.!?]["”’')\]]?$/.test(text)) return null;
  if (editorial.test(text) || dependentOpening.test(text) || !isStandaloneQuotation(text)) return null;
  if (/\.{3}|…|[_*#<>|{}]|\[\d+\]|(?:\d[\s.,]*){4,}|�/.test(text)) return null;
  if (/\b(?:said|wrote|says|writes|according to)\s+(?:Plato|Aristotle|Kant|Nietzsche|Galileo|Freud|Jung|Kuczynski)\b/i.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length < 12 || words.length > 110 || words.some(word => word.length > 35)) return null;
  // Avoid OCR columns, bibliographies, snippets of apparatus, and question lists.
  if ((text.match(/[;:]/g) || []).length > 3 || (text.match(/[?!]/g) || []).length > 1) return null;
  const concepts = new Set((text.match(substance) || []).map(word => word.toLowerCase()));
  if (!concepts.size) return null;
  if (!/\b(?:is|are|was|were|be|has|have|must|can|cannot|may|does|do|depends|consists|means|requires|makes|gives|lies|seems|becomes|exists|knows|know|understand|believe|ought|should|will|would)\b/i.test(text)) return null;
  return Math.min(concepts.size, 8) * 2
    + (/\b(?:not|but|because|only|without|never|every|all|nothing)\b/i.test(text) ? 3 : 0)
    + (text.length >= 120 && text.length <= 400 ? 3 : 0);
}

export interface RankedQuotation extends ThinkingQuotation {
  score: number;
}

/**
 * Every candidate is an intact sentence span of an actual source, never a
 * generated position or a rewritten quotation. Offsets refer to the raw source.
 */
export function sourceCandidates(source: QuotationSource, knownQuotes: Set<string>): RankedQuotation[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  // PDF extraction often puts a newline after EVERY WORD. Segment normalized
  // whitespace, but retain a reversible map to exact original source spans.
  const normalized = normalizeWithOffsets(source.content);
  let candidates: RankedQuotation[] = [];
  // Small windows keep ICU segmentation fast even for multi-megabyte books.
  for (let start = 0; start < normalized.text.length;) {
    let end = Math.min(start + 16_000, normalized.text.length);
    if (end < normalized.text.length) {
      const space = normalized.text.indexOf(" ", end);
      if (space >= 0 && space < end + 1000) end = space + 1;
    }
    const window = normalized.text.slice(start, end);
    for (const sentence of Array.from(segmenter.segment(window))) {
      // A window boundary can cut a sentence; never display that fragment.
      if (start > 0 && sentence.index === 0) continue;
      if (end < normalized.text.length && sentence.index + sentence.segment.length === window.length) continue;
      const raw = sentence.segment;
      const leading = raw.length - raw.trimStart().length;
      const startOffset = normalized.rawOffset(start + sentence.index + leading);
      const endOffset = normalized.rawOffset(start + sentence.index + raw.trimEnd().length);
      const text = prepareQuotationText(source.content.slice(startOffset, endOffset));
      const score = quotationScore(text);
      if (score === null) continue;
      candidates.push({
        text, sourceId: source.id, sourceTitle: source.title, sourceFile: source.file,
        sourceKind: source.kind, startOffset, endOffset,
        score: score + (knownQuotes.has(text) ? 12 : 0),
      });
    }
    if (candidates.length > 2500) {
      candidates.sort((a, b) => b.score - a.score || a.startOffset - b.startOffset);
      candidates = candidates.slice(0, 1200);
    }
    start = end;
  }
  return candidates.sort((a, b) => b.score - a.score || a.startOffset - b.startOffset).slice(0, 1200);
}

export function selectQuotations(candidates: RankedQuotation[], count = 100): ThinkingQuotation[] {
  // Prefer a variety of source works, without padding a sparse author.
  const pools = new Map<string, RankedQuotation[]>();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const pool = pools.get(candidate.sourceId) || [];
    pool.push(candidate);
    pools.set(candidate.sourceId, pool);
  }
  const selected: ThinkingQuotation[] = [];
  const seen = new Set<string>();
  while (selected.length < count) {
    let added = false;
    for (const pool of Array.from(pools.values())) {
      let candidate: RankedQuotation | undefined;
      while ((candidate = pool.shift())) {
        const key = candidate.text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
        if (seen.has(key)) continue;
        seen.add(key);
        const { score: _, ...quotation } = candidate;
        selected.push(quotation);
        added = true;
        break;
      }
      if (selected.length === count) break;
    }
    if (!added) break;
  }
  return selected;
}
