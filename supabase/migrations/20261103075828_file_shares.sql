SET local check_function_bodies = off;

CREATE TABLE "private"."file_share_comments" (
  "id"         uuid                     NOT NULL,
  "thread_id"  uuid                     NOT NULL,
  "author_id"  uuid,
  "body"       text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "edited_at"  timestamp with time zone,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "file_share_comments_body_valid" CHECK ((((deleted_at IS NOT NULL) AND (body IS NULL)) OR ((deleted_at IS NULL) AND (body IS
    NOT NULL) AND ((char_length(body) >= 1) AND (char_length(body) <= 10000)) AND (body ~ '\S'::text)))),
  CONSTRAINT "file_share_comments_pkey" PRIMARY KEY (id)
);

ALTER TABLE "private"."file_share_comments"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."file_share_threads" (
  "id"           uuid                     NOT NULL,
  "share_id"     uuid                     NOT NULL,
  "file_version" bigint                   NOT NULL,
  "anchor"       jsonb                    NOT NULL,
  "created_by"   uuid,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at"  timestamp with time zone,
  "resolved_by"  uuid,
  CONSTRAINT "file_share_threads_file_version_check" CHECK ((file_version > 0)),
  CONSTRAINT "file_share_threads_pkey" PRIMARY KEY (id),
  CONSTRAINT "file_share_threads_anchor_check" CHECK (private.is_valid_comment_anchor(anchor))
);

ALTER TABLE "private"."file_share_threads"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "private"."file_shares" (
  "id"         uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "project_id" uuid                     NOT NULL,
  "file_id"    uuid                     NOT NULL,
  "token"      text                     NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  CONSTRAINT "file_shares_pkey" PRIMARY KEY (id),
  CONSTRAINT "file_shares_project_id_file_id_key" UNIQUE (project_id, file_id),
  CONSTRAINT "file_shares_token_check" CHECK ((token ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT "file_shares_token_key" UNIQUE (token)
);

ALTER TABLE "private"."file_shares"
  ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION private.active_file_share (
  token text
)
  RETURNS private.file_shares
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare s private.file_shares;
begin
  if active_file_share.token is null or active_file_share.token !~ '^[0-9a-f]{64}$' then
    raise exception 'Shared file unavailable' using errcode = '42501';
  end if;
  select * into s from private.file_shares fs
  where fs.token = active_file_share.token and fs.revoked_at is null
    and exists (select 1 from public.project_files f where f.id = fs.file_id and f.project_id = fs.project_id);
  if s.id is null then
    raise exception 'Shared file unavailable' using errcode = '42501';
  end if;
  return s;
end;
$function$;

CREATE OR REPLACE FUNCTION private.add_file_share_comment (
  token        text,
  thread_id    uuid,
  comment_id   uuid,
  file_version bigint,
  anchor       jsonb,
  body         text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares; t private.file_share_threads; c private.file_share_comments;
begin
  s := private.lock_file_share_comment(token);
  if thread_id is null or comment_id is null or file_version is null or file_version <= 0
    or not coalesce(private.is_valid_comment_anchor(anchor), false) then
    raise exception 'A thread id, comment id, file version and valid anchor are required' using errcode = '22023';
  end if;
  select * into t from private.file_share_threads ft where ft.id = add_file_share_comment.thread_id;
  if t.id is not null then
    if t.share_id = s.id and t.created_by = uid and exists (
      select 1 from private.file_share_comments fc where fc.id = add_file_share_comment.comment_id
        and fc.thread_id = t.id and fc.author_id = uid and fc.deleted_at is null
    ) then return jsonb_build_object('thread', private.file_share_thread_json(t)); end if;
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if not exists (select 1 from public.project_files f where f.id = s.file_id and f.project_id = s.project_id and f.version = add_file_share_comment.file_version) then
    raise exception 'The file changed. Refresh before commenting.' using errcode = '40001';
  end if;
  perform private.check_file_share_body(s.id, body);
  if (select count(*) from private.file_share_threads ft where ft.share_id = s.id) >= 1000 then
    raise exception 'A shared file can have at most 1000 comment threads' using errcode = '54000';
  end if;
  if (select count(*) from private.file_share_comments fc join private.file_share_threads ft on ft.id = fc.thread_id where ft.share_id = s.id) >= 2000 then
    raise exception 'A shared file can have at most 2000 comments' using errcode = '54000';
  end if;
  insert into private.file_share_threads(id, share_id, file_version, anchor, created_by)
  values(thread_id, s.id, file_version, anchor, uid) on conflict (id) do nothing returning * into t;
  if t.id is null then raise exception 'Comment unavailable' using errcode = '42501'; end if;
  insert into private.file_share_comments(id, thread_id, author_id, body)
  values(comment_id, t.id, uid, body) on conflict (id) do nothing returning * into c;
  if c.id is null then raise exception 'Comment unavailable' using errcode = '42501'; end if;
  return jsonb_build_object('thread', private.file_share_thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.check_file_share_body (
  share_id      uuid,
  body          text,
  previous_body text DEFAULT NULL::text
)
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare used bigint;
begin
  if body is null or char_length(body) not between 1 and 10000 or body !~ '\S' then
    raise exception 'A comment is 1 to 10000 characters' using errcode = '22023';
  end if;
  select coalesce(sum(octet_length(c.body)), 0) into used
  from private.file_share_comments c join private.file_share_threads t on t.id = c.thread_id
  where t.share_id = check_file_share_body.share_id;
  if used - coalesce(octet_length(previous_body), 0) + octet_length(body) > 2097152 then
    raise exception 'This discussion has reached its comment size limit' using errcode = '54000';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.delete_file_share_comment (
  token      text,
  comment_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares; c private.file_share_comments; owner_id uuid;
begin
  s := private.lock_file_share_comment(token);
  select p.owner_id into owner_id from public.projects p where p.id = s.project_id;
  select fc.* into c from private.file_share_comments fc join private.file_share_threads ft on ft.id = fc.thread_id
  where fc.id = delete_file_share_comment.comment_id and ft.share_id = s.id;
  if c.id is null or (c.author_id is distinct from uid and owner_id <> uid) then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if c.deleted_at is null then
    update private.file_share_comments fc set body = null, deleted_at = now() where fc.id = c.id returning * into c;
  end if;
  return jsonb_build_object('comment', private.file_share_comment_json(c));
end;
$function$;

CREATE OR REPLACE FUNCTION private.edit_file_share_comment (
  token      text,
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares; c private.file_share_comments;
begin
  s := private.lock_file_share_comment(token);
  select fc.* into c from private.file_share_comments fc join private.file_share_threads ft on ft.id = fc.thread_id
  where fc.id = edit_file_share_comment.comment_id and ft.share_id = s.id;
  if c.id is null or c.author_id is distinct from uid or c.deleted_at is not null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  perform private.check_file_share_body(s.id, body, c.body);
  if c.body is distinct from body then
    update private.file_share_comments fc set body = edit_file_share_comment.body, edited_at = now()
    where fc.id = c.id returning * into c;
  end if;
  return jsonb_build_object('comment', private.file_share_comment_json(c));
end;
$function$;

CREATE OR REPLACE FUNCTION private.file_share_asset (
  project_id uuid,
  asset_id   uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('id', a.id, 'media_type', a.media_type,
    'byte_length', a.byte_length, 'width', a.width, 'height', a.height, 'sha256', a.sha256,
    'object_key', a.object_key, 'preview_key', a.preview_key,
    'preview_type', a.preview_type, 'preview_byte_length', a.preview_byte_length)
  from public.image_assets a where a.project_id = file_share_asset.project_id
    and a.id = file_share_asset.asset_id and a.state = 'committed'
$function$;

CREATE OR REPLACE FUNCTION private.file_share_author (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('user_id', u.id, 'email', null, 'name',
    case when label like '%@%' then 'Guest' else left(regexp_replace(label, '\s+', ' ', 'g'), 80) end)
  from auth.users u cross join lateral (
    select coalesce(nullif(btrim(u.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''), 'Guest') as label
  ) names
  where u.id = file_share_author.user_id
$function$;

CREATE OR REPLACE FUNCTION private.file_share_comment_json (
  c private.file_share_comments
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('id', c.id, 'author', private.file_share_author(c.author_id),
    'via_agent', false, 'agent', null, 'body', c.body, 'created_at', c.created_at,
    'edited_at', c.edited_at, 'deleted_at', c.deleted_at, 'file_version', null)
$function$;

CREATE OR REPLACE FUNCTION private.file_share_context (
  token text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare s private.file_shares := private.active_file_share(token); f public.project_files; p public.projects;
begin
  select * into f from public.project_files where id = s.file_id and project_id = s.project_id;
  select * into p from public.projects where id = s.project_id;
  return jsonb_build_object('id', s.id, 'project_id', s.project_id, 'file_id', f.id, 'path', f.path,
    'content', f.content, 'kind', f.kind, 'asset_id', f.asset_id, 'asset', private.file_share_asset(f.project_id, f.asset_id),
    'version', f.version, 'revision', p.revision, 'archived', p.archived_at is not null);
end;
$function$;

CREATE OR REPLACE FUNCTION private.file_share_dependencies (
  token text,
  paths text[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare s private.file_shares := private.active_file_share(token);
begin
  if paths is null or cardinality(paths) > 128 or coalesce(array_ndims(paths), 1) <> 1
    or array_position(paths, null) is not null or exists (select 1 from unnest(paths) path where not private.is_valid_path(path)) then
    raise exception 'At most 128 valid dependency paths are required' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path,
    'content', f.content, 'kind', f.kind, 'asset_id', f.asset_id,
    'asset', private.file_share_asset(f.project_id, f.asset_id), 'version', f.version) order by f.path)
    from public.project_files f where f.project_id = s.project_id and f.path = any(paths)), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION private.file_share_owner_json (
  s private.file_shares
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('id', s.id, 'file_id', s.file_id,
    'path', (select f.path from public.project_files f where f.id = s.file_id and f.project_id = s.project_id),
    'token', s.token, 'created_at', s.created_at, 'revoked_at', s.revoked_at)
$function$;

CREATE OR REPLACE FUNCTION private.file_share_person()
  RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SET search_path TO ''
  AS $function$
declare uid uuid := private.require_user();
begin
  if private.is_oauth_client() or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
    or not exists (select 1 from auth.users where id = uid) then
    raise exception 'Sign in as a person to use file sharing' using errcode = '42501';
  end if;
  return uid;
end;
$function$;

CREATE OR REPLACE FUNCTION private.file_share_thread_json (
  t private.file_share_threads
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object('id', t.id, 'file_id', s.file_id, 'path', f.path,
    'file_deleted', false, 'file_version', t.file_version, 'anchor', t.anchor,
    'created_at', t.created_at, 'resolved_at', t.resolved_at, 'resolved_by', private.file_share_author(t.resolved_by),
    'ask_agent', false, 'comments', coalesce((select jsonb_agg(private.file_share_comment_json(c) order by c.created_at, c.id)
      from private.file_share_comments c where c.thread_id = t.id), '[]'::jsonb))
  from private.file_shares s join public.project_files f on f.id = s.file_id and f.project_id = s.project_id
  where s.id = t.share_id
$function$;

CREATE OR REPLACE FUNCTION private.get_file_share (
  project_id uuid,
  file_id    uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares;
begin
  if not exists (select 1 from public.projects p where p.id = get_file_share.project_id and p.owner_id = uid)
    or not exists (select 1 from public.project_files f where f.id = get_file_share.file_id and f.project_id = get_file_share.project_id) then
    raise exception 'File unavailable' using errcode = '42501';
  end if;
  select * into s from private.file_shares fs
  where fs.project_id = get_file_share.project_id and fs.file_id = get_file_share.file_id;
  return case when s.id is null then null else private.file_share_owner_json(s) end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.list_file_share_comments (
  token text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare s private.file_shares := private.active_file_share(token); p public.projects; f public.project_files;
begin
  select * into p from public.projects where id = s.project_id;
  select * into f from public.project_files where id = s.file_id and project_id = s.project_id;
  return jsonb_build_object('share_id', s.id, 'file_id', s.file_id, 'file_version', f.version,
    'archived', p.archived_at is not null, 'can_moderate', coalesce(p.owner_id = (select auth.uid()), false),
    'threads', coalesce((select jsonb_agg(private.file_share_thread_json(t) order by t.created_at, t.id)
      from private.file_share_threads t where t.share_id = s.id), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION private.lock_file_share_comment (
  token text
)
  RETURNS private.file_shares
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare s private.file_shares; p public.projects;
begin
  perform private.file_share_person();
  perform private.check_limit('comment_writes_per_minute');
  s := private.active_file_share(token);
  select * into p from public.projects where id = s.project_id for update;
  s := private.active_file_share(token);
  perform 1 from private.file_shares fs where fs.id = s.id for update;
  if p.archived_at is not null then raise exception 'Project is archived' using errcode = '55000'; end if;
  return s;
end;
$function$;

CREATE OR REPLACE FUNCTION private.reply_file_share_comment (
  token      text,
  thread_id  uuid,
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares; t private.file_share_threads; c private.file_share_comments;
begin
  s := private.lock_file_share_comment(token);
  if thread_id is null or comment_id is null then raise exception 'Comment unavailable' using errcode = '42501'; end if;
  select * into t from private.file_share_threads ft where ft.id = reply_file_share_comment.thread_id and ft.share_id = s.id;
  if t.id is null then raise exception 'Comment unavailable' using errcode = '42501'; end if;
  select * into c from private.file_share_comments fc where fc.id = reply_file_share_comment.comment_id;
  if c.id is not null then
    if c.thread_id = t.id and c.author_id = uid and c.deleted_at is null then
      return jsonb_build_object('comment', private.file_share_comment_json(c));
    end if;
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  perform private.check_file_share_body(s.id, body);
  if (select count(*) from private.file_share_comments fc join private.file_share_threads ft on ft.id = fc.thread_id where ft.share_id = s.id) >= 2000 then
    raise exception 'A shared file can have at most 2000 comments' using errcode = '54000';
  end if;
  insert into private.file_share_comments(id, thread_id, author_id, body) values(comment_id, t.id, uid, body)
  on conflict (id) do nothing returning * into c;
  if c.id is null then raise exception 'Comment unavailable' using errcode = '42501'; end if;
  return jsonb_build_object('comment', private.file_share_comment_json(c));
end;
$function$;

CREATE OR REPLACE FUNCTION private.resolve_file_share_thread (
  token     text,
  thread_id uuid,
  resolved  boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); s private.file_shares; t private.file_share_threads; owner_id uuid;
begin
  s := private.lock_file_share_comment(token);
  select p.owner_id into owner_id from public.projects p where p.id = s.project_id;
  select * into t from private.file_share_threads ft where ft.id = resolve_file_share_thread.thread_id and ft.share_id = s.id;
  if t.id is null or (t.created_by is distinct from uid and owner_id <> uid) then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if resolved is null then raise exception 'Choose whether to resolve the thread' using errcode = '22023'; end if;
  if resolved is distinct from (t.resolved_at is not null) then
    update private.file_share_threads ft set resolved_at = case when resolved then now() else null end,
      resolved_by = case when resolved then uid else null end where ft.id = t.id returning * into t;
  end if;
  return jsonb_build_object('thread', private.file_share_thread_json(t));
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_file_share (
  project_id   uuid,
  file_id      uuid,
  enabled      boolean,
  replace_link boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.file_share_person(); p public.projects; s private.file_shares;
begin
  if enabled is null or replace_link is null then
    raise exception 'Choose whether to enable the link' using errcode = '22023';
  end if;
  perform private.count_use(uid, 'file_share_changes_per_minute', 60, interval '1 minute', 'file share changes a minute');
  select * into p from public.projects where id = set_file_share.project_id for update;
  if p.id is null or p.owner_id <> uid
    or not exists (select 1 from public.project_files f where f.id = set_file_share.file_id and f.project_id = p.id) then
    raise exception 'File unavailable' using errcode = '42501';
  end if;
  select * into s from private.file_shares fs
  where fs.project_id = p.id and fs.file_id = set_file_share.file_id for update;
  if s.id is null then
    if not enabled then return null; end if;
    if (select count(*) from private.file_shares fs where fs.project_id = p.id) >= 1000 then
      raise exception 'A project can have at most 1000 file links' using errcode = '54000';
    end if;
    insert into private.file_shares(project_id, file_id, token)
    values (p.id, set_file_share.file_id, encode(extensions.gen_random_bytes(32), 'hex')) returning * into s;
  elsif enabled and (s.revoked_at is not null or replace_link) then
    update private.file_shares fs set token = encode(extensions.gen_random_bytes(32), 'hex'), revoked_at = null
    where fs.id = s.id returning * into s;
  elsif not enabled and s.revoked_at is null then
    update private.file_shares fs set revoked_at = now() where fs.id = s.id returning * into s;
  end if;
  return private.file_share_owner_json(s);
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_file_share_comment (
  token        text,
  thread_id    uuid,
  comment_id   uuid,
  file_version bigint,
  anchor       jsonb,
  body         text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.add_file_share_comment(token, thread_id, comment_id, file_version, anchor, body) $function$;

REVOKE ALL ON FUNCTION "public"."add_file_share_comment"(text, uuid, uuid, bigint, jsonb, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.delete_file_share_comment (
  token      text,
  comment_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.delete_file_share_comment(token, comment_id) $function$;

REVOKE ALL ON FUNCTION "public"."delete_file_share_comment"(text, uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.edit_file_share_comment (
  token      text,
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.edit_file_share_comment(token, comment_id, body) $function$;

REVOKE ALL ON FUNCTION "public"."edit_file_share_comment"(text, uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.file_share_context (
  token text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select private.file_share_context(token) $function$;

REVOKE ALL ON FUNCTION "public"."file_share_context"(text) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.file_share_dependencies (
  token text,
  paths text[]
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select private.file_share_dependencies(token, paths) $function$;

REVOKE ALL ON FUNCTION "public"."file_share_dependencies"(text, text[]) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.get_file_share (
  project_id uuid,
  file_id    uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select private.get_file_share(project_id, file_id) $function$;

REVOKE ALL ON FUNCTION "public"."get_file_share"(uuid, uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_file_share_comments (
  token text
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select private.list_file_share_comments(token) $function$;

REVOKE ALL ON FUNCTION "public"."list_file_share_comments"(text) FROM PUBLIC, "service_role";

CREATE OR REPLACE FUNCTION public.reply_file_share_comment (
  token      text,
  thread_id  uuid,
  comment_id uuid,
  body       text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.reply_file_share_comment(token, thread_id, comment_id, body) $function$;

REVOKE ALL ON FUNCTION "public"."reply_file_share_comment"(text, uuid, uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.resolve_file_share_thread (
  token     text,
  thread_id uuid,
  resolved  boolean
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.resolve_file_share_thread(token, thread_id, resolved) $function$;

REVOKE ALL ON FUNCTION "public"."resolve_file_share_thread"(text, uuid, boolean) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.set_file_share (
  project_id   uuid,
  file_id      uuid,
  enabled      boolean,
  replace_link boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.set_file_share(project_id, file_id, enabled, replace_link) $function$;

REVOKE ALL ON FUNCTION "public"."set_file_share"(uuid, uuid, boolean, boolean) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "private"."file_share_comments"
  ADD CONSTRAINT "file_share_comments_author_id_fkey" FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "private"."file_share_threads"
  ADD CONSTRAINT "file_share_threads_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "private"."file_share_comments"
  ADD CONSTRAINT "file_share_comments_thread_id_fkey" FOREIGN KEY (thread_id) REFERENCES private.file_share_threads(id) ON DELETE CASCADE;

ALTER TABLE "private"."file_share_threads"
  ADD CONSTRAINT "file_share_threads_resolved_by_fkey" FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "private"."file_share_threads"
  ADD CONSTRAINT "file_share_threads_share_id_fkey" FOREIGN KEY (share_id) REFERENCES private.file_shares(id) ON DELETE CASCADE;

ALTER TABLE "private"."file_shares"
  ADD CONSTRAINT "file_shares_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX file_share_comments_author_id_idx ON private.file_share_comments USING btree (author_id);

CREATE INDEX file_share_comments_thread_id_idx ON private.file_share_comments USING btree (thread_id);

CREATE INDEX file_share_threads_created_by_idx ON private.file_share_threads USING btree (created_by);

CREATE INDEX file_share_threads_resolved_by_idx ON private.file_share_threads USING btree (resolved_by);

CREATE INDEX file_share_threads_share_id_idx ON private.file_share_threads USING btree (share_id);

CREATE INDEX file_shares_file_id_idx ON private.file_shares USING btree (file_id);

CREATE POLICY "Public link comments are available only through checked functio" ON "private"."file_share_comments"
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Public link discussions are available only through checked func" ON "private"."file_share_threads"
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Capabilities are available only through checked functions" ON "private"."file_shares"
  FOR ALL
  TO "anon", "authenticated"
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON FUNCTION "private"."active_file_share"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."active_file_share"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."add_file_share_comment"(text, uuid, uuid, bigint, jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."add_file_share_comment"(text, uuid, uuid, bigint, jsonb, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."check_file_share_body"(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."check_file_share_body"(uuid, text, text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."delete_file_share_comment"(text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."delete_file_share_comment"(text, uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."edit_file_share_comment"(text, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."edit_file_share_comment"(text, uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_asset"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_asset"(uuid, uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_author"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_author"(uuid) TO "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_comment_json"(private.file_share_comments) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_comment_json"(private.file_share_comments) TO "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_context"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_context"(text) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."file_share_dependencies"(text, text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_dependencies"(text, text[]) TO "postgres", "service_role";

REVOKE ALL ON FUNCTION "private"."file_share_owner_json"(private.file_shares) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_owner_json"(private.file_shares) TO "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_person"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_person"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."file_share_thread_json"(private.file_share_threads) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."file_share_thread_json"(private.file_share_threads) TO "postgres";

REVOKE ALL ON FUNCTION "private"."get_file_share"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."get_file_share"(uuid, uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."list_file_share_comments"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_file_share_comments"(text) TO "anon", "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."lock_file_share_comment"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."lock_file_share_comment"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."reply_file_share_comment"(text, uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."reply_file_share_comment"(text, uuid, uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."resolve_file_share_thread"(text, uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."resolve_file_share_thread"(text, uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_file_share"(uuid, uuid, boolean, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_file_share"(uuid, uuid, boolean, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."add_file_share_comment"(text, uuid, uuid, bigint, jsonb, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."delete_file_share_comment"(text, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."edit_file_share_comment"(text, uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."file_share_context"(text) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."file_share_dependencies"(text, text[]) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."get_file_share"(uuid, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_file_share_comments"(text) TO "anon", "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."reply_file_share_comment"(text, uuid, uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."resolve_file_share_thread"(text, uuid, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."set_file_share"(uuid, uuid, boolean, boolean) TO "authenticated", "postgres";

REVOKE ALL ON SCHEMA "private" FROM "anon";

GRANT USAGE ON SCHEMA "private" TO "anon";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."file_share_comments" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."file_share_threads" TO "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."file_shares" TO "postgres";
