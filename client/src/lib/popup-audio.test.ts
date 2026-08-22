import assert from "node:assert/strict";
import test from "node:test";
import { supportsMultiSpeakerAudio } from "./popup-audio";

test("never enables audio for Paper Writer popups", () => {
  assert.equal(
    supportsMultiSpeakerAudio({
      id: "paper-aristotle-1",
      title: "A dialogue about essence and an interview with nature",
      filename: "debate-paper.txt",
    }),
    false,
  );
});

test("still enables audio for actual multi-speaker outputs", () => {
  assert.equal(
    supportsMultiSpeakerAudio({
      id: "dialogue-aristotle-plato",
      title: "Aristotle and Plato",
      filename: "conversation.txt",
    }),
    true,
  );
});