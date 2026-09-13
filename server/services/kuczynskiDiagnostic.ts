import { SelfTestEvent, TestResult } from "./selfTest";
import { askThinker, ThinkerProbe } from "./thinkerProbeTest";
import { KUCZYNSKI_PHILOSOPHY_QUESTIONS } from "./kuczynskiQuestionsPhilosophy";
import { KUCZYNSKI_ECONOMICS_QUESTIONS } from "./kuczynskiQuestionsEconomics";
import { KUCZYNSKI_PSYCHOLOGY_QUESTIONS } from "./kuczynskiQuestionsPsychology";
import { KUCZYNSKI_APPLIED_QUESTIONS } from "./kuczynskiQuestionsApplied";

const KUCZYNSKI_LEGACY_QUESTIONS = [
  "Does logic require the existence of non-spatiotemporal entities? Give the property-based argument.",
  "What is a property, and why is a property not identical with any of its instances?",
  "Can a non-spatiotemporal entity have causal powers?",
  "Why does the existence of properties follow from meaningful predication?",
  "What are propositions?",
  "What makes a proposition true?",
  "Can truth be reduced to correspondence between a proposition and a fact?",
  "Why are propositions not sentences or mental events?",
  "What is wrong with treating possible worlds as the basis of counterfactual truth?",
  "How should counterfactual conditionals be understood?",
  "Are laws of nature invariant with respect to every region of space?",
  "What distinguishes a law of nature from an accidental regularity?",
  "Why is causation a relation between events rather than objects?",
  "Can we observe causal connections?",
  "Why is persistence itself a causal notion?",
  "Why does spatial occupancy imply causal power?",
  "What is wrong with Aristotle's notion of formal causes?",
  "Can goals themselves be causes?",
  "Why does Hume's analysis fail to distinguish causation from epiphenomenal succession?",
  "What is the relation between causation and explanation?",
  "Do people think in natural language?",
  "Why must thought be possible before language can be learned?",
  "Can a person have a sophisticated thought that cannot yet be put into words?",
  "What is wrong with the language-of-thought hypothesis?",
  "How does Russell's theory of descriptions improve on Frege's semantics?",
  "Why is a definite description not a singular term?",
  "What does the sentence 'The present King of France is bald' logically assert?",
  "Why can grammatical form conceal logical form?",
  "What is a desire?",
  "Why is an intention not identical with one's strongest desire?",
  "Can a desire remain present when it is outweighed by another desire?",
  "How are values related to agency?",
  "Why must an agent value truth in order to value anything?",
  "What distinguishes evil from hatred?",
  "What makes unconscious mental activity necessary for explaining conscious thought?",
  "How is repression possible?",
  "What is the difference between having a belief and knowing that one has it?",
  "Why can rationalization preserve a belief while concealing its real basis?",
  "Why does self-deception not require a mind divided into separate persons?",
  "What role does anxiety play when repression breaks down?",
  "What does Libet's experiment actually show about free will?",
  "Why does neural activity preceding conscious awareness not disprove agency?",
  "What is wrong with identifying a decision with awareness of deciding?",
  "How does unconscious preparation relate to a conscious action?",
  "Why does Alcoholics Anonymous work?",
  "What psychological function is served by admitting powerlessness in Alcoholics Anonymous?",
  "Why is surrendering to a higher power essential in Alcoholics Anonymous?",
  "What is the difference between changing oneself and changing one's self?",
  "Why is psychological identity constrained by inborn biological structure?",
  "Why is the attempt to empiricize psychology not identical with making psychology scientific?",
  "Are there any genuinely non-extensional contexts?",
  "What is the difference between semantics and presemantics?",
  "Does the necessary a posteriori survive the semantics/presemantics distinction?",
  "Does Frege's puzzle require a theory of sense?",
  "Is indirect referentialism coherent?",
  "Does Russell's Theory of Descriptions correctly analyze definite descriptions?",
  "Are proper names rigid designators?",
  "What does Kripke's Pierre puzzle actually show about belief?",
  "Do substitution failures in belief contexts prove intensionality?",
  "Is conceptual atomism true?",
  "Is meaning determined by use?",
  "Is linguistic understanding a body of knowledge or an ability?",
  "Is the computational theory of mind true?",
  "Is any mentation subpersonal?",
  "Are propositional attitudes relations to sentences?",
  "Is intentionality reducible to causal covariation?",
  "Can a machine mean anything by what it outputs?",
  "Is thought prior to language or language to thought?",
  "Is skepticism refutable?",
  "What is the relation between knowledge by description and knowledge by acquaintance?",
  "Must a justified believer be able to state his reasons?",
  "Is the Gettier problem a real problem?",
  "Are perceptual beliefs inferential?",
  "Does the success of AI bear on the dispute between empiricism and rationalism?",
  "Is empiricism defensible in any form?",
  "Are properties abstract objects?",
  "Are counterfactuals to be understood in terms of possible worlds?",
  "Are laws of nature necessarily invariant with respect to all regions of space?",
  "Is causation a relation between events or between facts?",
  "Are there natural kinds?",
  "Is classical logic ampliative or merely transformative?",
  "Can deduction yield new knowledge?",
  "Is defeasible inference a species of deduction?",
  "What is System L and what does classical logic fail to do that it does?",
  "Is logical form a property of sentences or of propositions?",
  "Is mathematics reducible to logic?",
  "Are numbers objects?",
  "Is mathematical knowledge a priori?",
  "How should imaginary numbers be represented?",
  "Explain why the concept of repression is coherent.",
  "Is a counternarrative necessary for repression?",
  "Is psychoanalysis an empirical theory or a hermeneutic one?",
  "Is self-deception a refusal to spell out?",
  "Can a man consciously believe p and unconsciously believe not-p?",
  "Does the sorites paradox show that \"rich\" is vague?",
  "Is supervaluationism a solution to anything?",
  "Is wealth a continuous scale?",
  "Is a law a command or an assurance of protection of a right?",
  "Is adjudication covert legislation?",
  "Is philosophy a matter of argument or of insight?",
  "Are properties in space-time?",
  "Is the property of being a rock identical with the set of rocks?",
  "Are there scattered objects?",
  "Does the Third Man Argument refute Platonism?",
  "Given that properties have no causal powers, do they explain anything?",
  "Are there uninstantiated properties?",
  "Is nominalism coherent?",
  "Are word-types properties?",
  "What is a proposition?",
  "What is truth?",
  "What does Frege's \"saturation\" actually amount to?",
  "Is Plato a constituent of the proposition that Plato snores?",
  "Is a proposition a set of possible worlds?",
  "Can possible-worlds semantics distinguish 1 + 1 = 2 from triangles have three sides?",
  "Is \"this sentence is false\" a sentence?",
  "Does Russell's paradox refute the Axiom of Comprehension?",
  "Is meaning use?",
  "Does Wittgenstein's rule-following argument show that thinking is not a psychological process?",
  "Is a private language possible?",
  "Is \"colorless green ideas sleep furiously\" meaningless?",
  "Do we think in words?",
  "Is there a language of thought?",
  "Is Grice right that sentence meaning derives from speaker meaning?",
  "Is conceptual role semantics tenable?",
  "What do semantic rules assign meanings to?",
  "Do definite descriptions refer to anything?",
  "Does Frege's sense/reference distinction survive scrutiny?",
  "Are there any intensional contexts?",
  "Does Quine's case against modal notions succeed?",
  "Is a tautology an analytic truth?",
  "Is formal truth a property of sentences or a relation between sentences and axiom-sets?",
  "Is logic about sentences or about propositions?",
  "What is a priori knowledge knowledge of?",
  "What are the two roles of sense-experience in cognition?",
  "Is mathematical knowledge perceptual?",
  "Is perceptual content ever singular?",
  "Is Searle right that all mentality is conscious?",
  "Is Hume's analysis of causation correct?",
  "Is constant conjunction or continuity the mark of causation?",
  "Are events constituents of the world?",
  "Is the deductive-nomological model of explanation correct?",
  "Is probabilistic causation ontological or merely epistemic?",
  "What is wrong with grue?",
  "Is induction justified?",
  "Is behaviorism anything other than empiricism?",
  "Is Lewisian functionalism a form of behaviorism?",
  "Is psychology reducible to physics?",
  "Did Berkeley anticipate Sellars on the myth of the given?",
  "Are emotions beliefs?",
] as const;

export const KUCZYNSKI_DIAGNOSTIC_QUESTIONS = [
  ...KUCZYNSKI_PHILOSOPHY_QUESTIONS,
  ...KUCZYNSKI_ECONOMICS_QUESTIONS,
  ...KUCZYNSKI_PSYCHOLOGY_QUESTIONS,
  ...KUCZYNSKI_APPLIED_QUESTIONS,
] as const;

const probe: ThinkerProbe = {
  id: "kuczynski",
  name: "Kuczynski",
  questions: [
    KUCZYNSKI_DIAGNOSTIC_QUESTIONS[0],
    KUCZYNSKI_DIAGNOSTIC_QUESTIONS[1],
    KUCZYNSKI_DIAGNOSTIC_QUESTIONS[2],
  ],
};

export async function* runKuczynskiDiagnostic(
  originBase: string,
  signal?: AbortSignal,
): AsyncGenerator<SelfTestEvent> {
  const startedAt = Date.now();
  const results: TestResult[] = [];
  const category = "Kuczynski 300-question proof";
  const concurrency = 4;

  yield {
    type: "log",
    data: {
      message: "Running 300 source-derived questions through the real Kuczynski chat endpoint. No questions are randomized or skipped.",
    },
  };

  const pending = new Map<number, Promise<{ questionNumber: number; result: TestResult }>>();
  let nextQuestionIndex = 0;

  while (
    (nextQuestionIndex < KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length || pending.size > 0)
    && !signal?.aborted
  ) {
    while (
      nextQuestionIndex < KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length
      && pending.size < concurrency
    ) {
      const questionIndex = nextQuestionIndex++;
      const questionNumber = questionIndex + 1;
      const question = KUCZYNSKI_DIAGNOSTIC_QUESTIONS[questionIndex];
      yield {
        type: "start",
        data: {
          name: `Kuczynski ${String(questionNumber).padStart(3, "0")}`,
          category,
        },
      };
      yield {
        type: "log",
        data: { message: `${questionNumber}/${KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length}: ${question}` },
      };
      pending.set(
        questionNumber,
        askThinker(originBase, probe, question, signal, category).then((result) => ({
          questionNumber,
          result: {
            ...result,
            name: `Kuczynski ${String(questionNumber).padStart(3, "0")}`,
            details: {
              ...result.details,
              questionNumber,
              totalQuestions: KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length,
            },
          },
        })),
      );
    }

    if (pending.size === 0) break;
    const completed = await Promise.race(pending.values());
    pending.delete(completed.questionNumber);
    results.push(completed.result);
    yield { type: "result", data: completed.result };
  }

  if (signal?.aborted && pending.size > 0) {
    await Promise.allSettled(pending.values());
  }

  const completed = results.length;
  const missing = KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length - completed;
  yield {
    type: "summary",
    data: {
      totalTests: KUCZYNSKI_DIAGNOSTIC_QUESTIONS.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed: results.filter((result) => result.status === "fail").length + missing,
      skipped: 0,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      results,
    },
  };
}