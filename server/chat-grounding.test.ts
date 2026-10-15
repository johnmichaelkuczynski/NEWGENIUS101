import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGroundedProviderMessages,
  createChatSentenceStream,
  CHAT_SOURCE_UNAVAILABLE,
  fallbackChatRetrievalQuery,
  hasChatPrimarySources,
  resolveChatRetrievalQuery,
} from "./chat-grounding";

const history = [
  { role: "user", content: "EXPLAIN WHY THE DEDUCTIVE NOMOLOGICAL MODEL IS A FAILURE. PAY SPECIAL ATTENTION TO PSYCHOLOGICAL EXPLANATION AND CAUSATION." },
  { role: "assistant", content: "The model mistakes explanation for deduction from universal laws. Psychological explanation also requires understanding what a person takes to be a reason." },
];
const followUp = "DO YOU PERSONALLY AGREE WITH THIS VIEW?";

test("the live two-turn failure supplies the original topic to query resolution", async () => {
  const result = await resolveChatRetrievalQuery(followUp, history, async (system, input) => {
    const data = JSON.parse(input);
    assert.equal(data.currentQuestion, followUp);
    assert.deepEqual(data.recentConversation, history);
    assert.match(system, /polarity/);
    return "Do you agree that the deductive-nomological model fails to explain psychological explanation and causation?";
  });
  assert.match(result, /deductive-nomological/);
  assert.match(result, /psychological explanation and causation/);
});

test("an unchanged unresolved follow-up cannot silently lose its subject", async () => {
  const query = await resolveChatRetrievalQuery(followUp, history, async () => followUp);
  assert.match(query, /DEDUCTIVE NOMOLOGICAL MODEL/);
  assert.match(query, /DO YOU PERSONALLY AGREE/);
});

test("query-provider failure retains the source topic and original logical force", async () => {
  const prior = [{ role: "user", content: "Can a true statement be necessarily non-contingent without being analytic?" }];
  const query = await resolveChatRetrievalQuery("Why?", prior, async () => { throw new Error("provider unavailable"); });
  assert.match(query, /necessarily non-contingent without being analytic/);
  assert.match(query, /CURRENT FOLLOW-UP QUESTION: Why\?/);
});

test("multiple follow-ups fall back to the last substantive topic", () => {
  const turns = [...history, { role: "user", content: followUp }, { role: "assistant", content: "Yes, for the reasons discussed." }];
  assert.match(fallbackChatRetrievalQuery("Explain that argument.", turns), /DEDUCTIVE NOMOLOGICAL/);
});

test("a self-contained new topic does not inherit stale conversation terms", async () => {
  const question = "What distinguishes unconscious fear from ordinary anxiety?";
  assert.equal(fallbackChatRetrievalQuery(question, history), question);
  const query = await resolveChatRetrievalQuery(question, history, async () => question);
  assert.equal(query, question);
  assert.doesNotMatch(query, /nomological/i);
});

test("structured claims or whitespace cannot stand in for primary passages", () => {
  assert.equal(hasChatPrimarySources([]), false);
  assert.equal(hasChatPrimarySources([{ content: "   " }]), false);
  assert.equal(hasChatPrimarySources([{ chunkText: "Exact primary-source passage." }]), true);
  assert.match(CHAT_SOURCE_UNAVAILABLE, /won't substitute an ungrounded answer/);
});

test("every provider receives fresh source context on both first and later turns", () => {
  for (const turns of [
    [{ role: "user", content: "First question" }],
    [...history, { role: "user", content: followUp }],
    [{ role: "assistant", content: "A retained earlier reply." }, { role: "user", content: followUp }],
  ]) {
    const system = "CURRENT DATABASE PASSAGES\nThe author's actual source-grounded position.";
    const payload = buildGroundedProviderMessages(system, turns);
    assert.equal(payload.anthropic.system, system);
    assert.deepEqual(payload.anthropic.messages, turns);
    assert.equal(payload.openAI[0].content, system);
    assert.deepEqual(payload.openAI.slice(1), turns);
  }
});

test("sentence streaming preserves exact completed text, including the last sentence", () => {
  let text = "";
  const stream = createChatSentenceStream(part => { text += part; });
  for (const chunk of ["Explanation is ", "not mere deduction. ", "It requires ", "continuity."]) stream.push(chunk);
  stream.finish("stop");
  assert.equal(text, "Explanation is not mere deduction. It requires continuity.");
});

test("a prematurely ended stream cannot leak its unfinished word or claim success", () => {
  let text = "";
  const stream = createChatSentenceStream(part => { text += part; });
  stream.push("Psychological truths are sui generis. Disciplines are individu");
  assert.throws(() => stream.finish(null), /before completion/);
  assert.equal(text, "Psychological truths are sui generis. ");
});

test("an output-token limit is not accepted as a complete answer", () => {
  const stream = createChatSentenceStream(() => {});
  stream.push("A complete sentence may still precede missing arguments.");
  assert.throws(() => stream.finish("length"), /before completion/);
});

test("an empty answer cannot be marked complete", () => {
  const stream = createChatSentenceStream(() => {});
  assert.throws(() => stream.finish("stop"), /before completion/);
});
