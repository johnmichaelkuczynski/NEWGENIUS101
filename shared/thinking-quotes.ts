export interface ThinkingQuotation {
  text: string;
  sourceId: string;
  sourceTitle: string;
  sourceFile: string | null;
  sourceKind: "database-text" | "local-source";
  startOffset: number;
  endOffset: number;
}

export interface ThinkingQuoteBank {
  thinkerId: string;
  items: ThinkingQuotation[];
}

export interface ThinkingQuoteResponse extends ThinkingQuoteBank {
  // Kept for callers of the original endpoint.
  quotes: string[];
}
