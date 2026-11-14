CREATE TABLE IF NOT EXISTS library_books (
  id text PRIMARY KEY,
  title text NOT NULL,
  author text NOT NULL,
  filename text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  word_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  indexed_chunks integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'indexing' CHECK (status IN ('indexing','ready','failed')),
  error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_chunks (
  id text PRIMARY KEY,
  book_id text NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  embedding vector(1536) NOT NULL,
  UNIQUE(book_id,chunk_index)
);
CREATE INDEX IF NOT EXISTS library_chunks_book_index ON library_chunks(book_id,chunk_index);
CREATE INDEX IF NOT EXISTS library_chunks_text_search ON library_chunks USING gin(to_tsvector('english',text));
