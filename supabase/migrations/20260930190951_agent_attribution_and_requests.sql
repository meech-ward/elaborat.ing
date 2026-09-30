SET local check_function_bodies = off;

REVOKE ALL ON TABLE "public"."file_versions" FROM "authenticated";

DROP FUNCTION "private"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text);

DROP FUNCTION "private"."list_comments"(uuid, uuid);

DROP FUNCTION "private"."reply_comment"(uuid, uuid, text);

DROP FUNCTION "public"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text);

DROP FUNCTION "public"."list_comments"(uuid, uuid);

DROP FUNCTION "public"."reply_comment"(uuid, uuid, text);

ALTER TABLE "public"."comment_threads"
  ADD COLUMN "ask_agent_revision" bigint;

ALTER TABLE "public"."comments"
  ADD COLUMN "file_version" bigint;

ALTER TABLE "public"."file_versions"
  ADD COLUMN "agent_client_id" text;

CREATE OR REPLACE FUNCTION private.add_comment (
  project_id   uuid,
  thread_id    uuid,
  file_id      uuid,
  file_version bigint,
  anchor       jsonb,
  body         text,
  ask_agent    boolean DEFAULT false
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
  if coalesce(add_comment.ask_agent, false) and private.is_oauth_client() then
    raise exception 'Only a signed-in person can ask an agent' using errcode = '42501';
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

  -- The project is locked, so this write takes the next revision.
  insert into public.comment_threads (id, project_id, file_id, file_version, anchor, created_by, ask_agent_revision)
  values (
    add_comment.thread_id, p.id, add_comment.file_id, add_comment.file_version, add_comment.anchor, uid,
    case when coalesce(add_comment.ask_agent, false) then p.revision + 1 end
  )
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

CREATE OR REPLACE FUNCTION private.agent_name (
  client_id text
)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  found text;
begin
  if agent_name.client_id is null
    or agent_name.client_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  begin
    select nullif(left(btrim(regexp_replace(c.client_name, '\s+', ' ', 'g')), 80), '') into found
    from auth.oauth_clients c
    where c.id = agent_name.client_id::uuid;
  exception when undefined_table or insufficient_privilege then
    return null;
  end;
  return found;
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
    'agent', private.agent_name(c.agent_client_id),
    'body', c.body,
    'created_at', c.created_at,
    'edited_at', c.edited_at,
    'deleted_at', c.deleted_at,
    'file_version', c.file_version
  )
$function$;

CREATE OR REPLACE FUNCTION private.list_comments (
  project_id uuid,
  file_id    uuid    DEFAULT NULL::uuid,
  ask_agent  boolean DEFAULT false,
  since      bigint  DEFAULT NULL::bigint
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
begin
  if list_comments.since is not null and not coalesce(list_comments.ask_agent, false) then
    raise exception 'since works with ask_agent' using errcode = '22023';
  end if;
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
         and (list_comments.file_id is null or t.file_id = list_comments.file_id)
         and (not coalesce(list_comments.ask_agent, false) or (
           t.created_by = uid
           and t.ask_agent_revision is not null
           and t.resolved_at is null
           and (list_comments.since is null or t.ask_agent_revision > list_comments.since)
         ))),
      '[]'::jsonb
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.list_file_authors (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform private.require_user();
  if list_file_authors.project_id is null or private.project_role(list_file_authors.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'path', f.path,
          'version', f.version,
          'author', private.comment_person(v.author_id),
          'via_agent', v.agent_client_id is not null,
          'agent', private.agent_name(v.agent_client_id)
        )
        order by f.path
      )
      from public.project_files f
      left join public.file_versions v on v.file_id = f.id and v.version = f.version
      where f.project_id = list_file_authors.project_id
    ),
    '[]'::jsonb
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.reply_comment (
  thread_id    uuid,
  comment_id   uuid,
  body         text,
  file_version bigint DEFAULT NULL::bigint
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
  if reply_comment.file_version is not null and not exists (
    select 1 from public.file_versions v
    where v.project_id = p.id and v.file_id = t.file_id and v.version = reply_comment.file_version
  ) then
    raise exception 'No such version of this file' using errcode = '22023';
  end if;
  if (select count(*) from public.comments cm where cm.project_id = p.id) >= 10000 then
    raise exception 'A project can hold at most 10000 comments' using errcode = '54000';
  end if;

  insert into public.comments (id, thread_id, project_id, author_id, agent_client_id, body, file_version)
  values (
    reply_comment.comment_id, t.id, p.id, uid, nullif((select auth.jwt()) ->> 'client_id', ''), reply_comment.body,
    reply_comment.file_version
  )
  on conflict (id) do nothing
  returning * into c;
  if c.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  if t.created_by = uid and t.ask_agent_revision is not null and not private.is_oauth_client() then
    update public.comment_threads ct set ask_agent_revision = new_revision where ct.id = t.id;
  end if;
  return jsonb_build_object('revision', new_revision, 'comment', private.comment_json(c));
end;
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
  -- The agent saving, from its token; null in the app.
  agent_client text := nullif((select auth.jwt()) ->> 'client_id', '');
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
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, agent_client, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'delete' then
      delete from public.project_files f
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta - octet_length(saved_file.content);
      insert into public.file_versions (file_id, version, project_id, path, content, deleted, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, null, true, uid, agent_client, save_files.mutation_id);
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
      insert into public.file_versions (file_id, version, project_id, path, content, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, uid, agent_client, save_files.mutation_id);
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

CREATE OR REPLACE FUNCTION private.set_comment_ask_agent (
  thread_id uuid,
  ask       boolean
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
    raise exception 'Only a signed-in person can ask an agent' using errcode = '42501';
  end if;
  if set_comment_ask_agent.thread_id is null or set_comment_ask_agent.ask is null then
    raise exception 'Thread id and ask are required' using errcode = '22023';
  end if;

  p := private.lock_project_for_comment(
    private.comment_project((select ct.project_id from public.comment_threads ct where ct.id = set_comment_ask_agent.thread_id))
  );
  select * into t from public.comment_threads ct where ct.id = set_comment_ask_agent.thread_id and ct.project_id = p.id;
  if t.id is null then
    raise exception 'Comment unavailable' using errcode = '42501';
  end if;
  if t.created_by is distinct from uid then
    raise exception 'Only the person who started a thread can ask an agent about it' using errcode = '42501';
  end if;
  if (t.ask_agent_revision is not null) = set_comment_ask_agent.ask then
    return jsonb_build_object('revision', p.revision, 'thread', private.thread_json(t));
  end if;

  update public.projects set revision = revision + 1, updated_at = now()
  where id = p.id
  returning revision into new_revision;
  update public.comment_threads ct
  set ask_agent_revision = case when set_comment_ask_agent.ask then new_revision end
  where ct.id = t.id
  returning * into t;
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
    'ask_agent', t.ask_agent_revision is not null,
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
  body         text,
  ask_agent    boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.add_comment(project_id, thread_id, file_id, file_version, anchor, body, ask_agent)
$function$;

REVOKE ALL ON FUNCTION "public"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text, boolean) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_comments (
  project_id uuid,
  file_id    uuid    DEFAULT NULL::uuid,
  ask_agent  boolean DEFAULT false,
  since      bigint  DEFAULT NULL::bigint
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_comments(project_id, file_id, ask_agent, since)
$function$;

REVOKE ALL ON FUNCTION "public"."list_comments"(uuid, uuid, boolean, bigint) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_file_authors (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_file_authors(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."list_file_authors"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.reply_comment (
  thread_id    uuid,
  comment_id   uuid,
  body         text,
  file_version bigint DEFAULT NULL::bigint
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.reply_comment(thread_id, comment_id, body, file_version)
$function$;

REVOKE ALL ON FUNCTION "public"."reply_comment"(uuid, uuid, text, bigint) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.set_comment_ask_agent (
  thread_id uuid,
  ask       boolean
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.set_comment_ask_agent(thread_id, ask)
$function$;

REVOKE ALL ON FUNCTION "public"."set_comment_ask_agent"(uuid, boolean) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."comments"
  ADD CONSTRAINT "comments_file_version_positive" CHECK (((file_version IS NULL) OR (file_version > 0)));

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_agent_client_id_length" CHECK (((agent_client_id IS NULL) OR (char_length(agent_client_id) <= 255)));

REVOKE ALL ON FUNCTION "private"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."agent_name"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."agent_name"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."list_comments"(uuid, uuid, boolean, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_comments"(uuid, uuid, boolean, bigint) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."list_file_authors"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_file_authors"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."reply_comment"(uuid, uuid, text, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."reply_comment"(uuid, uuid, text, bigint) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_comment_ask_agent"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_comment_ask_agent"(uuid, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."add_comment"(uuid, uuid, uuid, bigint, jsonb, text, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_comments"(uuid, uuid, boolean, bigint) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_file_authors"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."reply_comment"(uuid, uuid, text, bigint) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."set_comment_ask_agent"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ("file_version") ON TABLE "public"."comments" FROM "authenticated";

GRANT SELECT ("file_version") ON TABLE "public"."comments" TO "authenticated";

REVOKE ALL ("author_id") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("author_id") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("content") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("content") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("created_at") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("created_at") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("deleted") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("deleted") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("file_id") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("file_id") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("mutation_id") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("mutation_id") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("path") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("path") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("project_id") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("project_id") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("version") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("version") ON TABLE "public"."file_versions" TO "authenticated";
