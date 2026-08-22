import assert from "node:assert/strict";
import test from "node:test";
import { prepareSourceQuotation } from "./paperQuotation";

test("preserves internal straight and curly quotation marks", () => {
  const source = `  He distinguishes “form” from "matter" without altering either term.  `;

  assert.equal(
    prepareSourceQuotation(source),
    `He distinguishes “form” from "matter" without altering either term.`,
  );
});