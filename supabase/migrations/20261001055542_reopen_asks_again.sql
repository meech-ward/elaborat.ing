SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.queue_ask_agent_events()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  latest uuid;
begin
  if new.ask_agent_revision is null or new.ask_agent_revision is not distinct from old.ask_agent_revision
    or new.created_by is null or new.resolved_at is not null
    or (old.ask_agent_revision is not null and old.resolved_at is null) then
    return null;
  end if;
  select c.id into latest from public.comments c
  where c.thread_id = new.id
    and c.author_id = new.created_by
    and c.agent_client_id is null
    and c.body is not null
  order by c.created_at desc, c.id desc
  limit 1;
  if latest is not null then
    perform private.queue_comment_event(new.created_by, new.project_id, new.file_id, latest);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_comment_resolved (
  thread_id uuid,
  resolved  boolean
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
  if set_comment_resolved.thread_id is null or set_comment_resolved.resolved is null then
    raise exception 'Thread id and resolved are required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = set_comment_resolved.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = set_comment_resolved.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if (t.resolved_at is not null) = set_comment_resolved.resolved then
    return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  update public.comment_threads ct
  set resolved_at = case when set_comment_resolved.resolved then now() end,
      resolved_by = case when set_comment_resolved.resolved then uid end,
      ask_agent_revision = case
        when not set_comment_resolved.resolved and t.created_by = uid
          and t.ask_agent_revision is not null and not private.is_oauth_client()
        then new_revision
        else ct.ask_agent_revision
      end
  where ct.id = t.id
  returning * into t;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;
