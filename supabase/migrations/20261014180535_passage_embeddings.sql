CREATE TABLE "private"."passage_embeddings" (
  "file_id"    uuid                   NOT NULL,
  "input_hash" text                   NOT NULL,
  "embedding"  extensions.vector(384) NOT NULL,
  CONSTRAINT "passage_embeddings_pkey" PRIMARY KEY (file_id, input_hash)
);

ALTER TABLE "private"."passage_embeddings"
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE "private"."passage_embeddings"
  ADD CONSTRAINT "passage_embeddings_file_id_fkey" FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE;

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."passage_embeddings" TO "postgres";
