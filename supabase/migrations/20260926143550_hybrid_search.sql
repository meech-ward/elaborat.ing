SET local check_function_bodies = off;

CREATE EXTENSION "pg_cron";

CREATE EXTENSION "pg_net" SCHEMA "extensions";

CREATE EXTENSION "pgmq";

CREATE EXTENSION "vector" SCHEMA "extensions";

CREATE TABLE "public"."file_passages" (
  "id"           bigint                 GENERATED ALWAYS AS IDENTITY NOT NULL,
  "file_id"      uuid                   NOT NULL,
  "project_id"   uuid                   NOT NULL,
  "ordinal"      integer                NOT NULL,
  "headings"     text                   NOT NULL,
  "content"      text                   NOT NULL,
  "start_offset" integer                NOT NULL,
  "end_offset"   integer                NOT NULL,
  "embedding"    extensions.vector(384) NOT NULL,
  CONSTRAINT "file_passages_file_ordinal_key" UNIQUE (file_id, ordinal),
  CONSTRAINT "file_passages_pkey" PRIMARY KEY (id),
  CONSTRAINT "file_passages_span" CHECK (((start_offset >= 0) AND (end_offset >= start_offset)))
);

ALTER TABLE "public"."file_passages"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."file_passages" FROM "anon";

ALTER TABLE "public"."file_passages"
  ADD COLUMN "fts" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ((headings || ' '::text) || content))) STORED;

CREATE OR REPLACE FUNCTION private.is_searchable_path (
  path text
)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select path ~* '\.(md|mdx|d2)$' and path !~* '\.excalidraw\.md$'
$function$;

CREATE OR REPLACE FUNCTION private.process_file_passages (
  batch_size           integer DEFAULT 10,
  max_requests         integer DEFAULT 10,
  timeout_milliseconds integer DEFAULT 300000
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_secret_key');
  batch jsonb;
begin
  if project_url is null or secret_key is null then
    return;
  end if;
  for batch in
    select jsonb_agg(job.message || jsonb_build_object('jobId', job.msg_id))
    from (
      select message, msg_id, (row_number() over (order by msg_id) - 1) / batch_size as batch_number
      from pgmq.read('file_passages', timeout_milliseconds / 1000, max_requests * batch_size)
    ) as job
    group by job.batch_number
  loop
    perform net.http_post(
      url => project_url || '/functions/v1/embed',
      headers => jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
      body => batch,
      timeout_milliseconds => timeout_milliseconds
    );
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_file_passages()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if private.is_searchable_path(new.path)
    or (tg_op = 'UPDATE' and private.is_searchable_path(old.path)) then
    perform pgmq.send('file_passages', jsonb_build_object('fileId', new.id));
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hybrid_search (
  query_text       text,
  query_embedding  extensions.vector,
  match_count      integer,
  full_text_weight double precision  DEFAULT 1,
  semantic_weight  double precision  DEFAULT 1,
  rrf_k            integer           DEFAULT 50
)
  RETURNS TABLE (
    passage_id   bigint,
    project_id   uuid,
    file_id      uuid,
    path         text,
    headings     text,
    content      text,
    start_offset integer,
    end_offset   integer,
    score        double precision
  )
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  SET "hnsw.iterative_scan" TO 'relaxed_order'
  AS $function$
  with full_text as (
    select
      p.id,
      row_number() over (order by ts_rank_cd(p.fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
    from public.file_passages p
    where p.fts @@ websearch_to_tsquery('english', query_text)
    order by rank_ix
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select
      p.id,
      row_number() over (order by p.embedding operator(extensions.<#>) query_embedding) as rank_ix
    from public.file_passages p
    order by rank_ix
    limit least(match_count, 30) * 2
  )
  select
    p.id,
    p.project_id,
    p.file_id,
    f.path,
    p.headings,
    p.content,
    p.start_offset,
    p.end_offset,
    coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) * full_text_weight
      + coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join public.file_passages p on p.id = coalesce(full_text.id, semantic.id)
  join public.project_files f on f.id = p.file_id
  order by score desc
  limit least(match_count, 30)
$function$;

REVOKE ALL ON FUNCTION "public"."hybrid_search"(text, extensions.vector, integer, double precision, double precision, integer) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."file_passages"
  ADD CONSTRAINT "file_passages_file_id_fkey" FOREIGN KEY (file_id) REFERENCES public.project_files(id) ON DELETE CASCADE;

ALTER TABLE "public"."file_passages"
  ADD CONSTRAINT "file_passages_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX file_passages_embedding_idx ON public.file_passages USING hnsw (embedding extensions.vector_ip_ops);

CREATE INDEX file_passages_fts_idx ON public.file_passages USING gin (fts);

CREATE INDEX file_passages_project_id_idx ON public.file_passages USING btree (project_id);

CREATE TRIGGER queue_file_passages
  AFTER INSERT OR UPDATE OF content, path ON public.project_files
  FOR EACH ROW
  EXECUTE FUNCTION private.queue_file_passages();

CREATE POLICY "People can read passages in their projects" ON "public"."file_passages"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

COMMENT ON EXTENSION "pg_cron" IS 'Job scheduler for PostgreSQL';

COMMENT ON EXTENSION "pg_net" IS 'Async HTTP';

COMMENT ON EXTENSION "pgmq" IS 'A lightweight message queue. Like AWS SQS and RSMQ but on Postgres.';

COMMENT ON EXTENSION "vector" IS 'vector data type and ivfflat and hnsw access methods';

REVOKE ALL ON FUNCTION "private"."is_searchable_path"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_searchable_path"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."process_file_passages"(integer, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."process_file_passages"(integer, integer, integer) TO "postgres";

REVOKE ALL ON FUNCTION "private"."queue_file_passages"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_file_passages"() TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."hybrid_search"(text, extensions.vector, integer, double precision, double precision, integer) TO "authenticated", "postgres";

REVOKE ALL ON TABLE "public"."file_passages" FROM "authenticated";

GRANT SELECT ON TABLE "public"."file_passages" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."file_passages" TO "postgres";

REVOKE ALL ON TABLE "public"."file_passages" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."file_passages" TO "service_role";

SELECT cron.schedule_in_database('process-file-passages', '10 seconds', 'select private.process_file_passages()', 'postgres', NULL, true);

SELECT pgmq.create('file_passages');
