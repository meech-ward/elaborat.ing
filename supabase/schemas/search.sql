-- Hybrid search over the passages of notes and diagrams: keyword and meaning,
-- fused with Reciprocal Rank Fusion. See "Search" in docs/architecture.md.
--
-- Supabase's guides: Hybrid search
-- (https://supabase.com/docs/guides/ai/hybrid-search) and Automatic embeddings
-- (https://supabase.com/docs/guides/ai/automatic-embeddings).

create extension if not exists vector with schema extensions;
create extension if not exists pgmq;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- A passage of a note or diagram: one heading section, or one block of D2,
-- short enough for the embedding model (supabase/functions/_shared/passages.ts).
-- The `embed` Edge Function writes a file's passages whole, embeddings
-- included; people only read them.
create table public.file_passages (
  id bigint generated always as identity primary key,
  file_id uuid not null references public.project_files (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  ordinal integer not null,
  -- The headings above the passage, outermost first, joined with " > ".
  headings text not null,
  content text not null,
  -- UTF-16 offsets of the passage in the file's content when it was embedded.
  start_offset integer not null,
  end_offset integer not null,
  fts tsvector generated always as (to_tsvector('english', headings || ' ' || content)) stored,
  -- gte-small: 384 dimensions, normalized, so inner product ranks like cosine.
  embedding extensions.vector(384) not null,
  constraint file_passages_file_ordinal_key unique (file_id, ordinal),
  constraint file_passages_span check (start_offset >= 0 and end_offset >= start_offset)
);

create index file_passages_project_id_idx on public.file_passages (project_id);
create index file_passages_fts_idx on public.file_passages using gin (fts);
create index file_passages_embedding_idx on public.file_passages using hnsw (embedding extensions.vector_ip_ops);

alter table public.file_passages enable row level security;

revoke all on table public.file_passages from anon, authenticated;
grant select on table public.file_passages to authenticated;

create policy "People can read passages in their projects"
  on public.file_passages
  for select
  to authenticated
  using (project_id in (select private.readable_project_ids()));

-- Notes and diagrams whose passages are out of date. A rename can make a file
-- searchable or not, so paths count as well as content. The `embed` function
-- decides what the file needs from its current row.
create function private.queue_file_passages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.is_searchable_path(new.path)
    or (tg_op = 'UPDATE' and private.is_searchable_path(old.path)) then
    perform pgmq.send('file_passages', jsonb_build_object('fileId', new.id));
  end if;
  return null;
end;
$$;

revoke all on function private.queue_file_passages() from public, anon, authenticated;

create trigger queue_file_passages
  after insert or update of content, path on public.project_files
  for each row
  execute function private.queue_file_passages();

-- Notes (.md, .mdx) and D2 diagrams have passages; Obsidian drawings
-- (.excalidraw.md) do not.
create function private.is_searchable_path(path text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select path ~* '\.(md|mdx|d2)$' and path !~* '\.excalidraw\.md$'
$$;

revoke all on function private.is_searchable_path(text) from public, anon, authenticated;

-- The queue of files whose passages are out of date. pg-delta declares pgmq
-- queues and pg_cron jobs as extension intent, so these calls belong here.
select pgmq.create('file_passages');

-- Sends queued files to the `embed` Edge Function in batches. pg_cron runs it
-- every 10 seconds. A job stays hidden while its batch is processed and comes
-- back if the function fails, so failed jobs retry. Until the project URL and
-- a secret key for the function are in Vault (see docs/architecture.md), jobs
-- wait in the queue.
create function private.process_file_passages(
  batch_size integer default 10,
  max_requests integer default 10,
  timeout_milliseconds integer default 300000
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.process_file_passages(integer, integer, integer) from public, anon, authenticated;

select cron.schedule(
  'process-file-passages',
  '10 seconds',
  $$select private.process_file_passages()$$
);

-- Supabase's documented hybrid search over passages, returning up to 30. It
-- runs as the caller, so RLS keeps results to projects they can read.
-- Iterative index scans keep the vector half from coming back short when RLS
-- filters out most of the nearest passages (other people's).
create function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(384),
  match_count integer,
  full_text_weight double precision default 1,
  semantic_weight double precision default 1,
  rrf_k integer default 50
)
returns table (
  passage_id bigint,
  project_id uuid,
  file_id uuid,
  path text,
  headings text,
  content text,
  start_offset integer,
  end_offset integer,
  score double precision
)
language sql
stable
security invoker
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
as $$
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
$$;

revoke all on function public.hybrid_search(text, extensions.vector, integer, double precision, double precision, integer) from public, anon;
grant execute on function public.hybrid_search(text, extensions.vector, integer, double precision, double precision, integer) to authenticated;
