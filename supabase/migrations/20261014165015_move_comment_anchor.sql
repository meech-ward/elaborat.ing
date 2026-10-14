SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.move_comment_anchor (
  thread_id    uuid,
  file_version bigint,
  anchor       jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  t public.comment_threads;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can move a comment; agents can reply' using errcode = '42501';
  end if;
  if move_comment_anchor.thread_id is null or move_comment_anchor.file_version is null
    or move_comment_anchor.file_version <= 0 then
    raise exception 'A thread id and a positive file version are required' using errcode = '22023';
  end if;
  if not coalesce(private.is_valid_comment_anchor(move_comment_anchor.anchor), false) then
    raise exception 'Invalid anchor' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = move_comment_anchor.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = move_comment_anchor.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if t.created_by is distinct from uid and coalesce(private.project_role(p.id), '') not in ('owner', 'editor') then
    raise exception 'Only the person who started a thread, an editor or the owner can move it' using errcode = '42501';
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  update public.comment_threads ct
  set anchor = move_comment_anchor.anchor, file_version = move_comment_anchor.file_version
  where ct.id = t.id
  returning * into t;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION public.move_comment_anchor (
  thread_id    uuid,
  file_version bigint,
  anchor       jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.move_comment_anchor(thread_id, file_version, anchor)
$function$;

REVOKE ALL ON FUNCTION "public"."move_comment_anchor"(uuid, bigint, jsonb) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."move_comment_anchor"(uuid, bigint, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."move_comment_anchor"(uuid, bigint, jsonb) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."move_comment_anchor"(uuid, bigint, jsonb) TO "authenticated", "postgres";
