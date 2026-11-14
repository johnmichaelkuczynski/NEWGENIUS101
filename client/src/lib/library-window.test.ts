import assert from "node:assert/strict";
import { test } from "node:test";
import { libraryWindowPosition } from "./library-window";

test("dragging keeps the full-size window and resize handle above the viewport edge", () => {
  const point = libraryWindowPosition(63, 224, 930, 790, 1500, 1000);
  assert.deepEqual(point, { x: 63, y: 198 });
  assert.ok(point.y + 790 <= 1000 - 12);
});
test("clamps large drags using the resized window's real dimensions", () => {
  assert.deepEqual(libraryWindowPosition(-100, -100, 830, 730, 1500, 1000), { x: 12, y: 12 });
  assert.deepEqual(libraryWindowPosition(9000, 9000, 830, 730, 1500, 1000), { x: 658, y: 258 });
});
