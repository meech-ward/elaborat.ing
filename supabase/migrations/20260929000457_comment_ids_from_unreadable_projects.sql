SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.add_comment (
  project_id   uuid,
  thread_id    uuid,
  file_id      uuid,
  file_version bigint,
  anchor       jsonb,
  body         text
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
  if add_comment.project_id is null or add_comment.thread_id is null or add_comment.file_id is null
    or add_comment.file_version is null or add_comment.file_version <= 0 then
    raise exception 'Project, thread and file ids and a positive file version are required' using errcode = '22023';
  end if;
  perform private.check_comment_body(add_comment.body);
  if not coalesce(private.is_valid_comment_anchor(add_comment.anchor), false) then
    raise exception 'Invalid anchor' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(add_comment.project_id, true);

  select * into t from public.comment_threads ct
  where ct.id = add_comment.thread_id and ct.project_id in (select private.readable_project_ids());
  if t.id is not null then
    if t.project_id = p.id and t.file_id = add_comment.file_id and t.created_by = uid then
      return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
  end if;
  if exists (
    select 1 from private.deleted_comment_threads d where d.project_id = p.id and d.id = add_comment.thread_id
  ) then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.project_files f where f.id = add_comment.file_id and f.project_id = p.id
  ) then
    raise exception 'No such file in this project' using errcode = '22023';
  end if;
  if (select count(*) from public.comment_threads ct
      where ct.project_id = p.id and ct.file_id = add_comment.file_id) >= 1000 then
    raise exception 'A file can have at most 1000 comment threads' using errcode = '54000';
  end if;
  if (select count(*) from public.comments c where c.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  insert into public.comment_threads (id, project_id, file_id, file_version, anchor, created_by)
  values (add_comment.thread_id, p.id, add_comment.file_id, add_comment.file_version, add_comment.anchor, uid)
  on conflict (id) do nothing
  returning * into t;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  insert into public.comments (thread_id, project_id, author_id, agent_client_id, body)
  values (t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), add_comment.body);

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.reply_comment (
  thread_id  uuid,
  comment_id uuid,
  body       text
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
  c public.comments;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if reply_comment.thread_id is null or reply_comment.comment_id is null then
    raise exception 'Thread and comment ids are required' using errcode = '22023';
  end if;
  perform private.check_comment_body(reply_comment.body);

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = reply_comment.thread_id)),
    true
  );
  -- Every comment write locks the project first, so the thread cannot change now.
  select * into t from public.comment_threads ct where ct.id = reply_comment.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;

  select * into c from public.comments cm
  where cm.id = reply_comment.comment_id and cm.project_id in (select private.readable_project_ids());
  if c.id is not null then
    if c.thread_id = t.id and c.author_id = uid then
      return jsonb_build_object('revision', p.revision, 'comment', private.comment_json(c));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
  end if;

  if p.archived_at is not null then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  if (select count(*) from public.comments cm where cm.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  insert into public.comments (id, thread_id, project_id, author_id, agent_client_id, body)
  values (reply_comment.comment_id, t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), reply_comment.body)
  on conflict (id) do nothing
  returning * into c;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
$function$;
