SET local check_function_bodies = off;

CREATE TABLE "public"."comment_threads" (
  "id"           uuid                     NOT NULL,
  "project_id"   uuid                     NOT NULL,
  "file_id"      uuid                     NOT NULL,
  "file_version" bigint                   NOT NULL,
  "anchor"       jsonb                    NOT NULL,
  "created_by"   uuid,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at"  timestamp with time zone,
  "resolved_by"  uuid,
  CONSTRAINT "comment_threads_file_version_positive" CHECK ((file_version > 0)),
  CONSTRAINT "comment_threads_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."comment_threads"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."comment_threads" FROM "anon";

CREATE TABLE "public"."comments" (
  "id"              uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "thread_id"       uuid                     NOT NULL,
  "project_id"      uuid                     NOT NULL,
  "author_id"       uuid,
  "agent_client_id" text,
  "body"            text,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "edited_at"       timestamp with time zone,
  "deleted_at"      timestamp with time zone,
  CONSTRAINT "comments_agent_client_id_length" CHECK (((agent_client_id IS NULL) OR (char_length(agent_client_id) <= 255))),
  CONSTRAINT "comments_body_valid" CHECK (((body IS NULL) OR ((char_length(body) >= 1) AND (char_length(body) <= 5000) AND (body ~ '\S'::text)))),
  CONSTRAINT "comments_deleted_has_no_body" CHECK (((deleted_at IS NULL) = (body IS NOT NULL))),
  CONSTRAINT "comments_pkey" PRIMARY KEY (id)
);

ALTER TABLE "public"."comments"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."comments" FROM "anon";

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

  select * into t from public.comment_threads ct where ct.id = add_comment.thread_id;
  if t.id is not null then
    if t.project_id = p.id and t.file_id = add_comment.file_id and t.created_by = uid then
      return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
    end if;
    raise exception 'This comment id was already used' using errcode = '22023';
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
  returning * into t;
  insert into public.comments (thread_id, project_id, author_id, agent_client_id, body)
  values (t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), add_comment.body);

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.check_comment_body (
  body text
)
  RETURNS void
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if check_comment_body.body is null or char_length(check_comment_body.body) < 1
    or char_length(check_comment_body.body) > 5000 or check_comment_body.body !~ '\S' then
    raise exception 'A comment is 1 to 5000 characters' using errcode = '22023';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.comment_json (
  c public.comments
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', c.id,
    'author', private.comment_person(c.author_id),
    'via_agent', c.agent_client_id is not null,
    'body', c.body,
    'created_at', c.created_at,
    'edited_at', c.edited_at,
    'deleted_at', c.deleted_at
  )
$function$;

CREATE OR REPLACE FUNCTION private.comment_person (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('user_id', u.id, 'email', u.email::text)
  from auth.users u
  where u.id = comment_person.user_id
$function$;

CREATE OR REPLACE FUNCTION private.comment_project (
  project_id uuid
)
  RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if comment_project.project_id is null or private.project_role(comment_project.project_id) is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  return comment_project.project_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_comment (
  comment_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  c public.comments;
  thread_deleted boolean := false;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = delete_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = delete_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid and p.owner_id <> uid then
    raise exception 'Only its author or the project owner can delete a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    return jsonb_build_object('revision', p.revision, 'comment_id', c.id, 'thread_deleted', false);
  end if;

  update public.comments cm set body = null, deleted_at = now() where cm.id = c.id;
  if not exists (
    select 1 from public.comments cm where cm.thread_id = c.thread_id and cm.deleted_at is null
  ) then
    delete from public.comment_threads ct where ct.id = c.thread_id;
    thread_deleted := true;
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment_id', c.id, 'thread_deleted', thread_deleted);
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_comment_thread (
  thread_id uuid
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
    raise exception 'Only a signed-in person can delete comments; agents can resolve them' using errcode = '42501';
  end if;
  if delete_comment_thread.thread_id is null then
    raise exception 'Thread id required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = delete_comment_thread.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = delete_comment_thread.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if p.owner_id <> uid and (
    t.created_by is distinct from uid
    or exists (
      select 1 from public.comments cm
      where cm.thread_id = t.id and cm.deleted_at is null and cm.author_id is distinct from uid
    )
  ) then
    raise exception 'Only the project owner can delete a thread with other people''s comments' using errcode = '42501';
  end if;

  delete from public.comment_threads ct where ct.id = t.id;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread_id', t.id, 'deleted', true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.edit_comment (
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
  c public.comments;
  new_revision bigint;
begin
  perform private.check_limit('comment_writes_per_minute');
  if edit_comment.comment_id is null then
    raise exception 'Comment id required' using errcode = '22023';
  end if;
  perform private.check_comment_body(edit_comment.body);

  p := private.lock_project_for_comment(
    private.comment_project((select cm.project_id from public.comments cm where cm.id = edit_comment.comment_id))
  );
  select * into c from public.comments cm where cm.id = edit_comment.comment_id and cm.project_id = p.id;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.author_id is distinct from uid then
    raise exception 'Only its author can edit a comment' using errcode = '42501';
  end if;
  if c.deleted_at is not null then
    raise exception 'This comment was deleted' using errcode = '22023';
  end if;
  if c.body = edit_comment.body then
    return jsonb_build_object('revision', p.revision, 'comment', private.comment_json(c));
  end if;

  update public.comments cm set body = edit_comment.body, edited_at = now()
  where cm.id = c.id
  returning * into c;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
$function$;

CREATE OR REPLACE FUNCTION private.is_valid_comment_anchor (
  anchor jsonb
)
  RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  anchor_keys text[];
  quote jsonb;
  quote_keys text[];
  place jsonb;
  place_keys text[];
  point jsonb;
  point_keys text[];
begin
  if jsonb_typeof(anchor) is distinct from 'object' or jsonb_typeof(anchor -> 'kind') is distinct from 'string' then
    return false;
  end if;
  select coalesce(array_agg(k), '{}') into anchor_keys from jsonb_object_keys(anchor) k;

  if anchor ->> 'kind' = 'document' then
    return anchor_keys <@ array['kind'];
  end if;

  if anchor ->> 'kind' in ('section', 'text') then
    if not (anchor_keys <@ array['kind', 'quote', 'position'] and array['kind', 'quote', 'position'] <@ anchor_keys) then
      return false;
    end if;
    quote := anchor -> 'quote';
    place := anchor -> 'position';
    if jsonb_typeof(quote) <> 'object' or jsonb_typeof(place) <> 'object' then
      return false;
    end if;
    select coalesce(array_agg(k), '{}') into quote_keys from jsonb_object_keys(quote) k;
    select coalesce(array_agg(k), '{}') into place_keys from jsonb_object_keys(place) k;
    if not (quote_keys <@ array['type', 'exact', 'prefix', 'suffix'] and array['type', 'exact', 'prefix', 'suffix'] <@ quote_keys)
      or not (place_keys <@ array['type', 'start', 'end'] and array['type', 'start', 'end'] <@ place_keys) then
      return false;
    end if;
    if jsonb_typeof(quote -> 'type') <> 'string' or quote ->> 'type' <> 'TextQuoteSelector'
      or jsonb_typeof(quote -> 'exact') <> 'string' or jsonb_typeof(quote -> 'prefix') <> 'string'
      or jsonb_typeof(quote -> 'suffix') <> 'string' then
      return false;
    end if;
    -- 32 UTF-16 code units of context are never more than 32 characters.
    if char_length(quote ->> 'exact') < 1 or char_length(quote ->> 'exact') > 5000
      or char_length(quote ->> 'prefix') > 32 or char_length(quote ->> 'suffix') > 32 then
      return false;
    end if;
    if jsonb_typeof(place -> 'type') <> 'string' or place ->> 'type' <> 'TextPositionSelector'
      or jsonb_typeof(place -> 'start') <> 'number' or jsonb_typeof(place -> 'end') <> 'number' then
      return false;
    end if;
    -- Whole numbers only, and never past the largest file (2 MiB).
    if (place ->> 'start') !~ '^(0|[1-9][0-9]{0,6})$' or (place ->> 'end') !~ '^(0|[1-9][0-9]{0,6})$' then
      return false;
    end if;
    return (place ->> 'start')::integer < (place ->> 'end')::integer and (place ->> 'end')::integer <= 2097152;
  end if;

  if anchor ->> 'kind' = 'element' then
    if not (anchor_keys <@ array['kind', 'element_id', 'label', 'point'] and array['kind', 'element_id', 'label'] <@ anchor_keys) then
      return false;
    end if;
    if jsonb_typeof(anchor -> 'element_id') <> 'string' or jsonb_typeof(anchor -> 'label') <> 'string' then
      return false;
    end if;
    if char_length(anchor ->> 'element_id') < 1 or char_length(anchor ->> 'element_id') > 256
      or char_length(anchor ->> 'label') > 200 then
      return false;
    end if;
    if not (anchor ? 'point') then
      return true;
    end if;
    point := anchor -> 'point';
    if jsonb_typeof(point) <> 'object' then
      return false;
    end if;
    select coalesce(array_agg(k), '{}') into point_keys from jsonb_object_keys(point) k;
    if not (point_keys <@ array['x', 'y'] and array['x', 'y'] <@ point_keys)
      or jsonb_typeof(point -> 'x') <> 'number' or jsonb_typeof(point -> 'y') <> 'number' then
      return false;
    end if;
    return (point ->> 'x')::numeric >= 0 and (point ->> 'x')::numeric <= 1
      and (point ->> 'y')::numeric >= 0 and (point ->> 'y')::numeric <= 1;
  end if;

  return false;
end;
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
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute'),
    ('invitations_per_day', 50, interval '1 day', 'invitations a day'),
    ('comment_writes_per_minute', 120, interval '1 minute', 'comment changes a minute')
$function$;

CREATE OR REPLACE FUNCTION private.list_comments (
  project_id uuid,
  file_id    uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects;
begin
  perform private.require_user();
  select * into p from public.projects where id = list_comments.project_id;
  if p.id is null or private.project_role(p.id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'project_id', p.id,
    'revision', p.revision,
    'threads', coalesce(
      (select jsonb_agg(private.thread_json(t) order by t.created_at, t.id)
       from public.comment_threads t
       where t.project_id = p.id
         and (list_comments.file_id is null or t.file_id = list_comments.file_id)),
      '[]'::jsonb
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.lock_project_for_comment (
  project_id     uuid,
  allow_archived boolean DEFAULT false
)
  RETURNS public.projects
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  p public.projects;
  caller_role text;
begin
  perform private.require_user();
  select * into p from public.projects where id = lock_project_for_comment.project_id for update;
  caller_role := private.project_role(lock_project_for_comment.project_id);
  if p.id is null or caller_role is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  if caller_role not in ('owner', 'editor', 'commenter') then
    raise exception 'Commenting needs commenter access' using errcode = '42501';
  end if;
  if p.archived_at is not null and not lock_project_for_comment.allow_archived then
    raise exception 'Project is archived' using errcode = '55000';
  end if;
  return p;
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

  select * into c from public.comments cm where cm.id = reply_comment.comment_id;
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
  returning * into c;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
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

  update public.comment_threads ct
  set resolved_at = case when set_comment_resolved.resolved then now() end,
      resolved_by = case when set_comment_resolved.resolved then uid end
  where ct.id = t.id
  returning * into t;
  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  return jsonb_build_object('revision', new_revision, 'thread', private.thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.thread_json (
  t public.comment_threads
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', t.id,
    'file_id', t.file_id,
    'path', coalesce(
      (select f.path from public.project_files f where f.id = t.file_id and f.project_id = t.project_id),
      (select v.path from public.file_versions v
       where v.file_id = t.file_id and v.project_id = t.project_id
       order by v.version desc limit 1)
    ),
    'file_deleted', not exists (
      select 1 from public.project_files f where f.id = t.file_id and f.project_id = t.project_id
    ),
    'file_version', t.file_version,
    'anchor', t.anchor,
    'created_at', t.created_at,
    'resolved_at', t.resolved_at,
    'resolved_by', private.comment_person(t.resolved_by),
    'comments', coalesce(
      (select jsonb_agg(private.comment_json(c) order by c.created_at, c.id)
       from public.comments c where c.thread_id = t.id),
      '[]'::jsonb
    )
  )
$function$;

CREATE OR REPLACE FUNCTION public.add_comment (
  project_id   uuid,
  thread_id    uuid,
  file_id      uuid,
  file_version bigint,
  anchor       jsonb,
  body         text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.add_comment(project_id, thread_id, file_id, file_version, anchor, body)
$function$;

REVOKE ALL ON FUNCTION "public"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.delete_comment (
  comment_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.delete_comment(comment_id)
$function$;

REVOKE ALL ON FUNCTION "public"."delete_comment"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.delete_comment_thread (
  thread_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.delete_comment_thread(thread_id)
$function$;

REVOKE ALL ON FUNCTION "public"."delete_comment_thread"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.edit_comment (
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.edit_comment(comment_id, body)
$function$;

REVOKE ALL ON FUNCTION "public"."edit_comment"(uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_comments (
  project_id uuid,
  file_id    uuid DEFAULT NULL::uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_comments(project_id, file_id)
$function$;

REVOKE ALL ON FUNCTION "public"."list_comments"(uuid, uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.reopen_comment (
  thread_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.set_comment_resolved(thread_id, false)
$function$;

REVOKE ALL ON FUNCTION "public"."reopen_comment"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.reply_comment (
  thread_id  uuid,
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.reply_comment(thread_id, comment_id, body)
$function$;

REVOKE ALL ON FUNCTION "public"."reply_comment"(uuid, uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.resolve_comment (
  thread_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.set_comment_resolved(thread_id, true)
$function$;

REVOKE ALL ON FUNCTION "public"."resolve_comment"(uuid) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."comment_threads"
  ADD CONSTRAINT "comment_threads_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."comment_threads"
  ADD CONSTRAINT "comment_threads_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."comment_threads"
  ADD CONSTRAINT "comment_threads_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."comments"
  ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."comments"
  ADD CONSTRAINT "comments_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."comments"
  ADD CONSTRAINT "comments_thread_id_fkey" FOREIGN KEY (thread_id) REFERENCES public.comment_threads(id) ON DELETE CASCADE;

CREATE INDEX comment_threads_created_by_idx ON public.comment_threads USING btree (created_by);

CREATE INDEX comment_threads_project_file_idx ON public.comment_threads USING btree (project_id, file_id);

CREATE INDEX comment_threads_resolved_by_idx ON public.comment_threads USING btree (resolved_by);

CREATE INDEX comments_author_id_idx ON public.comments USING btree (author_id);

CREATE INDEX comments_project_id_idx ON public.comments USING btree (project_id);

CREATE INDEX comments_thread_idx ON public.comments USING btree (thread_id, created_at, id);

CREATE POLICY "People can read comment threads in their projects" ON "public"."comment_threads"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

CREATE POLICY "People can read comments in their projects" ON "public"."comments"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

REVOKE ALL ON FUNCTION "private"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."check_comment_body"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."check_comment_body"(text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."comment_json"(public.comments) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."comment_json"(public.comments) TO "postgres";

REVOKE ALL ON FUNCTION "private"."comment_person"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."comment_person"(uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."comment_project"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."comment_project"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."delete_comment"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."delete_comment"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."delete_comment_thread"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."delete_comment_thread"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."edit_comment"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."edit_comment"(uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."is_valid_comment_anchor"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."is_valid_comment_anchor"(jsonb) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."list_comments"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_comments"(uuid, uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."lock_project_for_comment"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."lock_project_for_comment"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."reply_comment"(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."reply_comment"(uuid, uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_comment_resolved"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_comment_resolved"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."thread_json"(public.comment_threads) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."thread_json"(public.comment_threads) TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."delete_comment"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."delete_comment_thread"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."edit_comment"(uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_comments"(uuid, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."reopen_comment"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."reply_comment"(uuid, uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."resolve_comment"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON TABLE "public"."comment_threads" FROM "authenticated";

GRANT SELECT ON TABLE "public"."comment_threads" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."comment_threads" TO "postgres";

REVOKE ALL ON TABLE "public"."comment_threads" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."comment_threads" TO "service_role";

REVOKE ALL ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ON TABLE "public"."comments" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."comments" TO "postgres";

REVOKE ALL ON TABLE "public"."comments" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."comments" TO "service_role";

ALTER TABLE "public"."comment_threads"
  ADD CONSTRAINT "comment_threads_anchor_valid" CHECK (private.is_valid_comment_anchor(anchor));
