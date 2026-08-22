export function prepareSourceQuotation(quotation: string): string {
  return quotation.replace(/\s+/g, " ").trim();
}