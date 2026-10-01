SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.count_agent_changes (
  project_id uuid
)
  RETURNS integer
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects := private.agent_changes_project(count_agent_changes.project_id);
  seen bigint := private.agent_changes_seen_version(p.id);
begin
  return (
    select count(*)::integer from (
      select 1 from public.file_versions v
      where v.project_id = p.id
        and v.agent_client_id is not null
        and v.version > seen
        and not private.is_d2_generated(p.id, v.path, v.version)
      limit 100
    ) n
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.get_agent_change (
  project_id    uuid,
  file_id       uuid,
  version       bigint,
  previous_only boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects := private.agent_changes_project(get_agent_change.project_id);
  v public.file_versions;
  pv public.file_versions;
begin
  select * into v from public.file_versions x
  where x.file_id = get_agent_change.file_id
    and x.version = get_agent_change.version
    and x.project_id = p.id
    and x.agent_client_id is not null;
  if v.file_id is null then
    raise exception 'No such agent change' using errcode = '22023';
  end if;
  select * into pv from public.file_versions x
  where x.file_id = v.file_id and x.version < v.version
  order by x.version desc
  limit 1;
  if not coalesce(get_agent_change.previous_only, false)
    and coalesce(octet_length(v.content), 0) + coalesce(octet_length(pv.content), 0) > 1048576 then
    raise exception 'Too large to show here' using errcode = '54000';
  end if;
  return jsonb_build_object(
    'file_id', v.file_id,
    'version', v.version,
    'content', case when coalesce(get_agent_change.previous_only, false) then null else v.content end,
    'previous', case when pv.file_id is not null then jsonb_build_object('version', pv.version, 'content', pv.content) end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.is_d2_generated (
  project_id uuid,
  path       text,
  version    bigint
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select exists (
    select 1
    from (
      select case
        when right(is_d2_generated.path, 8) = '.d2.json' then left(is_d2_generated.path, -5)
        when right(is_d2_generated.path, 11) = '.excalidraw' then left(is_d2_generated.path, -11) || '.d2'
      end as source
    ) d
    where d.source is not null
      and (
        exists (
          select 1 from public.project_files f
          where f.project_id = is_d2_generated.project_id and f.path = d.source
        )
        or exists (
          select 1 from public.file_versions s
          where s.project_id = is_d2_generated.project_id
            and s.version = is_d2_generated.version
            and s.agent_client_id is not null
            and s.path = d.source
        )
      )
  )
$function$;

CREATE OR REPLACE FUNCTION private.list_agent_changes (
  project_id uuid,
  before     bigint  DEFAULT NULL::bigint,
  max_count  integer DEFAULT 20
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects := private.agent_changes_project(list_agent_changes.project_id);
  page_size integer := least(greatest(coalesce(list_agent_changes.max_count, 20), 1), 50);
  max_rows constant integer := 100;
  revisions bigint[];
  more boolean;
begin
  -- The newest saves below `before`, one more than a page, each with how
  -- many changes it and the newer ones hold; the page is those up to
  -- `page_size` saves and `max_rows` changes, and always the first.
  select
    coalesce(array_agg(s.version order by s.version desc) filter (where s.n <= page_size and (s.n = 1 or s.total <= max_rows)), '{}'),
    count(*) filter (where s.n > page_size or (s.n > 1 and s.total > max_rows)) > 0
  into revisions, more
  from (
    select c.version, row_number() over (order by c.version desc) as n, sum(c.changes) over (order by c.version desc) as total
    from (
      select v.version, count(*) as changes
      from public.file_versions v
      where v.project_id = p.id
        and v.agent_client_id is not null
        and (list_agent_changes.before is null or v.version < list_agent_changes.before)
        and not private.is_d2_generated(p.id, v.path, v.version)
      group by v.version
      order by v.version desc
      limit page_size + 1
    ) c
  ) s;
  return jsonb_build_object(
    'project_id', p.id,
    'revision', p.revision,
    'seen', private.agent_changes_seen_version(p.id),
    'more', more,
    'changes', coalesce(
      (select jsonb_agg(
         jsonb_build_object(
           'file_id', v.file_id,
           'version', v.version,
           'path', v.path,
           'deleted', v.deleted,
           'size', octet_length(v.content),
           'created_at', v.created_at,
           'author', private.comment_person(v.author_id),
           'agent', private.agent_name(v.agent_client_id),
           'latest', not exists (
             select 1 from public.file_versions n where n.file_id = v.file_id and n.version > v.version
           ),
           'previous', (
             select jsonb_build_object(
               'version', pv.version,
               'path', pv.path,
               'deleted', pv.deleted,
               'size', octet_length(pv.content),
               'same_content', pv.content is not distinct from v.content
             )
             from public.file_versions pv
             where pv.file_id = v.file_id and pv.version < v.version
             order by pv.version desc
             limit 1
           ),
           'thread', (
             select jsonb_build_object(
               'id', t.id,
               'comment_id', c.id,
               'opening', (
                 select left(o.body, 200) from public.comments o
                 where o.thread_id = t.id
                 order by o.created_at, o.id
                 limit 1
               )
             )
             from public.comments c
             join public.comment_threads t on t.id = c.thread_id
             where c.project_id = p.id
               and t.file_id = v.file_id
               and c.file_version = v.version
               and c.deleted_at is null
             order by c.created_at, c.id
             limit 1
           )
         )
         order by v.version desc, v.path
       )
       from public.file_versions v
       where v.project_id = p.id
         and v.agent_client_id is not null
         and v.version = any (revisions)
         and not private.is_d2_generated(p.id, v.path, v.version)),
      '[]'::jsonb
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_agent_change (
  project_id    uuid,
  file_id       uuid,
  version       bigint,
  previous_only boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.get_agent_change(project_id, file_id, version, previous_only)
$function$;

REVOKE ALL ON FUNCTION "public"."get_agent_change"(uuid, uuid, bigint, boolean) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."get_agent_change"(uuid, uuid, bigint, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."get_agent_change"(uuid, uuid, bigint, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."is_d2_generated"(uuid, text, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_d2_generated"(uuid, text, bigint) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."get_agent_change"(uuid, uuid, bigint, boolean) TO "authenticated", "postgres";
