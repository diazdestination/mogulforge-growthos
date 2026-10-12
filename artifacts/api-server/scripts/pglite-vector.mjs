// Disposable PGlite with the pgvector extension loaded and enabled, so local
// isolated runs can apply the current schema (retrieval_chunks.embedding is a
// vector(1536) column). Data directories restored with `loadDataDir` must be
// opened through this helper too, because the extension lives in the WASM
// runtime, not in the dump.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

export async function createVectorPGlite(options = {}) {
  const database = await PGlite.create({
    ...options,
    extensions: { ...(options.extensions ?? {}), vector },
  });
  await database.exec("CREATE EXTENSION IF NOT EXISTS vector");
  return database;
}
