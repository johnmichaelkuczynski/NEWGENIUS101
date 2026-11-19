# Standing library drop folder

Drag books here in the project's Files panel, just as you use the author folders.
These books go into the shared library, NOT into any thinker's own writings.

## Recommended arrangement

Create a folder named after the book's actual author. Put descriptively named books inside:

    STANDING_LIBRARY/Ernst Mach/The Science of Mechanics.txt
    STANDING_LIBRARY/William James/Some Other Book.pdf

The author folder becomes the author name. The filename without its extension
becomes the book title. Spaces and ordinary punctuation are allowed.

Alternatively, put a book directly here with TWO underscores separating author and title:

    STANDING_LIBRARY/Ernst Mach__The Science of Mechanics.txt

TXT, Markdown, text-based PDF, and DOCX are supported, up to 30 MB per file.
Scanned PDFs require OCR first. Gutenberg wrappers are removed from the database
copy; your original files are never changed, renamed, moved, or deleted.

## Import

After the files finish uploading, open Shared Library in Preview and click
**Import drop folder**. Progress and any filename/extraction errors appear there.
Wait until each book says Ready before querying it.
Ready books appear in the Shared Library catalog.

The equivalent terminal command is:

    npm run import:library

To inspect files without writing to the database:

    npm run import:library -- --dry-run

Rerunning is safe: identical texts are not duplicated, and failed indexing can
resume. No new thinker profile is created. Files remain here after import.
Raw books in this folder are excluded from Git and publishing; the searchable
copies persist in the application's database.
