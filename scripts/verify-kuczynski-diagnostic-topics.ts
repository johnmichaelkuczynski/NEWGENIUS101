import { askThinker, ThinkerProbe } from "../server/services/thinkerProbeTest.js";

export const KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS = [
  "What is the difference between semantics and presemantics?",
  "Does Frege's puzzle require a theory of sense?",
  "Are propositional attitudes relations to sentences?",
  "Is skepticism refutable?",
  "What is the relation between knowledge by description and knowledge by acquaintance?",
  "Must a justified believer be able to state his reasons?",
  "Are there natural kinds?",
  "Is defeasible inference a species of deduction?",
  "Are numbers objects?",
  "Is self-deception a refusal to spell out?",
  "Can a man consciously believe p and unconsciously believe not-p?",
  "Is supervaluationism a solution to anything?",
  "Is wealth a continuous scale?",
] as const;

const probe: ThinkerProbe = {
  id: "kuczynski",
  name: "Kuczynski",
  questions: [
    KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS[0],
    KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS[1],
    KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS[2],
  ],
};

async function main() {
  const explicitBase = process.argv.find((argument) => argument.startsWith("http"));
  const originBase = explicitBase
    || process.env.APP_ORIGIN
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "");
  if (!originBase) {
    throw new Error("Pass the running app origin or set APP_ORIGIN/REPLIT_DEV_DOMAIN");
  }

  const results = [];
  for (let offset = 0; offset < KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS.length; offset += 4) {
    const batch = KUCZYNSKI_GROUNDED_TOPIC_QUESTIONS.slice(offset, offset + 4);
    results.push(...await Promise.all(
      batch.map((question) => askThinker(
        originBase,
        probe,
        question,
        undefined,
        "Kuczynski grounded topics",
      )),
    ));
  }

  const report = results.map((result) => ({
    question: result.details?.question,
    status: result.status,
    answerType: result.details?.answerType,
    directCount: result.details?.directCount || 0,
    works: result.details?.works || [],
    quotationCount: Array.isArray(result.details?.representativeQuotations)
      ? result.details.representativeQuotations.length
      : 0,
    message: result.message,
  }));
  console.log(JSON.stringify(report, null, 2));

  const failures = report.filter((result) => result.status !== "pass");
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${report.length} grounded Kuczynski topics failed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});