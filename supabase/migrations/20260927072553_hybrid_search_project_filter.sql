SET local check_function_bodies = off;

DROP FUNCTION "public"."hybrid_search"(text, extensions.vector, integer, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.hybrid_search (
  query_text        text,
  query_embedding   extensions.vector,
  match_count       integer,
  full_text_weight  double precision  DEFAULT 1,
  semantic_weight   double precision  DEFAULT 1,
  rrf_k             integer           DEFAULT 50,
  filter_project_id uuid              DEFAULT NULL::uuid
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
      and (filter_project_id is null or p.project_id = filter_project_id)
    order by rank_ix
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select
      p.id,
      row_number() over (order by p.embedding operator(extensions.<#>) query_embedding) as rank_ix
    from public.file_passages p
    where filter_project_id is null or p.project_id = filter_project_id
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

REVOKE ALL ON FUNCTION "public"."hybrid_search"(text, extensions.vector, integer, double precision, double precision, integer, uuid) FROM PUBLIC, "anon", "service_role";

GRANT EXECUTE ON FUNCTION "public"."hybrid_search"(text, extensions.vector, integer, double precision, double precision, integer, uuid) TO "authenticated", "postgres";
