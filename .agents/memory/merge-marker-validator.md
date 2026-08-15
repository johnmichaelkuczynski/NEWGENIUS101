---
name: Merge-resolution marker validator
description: continueMergeResolution flags any run of 7+ "=" characters as a conflict marker
---
The rebase-conflict validator behind `continueMergeResolution` rejects files containing ANY run of 7+ `=` characters (also `<`/`>`), even in comment banners or template-string separators that predate the merge.

**Why:** During one rebase, `server/routes.ts` kept failing "conflict markers remain" although no real markers existed — its decorative `// ========` banners and prompt separators triggered it.

**How to apply:** If continueMergeResolution keeps reporting markers you can't find, grep `-P "={7}|<{7}|>{7}"` and shorten decorative runs to 6 chars (`sed -E 's/={7,}/======/g'`), then retry.
