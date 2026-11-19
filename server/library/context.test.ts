import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getLibraryContext, libraryRequestScope, resolvedLibraryContext,
  withLibraryContext, withoutLibraryContext,
} from "./context";

test("internal generation suppresses automatic library injection across awaited calls", async () => {
  // Invalid selection proves the request scope is active without a database
  // request, embedding call, or any real user data.
  const req: any = {
    method: "POST", path: "/api/chat/stream",
    body: { message: "HOW TO ANALYZE COUNTERFACTUALS", bookIds: [false] },
  };
  await new Promise<void>((resolve, reject) => {
    libraryRequestScope(req, {} as any, () => {
      (async () => {
        const system = "Select only the supplied Kuczynski primary evidence.";
        await withoutLibraryContext(async () => {
          await Promise.resolve();
          assert.equal(await getLibraryContext(), "");
          assert.equal(resolvedLibraryContext(), "");
          assert.equal(await withLibraryContext(system), system);
        });
        // Suppression must not persist into final answers or other requests.
        await assert.rejects(getLibraryContext(), /Select at most eight valid/);
      })().then(resolve, reject);
    });
  });
});
