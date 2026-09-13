import fs from "node:fs";
import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";

const databaseUrl = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");

const apply = process.argv.includes("--apply");
const applyReport = process.argv.includes("--apply-report");
const sql = neon(databaseUrl);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const model = process.env.EXTRACTION_MODEL || "gpt-4o";

type QuoteRow = {
  id: string;
  quote_text: string;
  topic: string | null;
  source_text_id: string;
  title: string;
  content: string;
};

type Decision = {
  index: number;
  accept: boolean;
  complete: boolean;
  substantive: boolean;
  memorable: boolean;
  reason: string;
};

function cleanBoundary(text: string): boolean {
  const value = text.trim();
  return (
    value.length >= 80
    && /^[A-Z0-9“"'([]/.test(value)
    && /[.!?…”"')\]]$/.test(value)
  );
}

async function judgeBatch(rows: QuoteRow[]): Promise<Decision[]> {
  const candidates = rows
    .map(
      (row, index) =>
        `${index}\nWORK: ${row.title}\nTOPIC: ${row.topic || "unspecified"}\nQUOTE: ${JSON.stringify(row.quote_text)}`,
    )
    .join("\n\n");
  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are conducting a severe editorial audit of quotations for a serious philosopher's quotation generator.
Accept a quotation only when ALL are true:
1. It begins and ends cleanly and is not a sentence fragment, excerpt boundary, heading, list scrap, or dangling continuation.
2. It is self-contained enough to understand without omitted surrounding prose.
3. It states a philosophically substantive thesis, distinction, argument, explanation, objection, or conclusion.
4. It is memorable, incisive, and strong enough to represent the author.
5. It is not merely setup, transition, summary scaffolding, an isolated example, or a commonplace observation.
Be severe. When uncertain, reject it. Never preserve a weak quotation to satisfy a quota.`,
      },
      {
        role: "user",
        content: `Return strict JSON:
{"decisions":[{"index":0,"accept":true,"complete":true,"substantive":true,"memorable":true,"reason":"brief specific reason"}]}

${candidates}`,
      },
    ],
  });
  const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as {
    decisions?: Decision[];
  };
  return Array.isArray(parsed.decisions) ? parsed.decisions : [];
}

async function main() {
  if (applyReport) {
    const saved = JSON.parse(fs.readFileSync("quote-quality-audit.json", "utf8")) as {
      rejectedQuotes?: Array<{ id: string }>;
    };
    const rejectedIds = (saved.rejectedQuotes || []).map((row) => row.id);
    if (rejectedIds.length > 0) {
      await sql`DELETE FROM quotes WHERE id = ANY(${rejectedIds}::text[])`;
    }
    console.log(JSON.stringify({
      deleted: rejectedIds.length,
      source: "quote-quality-audit.json",
    }, null, 2));
    return;
  }

  const rows = (await sql`
    SELECT q.id, q.quote_text, q.topic, q.source_text_id, t.title, t.content
    FROM quotes q
    JOIN texts t ON t.id = q.source_text_id
    WHERE LOWER(q.thinker::text) = 'kuczynski'
    ORDER BY t.title, q.created_at, q.id
  `) as QuoteRow[];

  const rejected: Array<QuoteRow & { reasons: string[] }> = [];
  let accepted = 0;

  for (let start = 0; start < rows.length; start += 10) {
    const batch = rows.slice(start, start + 10);
    const decisions = new Map(
      (await judgeBatch(batch)).map((decision) => [Number(decision.index), decision]),
    );
    for (let index = 0; index < batch.length; index++) {
      const row = batch[index];
      const decision = decisions.get(index);
      const reasons: string[] = [];
      if (!row.content.includes(row.quote_text)) reasons.push("not an exact source substring");
      if (!cleanBoundary(row.quote_text)) reasons.push("unclean or fragmentary boundary");
      if (!decision) reasons.push("quality judge returned no decision");
      if (decision && !decision.complete) reasons.push("not complete");
      if (decision && !decision.substantive) reasons.push("not philosophically substantive");
      if (decision && !decision.memorable) reasons.push("not memorable or incisive");
      if (decision && !decision.accept) reasons.push(decision.reason || "editorially rejected");

      if (reasons.length > 0) rejected.push({ ...row, reasons });
      else accepted++;
    }
    console.log(`audited ${Math.min(start + batch.length, rows.length)}/${rows.length}`);
  }

  const report = {
    audited: rows.length,
    accepted,
    rejected: rejected.length,
    applied: apply,
    rejectedQuotes: rejected.map((row) => ({
      id: row.id,
      sourceTextId: row.source_text_id,
      work: row.title,
      quote: row.quote_text,
      reasons: row.reasons,
    })),
  };
  fs.writeFileSync("quote-quality-audit.json", JSON.stringify(report, null, 2));

  if (apply && rejected.length > 0) {
    const rejectedIds = rejected.map((row) => row.id);
    await sql`DELETE FROM quotes WHERE id = ANY(${rejectedIds}::text[])`;
  }

  console.log(JSON.stringify({
    audited: report.audited,
    accepted: report.accepted,
    rejected: report.rejected,
    applied: report.applied,
    report: "quote-quality-audit.json",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});