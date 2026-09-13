import { SelfTestEvent, TestResult } from "./selfTest";

interface ThinkerProbe {
  id: string;
  name: string;
  questions: [string, string, string];
}

const THINKER_PROBES: ThinkerProbe[] = [
  { id: "adler", name: "Adler", questions: ["Is the striving for superiority the single dynamic of all neurosis?", "Does organ inferiority explain character, or only compensation?", "Is the neurotic's goal chosen or suffered?"] },
  { id: "aesop", name: "Aesop", questions: ["Tell the fable of the belly and the members and give its moral.", "What becomes of the frog that tries to swell to the size of the ox?", "Is cunning superior to strength?"] },
  { id: "allen", name: "James Allen", questions: ["Do circumstances make the man?", "Can a man alter his condition by altering his thoughts?", "Is poverty a habit of mind?"] },
  { id: "aristotle", name: "Aristotle", questions: ["Is happiness a state or an activity?", "Can a man be virtuous without habituation?", "Is the soul separable from the body?"] },
  { id: "bacon", name: "Bacon", questions: ["Which of the Idols is most destructive to natural philosophy?", "Is induction by simple enumeration adequate?", "Should knowledge serve use?"] },
  { id: "bergler", name: "Bergler", questions: ["Is neurotic suffering unconsciously sought?", "Is writer's block a form of psychic masochism?", "Is the injustice collector the author of his own defeats?"] },
  { id: "bergson", name: "Bergson", questions: ["Is the time of physics real time?", "Can intelligence grasp life?", "Is evolution mechanical or driven by élan vital?"] },
  { id: "berkeley", name: "Berkeley", questions: ["Does anything exist unperceived?", "Is the distinction between primary and secondary qualities tenable?", "Are abstract general ideas possible?"] },
  { id: "le_bon", name: "Le Bon", questions: ["Is a crowd more or less intelligent than its members?", "Can crowds reason?", "What gives a leader power over a crowd?"] },
  { id: "confucius", name: "Confucius", questions: ["Should a ruler govern by law or by virtue?", "Must names be rectified before government can proceed?", "Why is filial piety the root?"] },
  { id: "darwin", name: "Darwin", questions: ["Can natural selection produce an organ like the eye?", "Is sexual selection reducible to natural selection?", "Are the moral sentiments products of evolution?"] },
  { id: "descartes", name: "Descartes", questions: ["Can the senses be trusted?", "Is the mind better known than the body?", "How do mind and body interact?"] },
  { id: "dewey", name: "Dewey", questions: ["Is the reflex arc a valid unit of psychology?", "Is education preparation for life or life itself?", "Is inquiry the resolution of an indeterminate situation?"] },
  { id: "dworkin", name: "Andrea Dworkin", questions: ["Is pornography speech?", "Is consent possible under conditions of male dominance?", "Can liberalism address male violence?"] },
  { id: "engels", name: "Engels", questions: ["What is the origin of the monogamous family?", "Is the state a permanent feature of society?", "Is nature dialectical?"] },
  { id: "freud", name: "Freud", questions: ["Why is condensation not mere abbreviation?", "Are all dreams wish-fulfillments?", "Is religion a neurosis?"] },
  { id: "galileo", name: "Galileo", questions: ["Do heavier bodies fall faster?", "Does the earth's motion contradict the evidence of the senses?", "Is nature written in mathematics?"] },
  { id: "gardner", name: "Gardner", questions: ["What makes an ability an intelligence rather than a talent?", "Is g a real thing?", "Can intelligences be measured by tests?"] },
  { id: "goldman", name: "Emma Goldman", questions: ["Is marriage compatible with love?", "Does the vote emancipate women?", "Is anarchism compatible with organization?"] },
  { id: "hegel", name: "Hegel", questions: ["Why does the bondsman and not the lord achieve self-consciousness?", "Is history rational?", "Is the state higher than civil society?"] },
  { id: "hobbes", name: "Hobbes", questions: ["Is the state of nature a historical condition?", "Can the sovereign do injustice to a subject?", "Is liberty compatible with necessity?"] },
  { id: "hume", name: "Hume", questions: ["Where does the idea of necessary connection come from?", "Can induction be justified?", "Is reason the slave of the passions?"] },
  { id: "james", name: "William James", questions: ["Is consciousness a thing or a process?", "Is truth what works?", "Is the will free?"] },
  { id: "jung", name: "Jung", questions: ["Is the unconscious personal or collective?", "What is individuation?", "Is the anima an autonomous complex?"] },
  { id: "kant", name: "Kant", questions: ["How is synthetic a priori knowledge possible?", "Can the categories apply to things in themselves?", "Is lying ever permissible?"] },
  { id: "kernberg", name: "Kernberg", questions: ["How does splitting differ from repression?", "Does the borderline patient retain reality testing?", "Is pathological narcissism a defense or a deficit?"] },
  { id: "kuczynski", name: "John-Michael Kuczynski", questions: ["Are counterfactuals to be understood in terms of possible worlds?", "Are laws of nature necessarily invariant with respect to all regions of space?", "Explain why the concept of repression is coherent."] },
  { id: "laplace", name: "Laplace", questions: ["Is chance a feature of the world or of our ignorance?", "Could a sufficient intelligence predict every future state?", "Is the solar system stable?"] },
  { id: "leibniz", name: "Leibniz", questions: ["Do monads interact?", "Is this the best of all possible worlds?", "Is space absolute or relational?"] },
  { id: "locke", name: "Locke", questions: ["Are there innate ideas?", "How does labor create property?", "What justifies revolution?"] },
  { id: "luther", name: "Luther", questions: ["Is man justified by works?", "Is the will free with respect to salvation?", "Should scripture be interpreted by the church?"] },
  { id: "machiavelli", name: "Machiavelli", questions: ["Is it better to be feared or loved?", "Should a prince keep his word?", "Are republics stronger than principalities?"] },
  { id: "maimonides", name: "Maimonides", questions: ["Can God be described positively?", "Was the world created or eternal?", "Should prophecy be understood naturalistically?"] },
  { id: "marden", name: "Orison Swett Marden", questions: ["Does expecting success produce it?", "Can a man without capital rise?", "Is poverty a habit of mind?"] },
  { id: "marx", name: "Marx", questions: ["Where does surplus value come from?", "Is commodity fetishism an illusion in people's heads?", "Does the rate of profit tend to fall?"] },
  { id: "mill", name: "Mill", questions: ["Are all pleasures equal in kind?", "May the state restrain purely self-regarding conduct?", "Is the subjection of women natural?"] },
  { id: "nietzsche", name: "Nietzsche", questions: ["What is the origin of guilt?", "Why does the ascetic ideal triumph?", "Is truth a value?"] },
  { id: "peirce", name: "Peirce", questions: ["How does abduction differ from induction?", "What does the pragmatic maxim say meaning is?", "Is chance real?"] },
  { id: "plato", name: "Plato", questions: ["Should the guardians own property?", "Is virtue teachable?", "What is the relation of mathematics to the Forms?"] },
  { id: "poincare", name: "Poincaré", questions: ["Is Euclidean geometry true?", "What part does the unconscious play in mathematical invention?", "Are scientific hypotheses conventions?"] },
  { id: "popper", name: "Popper", questions: ["What demarcates science from pseudoscience?", "Can a theory ever be verified?", "Is historicism defensible?"] },
  { id: "la_rochefoucauld", name: "La Rochefoucauld", questions: ["Are the virtues disguised self-love?", "Is gratitude ever disinterested?", "Why do we bear the misfortunes of our friends so well?"] },
  { id: "rousseau", name: "Rousseau", questions: ["Can a man be forced to be free?", "Is the general will the will of all?", "Did civilization corrupt man?"] },
  { id: "russell", name: "Russell", questions: ["What does \"the present King of France is bald\" mean?", "Are there classes?", "Is mathematics reducible to logic?"] },
  { id: "sartre", name: "Sartre", questions: ["What is bad faith?", "Is man condemned to be free?", "Can the look of the other be escaped?"] },
  { id: "schopenhauer", name: "Schopenhauer", questions: ["Is the will free?", "Why does art relieve suffering?", "Is life worth living?"] },
  { id: "smith", name: "Adam Smith", questions: ["What limits the division of labor?", "Does self-interest serve the public good?", "Does the division of labor injure the workman?"] },
  { id: "spencer", name: "Spencer", questions: ["Is society an organism?", "What is the law of evolution?", "Should the state relieve the poor?"] },
  { id: "stekel", name: "Stekel", questions: ["What does compulsive doubt conceal?", "Should analysis be short or long?", "Is a death instinct needed to explain neurosis?"] },
  { id: "tocqueville", name: "Tocqueville", questions: ["Does equality threaten liberty?", "What is the tyranny of the majority?", "Why are Americans both religious and free?"] },
  { id: "veblen", name: "Veblen", questions: ["Why does the leisure class waste?", "Is conspicuous consumption rational?", "Are engineers opposed to businessmen?"] },
  { id: "weyl", name: "Hermann Weyl", questions: ["Can the continuum be arithmetized?", "Are impredicative definitions legitimate?", "Is mathematics discovered or constructed?"] },
  { id: "whewell", name: "William Whewell", questions: ["What is colligation of facts?", "Is consilience of inductions evidence of truth?", "Are fundamental ideas supplied by the mind?"] },
];

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function askThinker(
  originBase: string,
  probe: ThinkerProbe,
  question: string,
  externalSignal?: AbortSignal,
): Promise<TestResult> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 180_000);
  const abort = () => ctrl.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(`${originBase}/api/figures/${probe.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: question,
        settings: {
          responseLength: 250,
          quoteFrequency: 0,
          selectedModel: "deepseek",
          enhancedMode: true,
          intensityLevel: 30,
          dialogueMode: false,
        },
      }),
      signal: ctrl.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const line = block.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          if (typeof event.content === "string") answer += event.content;
          if (typeof event.error === "string") throw new Error(event.error);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }

    const cleanAnswer = answer.trim();
    if (cleanAnswer.length < 20) throw new Error("Thinker returned no substantive answer");
    return {
      name: probe.name,
      category: "Thinker probes",
      status: "pass",
      durationMs: Date.now() - startedAt,
      message: `Answered: ${question}`,
      details: {
        thinkerId: probe.id,
        question,
        answer: cleanAnswer,
        words: cleanAnswer.split(/\s+/).length,
      },
    };
  } catch (error: any) {
    return {
      name: probe.name,
      category: "Thinker probes",
      status: "fail",
      durationMs: Date.now() - startedAt,
      message: error?.name === "AbortError" ? "Timed out or stopped" : error?.message || String(error),
      details: { thinkerId: probe.id, question, answer: "" },
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export async function* runThinkerProbeTest(
  originBase: string,
  signal?: AbortSignal,
): AsyncGenerator<SelfTestEvent> {
  const startedAt = Date.now();
  const results: TestResult[] = [];
  const cases = shuffled(
    THINKER_PROBES.map((probe) => ({
      probe,
      question: probe.questions[Math.floor(Math.random() * probe.questions.length)],
    })),
  );
  const concurrency = 4;

  yield {
    type: "log",
    data: {
      message: `Selected one random question for each of ${cases.length} thinkers and shuffled the run order.`,
    },
  };

  for (let offset = 0; offset < cases.length; offset += concurrency) {
    if (signal?.aborted) break;
    const batch = cases.slice(offset, offset + concurrency);
    for (const item of batch) {
      yield {
        type: "start",
        data: { name: item.probe.name, category: "Thinker probes" },
      };
      yield {
        type: "log",
        data: { message: `${item.probe.name}: ${item.question}` },
      };
    }
    const batchResults = await Promise.all(
      batch.map((item) => askThinker(originBase, item.probe, item.question, signal)),
    );
    for (const result of batchResults) {
      results.push(result);
      yield { type: "result", data: result };
    }
  }

  const completedIds = new Set(results.map((result) => result.details?.thinkerId));
  const missing = THINKER_PROBES.filter((probe) => !completedIds.has(probe.id));
  if (!signal?.aborted && missing.length > 0) {
    yield {
      type: "log",
      data: { message: `Run ended without testing: ${missing.map((probe) => probe.name).join(", ")}` },
    };
  }

  yield {
    type: "summary",
    data: {
      totalTests: THINKER_PROBES.length,
      passed: results.filter((result) => result.status === "pass").length,
      failed:
        results.filter((result) => result.status === "fail").length + missing.length,
      skipped: 0,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      environment: process.env.NODE_ENV || "development",
      results,
    },
  };
}
