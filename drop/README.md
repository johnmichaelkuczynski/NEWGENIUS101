# Drop Folder — Author Ingestion

For primary works, drag ordinary `.txt` files into the appropriate author folder under:

```
ALL_AUTHOR_WORKS/
```

The author subfolder identifies the thinker; no special filename is required.

Then run:

```
npx tsx scripts/ingest-drop-folder.ts
```

Add `--dry-run` to parse and preview counts without writing to the database.

The ingester writes to `EXTERNAL_DATABASE_URL` when available, matching the database used by the running app.

## Naming convention

```
AUTHOR_CATEGORY.txt          e.g.  LOCKE_WORKS.txt
AUTHOR_CATEGORY_N.txt        e.g.  LOCKE_WORKS_2.txt   (N = lot / volume number)
```

- **AUTHOR** — the thinker id (lowercase last name, hyphens ok: `james-allen`, `von-mises`).
- **CATEGORY** — one of: `WORKS`, `QUOTES`, `POSITIONS`, `ARGUMENTS`.
- **N** — optional lot number when you have multiple files of the same kind.

The filename decides the destination table:

| CATEGORY    | Goes to                              | Expected file content |
|-------------|--------------------------------------|-----------------------|
| `WORKS`     | `texts` → chunked + embedded → `chunks` | raw prose (the actual work) |
| `QUOTES`    | `quotes`                             | one per line, `author \| quote \| topic` (pipes optional) |
| `POSITIONS` | `positions`                          | `author \| position \| topic` per line, **or** markdown with `### Topic` headers + numbered items |
| `ARGUMENTS` | `arguments`                          | markdown blocks: `### Argument N (type)` / `**Premises:**` bullets / `**Conclusion:**` / `*Source: Topic \| Importance: N/10*` |

## After running

- Successfully ingested files move to `drop/_processed/`.
- Files that fail (bad name or parse error) move to `drop/_failed/`.

Examples: `LOCKE_WORKS`, `LOCKE_WORKS_2`, `LOCKE_QUOTES_3`, `LOCKE_POSITIONS`, `LOCKE_ARGUMENTS`.
