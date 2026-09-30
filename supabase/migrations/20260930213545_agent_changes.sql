SET local check_function_bodies = off;

CREATE TABLE "public"."agent_changes_seen" (
  "project_id"   uuid                     NOT NULL,
  "user_id"      uuid                     NOT NULL,
  "seen_version" bigint                   NOT NULL,
  "seen_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_changes_seen_pkey" PRIMARY KEY (project_id, user_id),
  CONSTRAINT "agent_changes_seen_version_nonnegative" CHECK ((seen_version >= 0))
);

ALTER TABLE "public"."agent_changes_seen"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."agent_changes_seen" FROM "anon";

CREATE OR REPLACE FUNCTION private.agent_changes_project (
  project_id uuid
)
  RETURNS public.projects
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects;
begin
  perform private.require_user();
  select * into p from public.projects where id = agent_changes_project.project_id;
  if p.id is null or private.project_role(p.id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return p;
end;
$function$;

CREATE OR REPLACE FUNCTION private.agent_changes_seen_version (
  project_id uuid
)
  RETURNS bigint
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select coalesce(
    (select s.seen_version from public.agent_changes_seen s
     where s.project_id = agent_changes_seen_version.project_id and s.user_id = (select auth.uid())),
    0
  )
$function$;

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
      where v.project_id = p.id and v.agent_client_id is not null and v.version > seen
      limit 100
    ) n
  );
end;
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
  revisions bigint[];
begin
  select coalesce(array_agg(r.version order by r.version desc), '{}') into revisions
  from (
    select distinct v.version
    from public.file_versions v
    where v.project_id = p.id
      and v.agent_client_id is not null
      and (list_agent_changes.before is null or v.version < list_agent_changes.before)
    order by v.version desc
    limit page_size + 1
  ) r;
  return jsonb_build_object(
    'project_id', p.id,
    'revision', p.revision,
    'seen', private.agent_changes_seen_version(p.id),
    'more', cardinality(revisions) > page_size,
    'changes', coalesce(
      (select jsonb_agg(
         jsonb_build_object(
           'file_id', v.file_id,
           'version', v.version,
           'path', v.path,
           'deleted', v.deleted,
           'content', v.content,
           'created_at', v.created_at,
           'author', private.comment_person(v.author_id),
           'agent', private.agent_name(v.agent_client_id),
           'latest', not exists (
             select 1 from public.file_versions n where n.file_id = v.file_id and n.version > v.version
           ),
           'previous', (
             select jsonb_build_object('version', pv.version, 'path', pv.path, 'deleted', pv.deleted, 'content', pv.content)
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
         and v.version = any (revisions[1:page_size])),
      '[]'::jsonb
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.mark_agent_changes_seen (
  project_id uuid,
  version    bigint
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  marked bigint;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can mark agent changes seen' using errcode = '42501';
  end if;
  if mark_agent_changes_seen.version is null or mark_agent_changes_seen.version < 0 then
    raise exception 'A version is required' using errcode = '22023';
  end if;
  p := private.agent_changes_project(mark_agent_changes_seen.project_id);
  insert into public.agent_changes_seen as s (project_id, user_id, seen_version)
  values (p.id, uid, least(mark_agent_changes_seen.version, p.revision))
  on conflict on constraint agent_changes_seen_pkey do update
    set seen_version = greatest(s.seen_version, excluded.seen_version), seen_at = now()
  returning s.seen_version into marked;
  return jsonb_build_object('project_id', p.id, 'seen', marked);
end;
$function$;

CREATE OR REPLACE FUNCTION public.count_agent_changes (
  project_id uuid
)
  RETURNS integer
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.count_agent_changes(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."count_agent_changes"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_agent_changes (
  project_id uuid,
  before     bigint  DEFAULT NULL::bigint,
  max_count  integer DEFAULT 20
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_agent_changes(project_id, before, max_count)
$function$;

REVOKE ALL ON FUNCTION "public"."list_agent_changes"(uuid, bigint, integer) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.mark_agent_changes_seen (
  project_id uuid,
  version    bigint
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.mark_agent_changes_seen(project_id, version)
$function$;

REVOKE ALL ON FUNCTION "public"."mark_agent_changes_seen"(uuid, bigint) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."agent_changes_seen"
  ADD CONSTRAINT "agent_changes_seen_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."agent_changes_seen"
  ADD CONSTRAINT "agent_changes_seen_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX agent_changes_seen_user_id_idx ON public.agent_changes_seen USING btree (user_id);

CREATE INDEX file_versions_agent_changes_idx ON public.file_versions USING btree (project_id, VERSION DESC)
  WHERE (agent_client_id IS NOT NULL);

CREATE POLICY "People can read their own agent changes marker" ON "public"."agent_changes_seen"
  FOR SELECT
  TO "authenticated"
  USING (((user_id = ( SELECT auth.uid() AS uid)) AND (project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids))));

REVOKE ALL ON FUNCTION "private"."agent_changes_project"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."agent_changes_project"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."agent_changes_seen_version"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."agent_changes_seen_version"(uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."count_agent_changes"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."count_agent_changes"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."list_agent_changes"(uuid, bigint, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_agent_changes"(uuid, bigint, integer) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."mark_agent_changes_seen"(uuid, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."mark_agent_changes_seen"(uuid, bigint) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."count_agent_changes"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_agent_changes"(uuid, bigint, integer) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."mark_agent_changes_seen"(uuid, bigint) TO "authenticated", "postgres";

REVOKE ALL ON TABLE "public"."agent_changes_seen" FROM "authenticated";

GRANT SELECT ON TABLE "public"."agent_changes_seen" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."agent_changes_seen" TO "postgres";

REVOKE ALL ON TABLE "public"."agent_changes_seen" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."agent_changes_seen" TO "service_role";
