SET local check_function_bodies = off;

-- Written by hand: reading a vector loads pgvector in this session, which
-- defines hnsw.iterative_scan, set by hybrid_search below. Until then it is an
-- unknown parameter, and only a superuser may set one in a function, which the
-- role running `supabase db push` is not.
SELECT '[0]'::extensions.vector;

CREATE TABLE "private"."limit_counters" (
  "user_id"      uuid                     NOT NULL,
  "name"         text                     NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "uses"         integer                  NOT NULL,
  CONSTRAINT "limit_counters_pkey" PRIMARY KEY (user_id, name)
);

ALTER TABLE "private"."limit_counters"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION private.check_limit (
  name text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  found_limit record;
begin
  select * into found_limit
  from private.limits() l
  where l.name = check_limit.name and l.window_length is not null;
  if not found then
    raise exception 'Unknown limit: %', check_limit.name using errcode = '22023';
  end if;
  perform private.count_use(uid, found_limit.name, found_limit.max_count, found_limit.window_length, found_limit.what);
end;
$function$;

CREATE OR REPLACE FUNCTION private.count_use (
  user_id       uuid,
  name          text,
  max_count     integer,
  window_length interval,
  what          text
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  this_window timestamptz := date_bin(count_use.window_length, now(), timestamptz '2000-01-01 00:00:00+00');
  counted private.limit_counters;
begin
  insert into private.limit_counters as c (user_id, name, window_start, uses)
  values (count_use.user_id, count_use.name, this_window, 1)
  on conflict on constraint limit_counters_pkey do update
    set uses = case when c.window_start >= excluded.window_start then c.uses + 1 else 1 end,
        window_start = greatest(c.window_start, excluded.window_start)
  returning * into counted;
  if counted.uses > count_use.max_count then
    raise exception 'You have reached the limit of % %. Try again in %.',
      count_use.max_count, count_use.what,
      private.limit_wait(counted.window_start + count_use.window_length - now())
      using errcode = 'PT429', detail = count_use.name;
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.create_project (
  project_id uuid,
  title      text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  created boolean;
  most integer;
begin
  if create_project.project_id is null then
    raise exception 'Project id required' using errcode = '22023';
  end if;

  insert into public.projects (id, owner_id, title)
  values (create_project.project_id, uid, create_project.title)
  on conflict (id) do nothing;
  created := found;

  select * into p from public.projects where id = create_project.project_id;
  if p.owner_id is distinct from uid then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;

  if created then
    -- Counting first locks the owner's counter row, so two creates at once
    -- are counted one after the other and the total below sees both.
    perform private.check_limit('projects_per_day');
    select l.max_count into most from private.limits() l where l.name = 'projects';
    if (select count(*) from public.projects o where o.owner_id = uid) > most then
      raise exception 'You have reached the limit of % projects. Permanently delete one to make room.', most
        using errcode = 'PT429', detail = 'projects';
    end if;
  end if;

  return private.project_summary(p, 'owner');
end;
$function$;

CREATE OR REPLACE FUNCTION private.limit_wait (
  wait interval
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select n || ' ' || unit || case when n = 1 then '' else 's' end
  from (
    select
      case
        when seconds < 60 then greatest(ceil(seconds), 1)
        when seconds < 3600 then ceil(seconds / 60)
        else ceil(seconds / 3600)
      end::integer as n,
      case when seconds < 60 then 'second' when seconds < 3600 then 'minute' else 'hour' end as unit
    from (select extract(epoch from wait) as seconds) s
  ) w
$function$;

CREATE OR REPLACE FUNCTION private.limits()
  RETURNS TABLE (
    name          text,
    max_count     integer,
    window_length interval,
    what          text
  )
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  values
    ('projects_per_day', 100, interval '1 day', 'new projects a day'),
    ('projects', 1000, null, 'projects'),
    ('saves_per_minute', 300, interval '1 minute', 'saves a minute'),
    ('searches_per_minute', 120, interval '1 minute', 'searches a minute'),
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute')
$function$;

CREATE OR REPLACE FUNCTION private.save_files (
  project_id  uuid,
  mutation_id uuid,
  changes     jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  existing_receipt private.save_receipts;
  change_hash bytea;
  change jsonb;
  op text;
  change_path text;
  target_path text;
  base_version bigint;
  current_file public.project_files;
  saved_file public.project_files;
  old_bytes bigint;
  byte_delta bigint := 0;
  touched text[] := '{}';
  added_file_paths text[] := '{}';
  added_paths text[] := '{}';
  collision text;
  conflict_list jsonb[] := '{}';
  applied jsonb[] := '{}';
  new_revision bigint;
  result jsonb;
begin
  perform private.check_limit('saves_per_minute');
  if save_files.project_id is null or save_files.mutation_id is null then
    raise exception 'Project id and mutation id are required' using errcode = '22023';
  end if;
  if jsonb_typeof(save_files.changes) is distinct from 'array'
    or jsonb_array_length(save_files.changes) not between 1 and 4096 then
    raise exception 'Changes must be a list of 1 to 4096 items' using errcode = '22023';
  end if;

  -- Archived projects still answer retries of saves that already happened.
  p := private.lock_project_for_edit(save_files.project_id, true);

  change_hash := sha256(convert_to(save_files.changes::text, 'UTF8'));
  select * into existing_receipt
  from private.save_receipts r
  where r.project_id = p.id and r.mutation_id = save_files.mutation_id;
  if existing_receipt.mutation_id is not null then
    if existing_receipt.user_id <> uid or existing_receipt.payload_hash <> change_hash then
      raise exception 'This mutation id was already used for a different save' using errcode = '22023';
    end if;
    return existing_receipt.result;
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;

  new_revision := p.revision + 1;

  -- Validate every change and check versions before writing anything.
  for change in select value from jsonb_array_elements(save_files.changes) loop
    if jsonb_typeof(change) is distinct from 'object' then
      raise exception 'Each change must be an object' using errcode = '22023';
    end if;
    op := change ->> 'op';
    change_path := change ->> 'path';
    base_version := null;
    if op is null or op not in ('put', 'delete', 'move', 'mkdir', 'rmdir') then
      raise exception 'Unknown change op: %', left(coalesce(op, '(missing)'), 50) using errcode = '22023';
    end if;
    if not private.is_valid_path(change_path) then
      raise exception 'Invalid path: %', left(coalesce(change_path, '(missing)'), 200) using errcode = '22023';
    end if;
    if change_path = any (touched) then
      raise exception 'A save can change each path only once: %', change_path using errcode = '22023';
    end if;
    touched := touched || change_path;

    if op in ('put', 'delete', 'move') and coalesce(jsonb_typeof(change -> 'base_version'), 'null') <> 'null' then
      if jsonb_typeof(change -> 'base_version') <> 'number'
        or (change ->> 'base_version') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'base_version must be a positive whole number' using errcode = '22023';
      end if;
      base_version := (change ->> 'base_version')::bigint;
    end if;
    if op in ('delete', 'move') and base_version is null then
      raise exception '% needs base_version: %', op, change_path using errcode = '22023';
    end if;
    if op = 'put' and jsonb_typeof(change -> 'content') is distinct from 'string' then
      raise exception 'put needs string content: %', change_path using errcode = '22023';
    end if;
    if op = 'move' and change ? 'content' and jsonb_typeof(change -> 'content') <> 'string' then
      raise exception 'move content must be a string: %', change_path using errcode = '22023';
    end if;

    if op in ('put', 'delete', 'move') then
      select * into current_file
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      if (base_version is null and current_file.id is not null)
        or (base_version is not null and current_file.version is distinct from base_version) then
        conflict_list := conflict_list || jsonb_build_object(
          'path', change_path,
          'base_version', base_version,
          'current', case when current_file.id is null then null else jsonb_build_object(
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content) end
        );
      end if;
    end if;

    if op = 'move' then
      target_path := change ->> 'to';
      if not private.is_valid_path(target_path) then
        raise exception 'Invalid path: %', left(coalesce(target_path, '(missing)'), 200) using errcode = '22023';
      end if;
      if target_path = any (touched) then
        raise exception 'A save can change each path only once: %', target_path using errcode = '22023';
      end if;
      touched := touched || target_path;
      select * into current_file
      from public.project_files f
      where f.project_id = p.id and f.path = target_path;
      if current_file.id is not null then
        conflict_list := conflict_list || jsonb_build_object(
          'path', target_path,
          'base_version', null,
          'current', jsonb_build_object(
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content)
        );
      end if;
    end if;
  end loop;

  if cardinality(conflict_list) > 0 then
    return jsonb_build_object(
      'status', 'conflict',
      'project', jsonb_build_object('id', p.id, 'revision', p.revision),
      'conflicts', to_jsonb(conflict_list)
    );
  end if;

  -- Apply. Every changed file takes the new revision as its version.
  for change in select value from jsonb_array_elements(save_files.changes) loop
    op := change ->> 'op';
    change_path := change ->> 'path';

    if op = 'put' then
      select octet_length(f.content) into old_bytes
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      insert into public.project_files as f (project_id, path, content, version, updated_by)
      values (p.id, change_path, change ->> 'content', new_revision, uid)
      on conflict on constraint project_files_project_path_key do update
        set content = excluded.content,
            version = excluded.version,
            updated_by = excluded.updated_by,
            updated_at = now()
      returning * into saved_file;
      byte_delta := byte_delta + octet_length(saved_file.content) - coalesce(old_bytes, 0);
      if old_bytes is null then
        added_file_paths := added_file_paths || change_path;
        added_paths := added_paths || change_path;
      end if;
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'delete' then
      delete from public.project_files f
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta - octet_length(saved_file.content);
      insert into public.file_versions (file_id, version, project_id, path, content, deleted, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, null, true, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'move' then
      target_path := change ->> 'to';
      select octet_length(f.content) into old_bytes
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      -- A move may also carry new content, so moving a file and rewriting
      -- its own content (for example a self-reference) is one change.
      update public.project_files f
      set path = target_path,
          content = coalesce(change ->> 'content', f.content),
          version = new_revision,
          updated_by = uid,
          updated_at = now()
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta + octet_length(saved_file.content) - old_bytes;
      added_file_paths := added_file_paths || target_path;
      added_paths := added_paths || target_path;
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'to', target_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'mkdir' then
      insert into public.project_folders (project_id, path)
      values (p.id, change_path)
      on conflict on constraint project_folders_pkey do nothing;
      added_paths := added_paths || change_path;
      applied := applied || jsonb_build_object('op', op, 'path', change_path);

    elsif op = 'rmdir' then
      -- Removes only the folder entry; files keep their paths.
      delete from public.project_folders d
      where d.project_id = p.id and d.path = change_path;
      applied := applied || jsonb_build_object('op', op, 'path', change_path);
    end if;
  end loop;

  -- A path is either a file or a folder, and a file cannot contain anything.
  select a.path into collision
  from unnest(added_paths) as a(path)
  where exists (
      -- a file sits where one of this path's folders should be
      select 1 from public.project_files f
      where f.project_id = p.id and f.path = any (private.path_ancestors(a.path))
    )
    or (
      -- a file and a folder share this path
      exists (select 1 from public.project_files f where f.project_id = p.id and f.path = a.path)
      and exists (select 1 from public.project_folders d where d.project_id = p.id and d.path = a.path)
    )
  limit 1;
  if collision is null then
    -- a new file already has files or folders below it
    select a.path into collision
    from unnest(added_file_paths) as a(path)
    where exists (
        select 1 from public.project_files f
        where f.project_id = p.id
          and f.path >= (a.path || '/') collate "C"
          and f.path < (a.path || '0') collate "C"
      )
      or exists (
        select 1 from public.project_folders d
        where d.project_id = p.id
          and d.path >= (a.path || '/') collate "C"
          and d.path < (a.path || '0') collate "C"
      )
    limit 1;
  end if;
  if collision is not null then
    raise exception 'Path is already used by a file or folder: %', collision
      using errcode = '23505', detail = collision;
  end if;

  if (select count(*) from public.project_files f where f.project_id = p.id) > 4096
    or (select count(*) from public.project_folders d where d.project_id = p.id) > 4096 then
    raise exception 'A project can hold at most 4096 files and 4096 folders' using errcode = '54000';
  end if;
  if p.content_bytes + byte_delta > 67108864 then
    raise exception 'A project can hold at most 64 MiB of files' using errcode = '54000';
  end if;

  update public.projects
  set revision = new_revision,
      content_bytes = content_bytes + byte_delta,
      updated_at = now()
  where id = p.id;

  result := jsonb_build_object(
    'status', 'saved',
    'project', jsonb_build_object('id', p.id, 'revision', new_revision),
    'changes', to_jsonb(applied)
  );

  insert into private.save_receipts (project_id, mutation_id, user_id, payload_hash, result)
  values (p.id, save_files.mutation_id, uid, change_hash, result);

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.count_tool_call()
  RETURNS void
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.check_limit('tool_calls_per_minute')
$function$;

REVOKE ALL ON FUNCTION "public"."count_tool_call"() FROM PUBLIC, "anon", "service_role";

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
  SET search_path TO ''
  SET "hnsw.iterative_scan" TO 'relaxed_order'
  AS $function$
  select private.check_limit('searches_per_minute');

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

ALTER TABLE "private"."limit_counters"
  ADD CONSTRAINT "limit_counters_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

REVOKE ALL ON FUNCTION "private"."check_limit"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."check_limit"(text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."count_use"(uuid, text, integer, interval, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."count_use"(uuid, text, integer, interval, text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."limit_wait"(interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."limit_wait"(interval) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."limits"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."limits"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."count_tool_call"() TO "authenticated", "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."limit_counters" TO "postgres";
