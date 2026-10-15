import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ThinkingQuoteBank } from "../../shared/thinking-quotes";

const cache = new Map<string, Promise<ThinkingQuoteBank>>();

export function getThinkingQuoteBank(thinkerId: string): Promise<ThinkingQuoteBank> {
  // The UI supplies canonical IDs, never a fuzzy author-name search.
  if (!/^[a-z_]{2,40}$/.test(thinkerId)) {
    return Promise.reject(new Error("Unknown thinker"));
  }
  let bank = cache.get(thinkerId);
  if (!bank) {
    bank = readFile(path.join(process.cwd(), "server/data/thinking-quotes", `${thinkerId}.json`), "utf8")
      .then((content) => {
        const parsed = JSON.parse(content) as ThinkingQuoteBank;
        if (parsed.thinkerId !== thinkerId || !parsed.items?.length) {
          throw new Error("Source quotation bank is unavailable");
        }
        return parsed;
      }).catch((error) => {
        cache.delete(thinkerId);
        throw error;
      });
    cache.set(thinkerId, bank);
  }
  return bank;
}
