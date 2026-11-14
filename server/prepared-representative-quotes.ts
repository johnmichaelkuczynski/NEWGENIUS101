import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ThinkingQuoteBank } from "../shared/thinking-quotes";
import { isCompleteRepresentativeQuote } from "./representative-quotes";

export const PREPARED_QUOTATION_COUNT = 100;
const cache = new Map<string, Promise<ThinkingQuoteBank>>();

export function validatePreparedBank(bank: ThinkingQuoteBank, thinkerId: string) {
  if (bank.thinkerId !== thinkerId || bank.items?.length !== PREPARED_QUOTATION_COUNT) {
    throw new Error(`Prepared quotation collection for ${thinkerId} must contain 100 quotations`);
  }
  const unique = new Set<string>();
  for (const item of bank.items) {
    const key = item.text?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || unique.has(key) || !isCompleteRepresentativeQuote(item.text)
      || !item.sourceId || !item.sourceTitle
      || !["database-text", "local-source"].includes(item.sourceKind)
      || !Number.isInteger(item.startOffset) || !Number.isInteger(item.endOffset)
      || item.startOffset < 0 || !(item.endOffset > item.startOffset)) {
      throw new Error(`Invalid prepared source quotation for ${thinkerId}`);
    }
    unique.add(key);
  }
  return bank;
}

export function getPreparedRepresentativeBank(thinkerId: string): Promise<ThinkingQuoteBank> {
  if (!/^[a-z_]{2,40}$/.test(thinkerId)) return Promise.reject(new Error("Unknown thinker"));
  let pending = cache.get(thinkerId);
  if (!pending) {
    pending = readFile(path.join(process.cwd(), "server/data/representative-quotes", `${thinkerId}.json`), "utf8")
      .then(text => validatePreparedBank(JSON.parse(text), thinkerId))
      .catch(error => { cache.delete(thinkerId); throw error; });
    cache.set(thinkerId, pending);
  }
  return pending;
}

/** Sample without replacement. Never mutate the cached collection. */
export function pickPreparedQuotations(bank: ThinkingQuoteBank, count: number, random = Math.random) {
  const items = [...bank.items];
  const limit = Math.min(Math.max(Math.trunc(count), 1), PREPARED_QUOTATION_COUNT);
  for (let i = 0; i < limit; i++) {
    const j = i + Math.min(items.length - i - 1, Math.floor(random() * (items.length - i)));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.slice(0, limit);
}
