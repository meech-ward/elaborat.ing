-- Save a batch of file changes atomically.
--
-- `changes` is a JSON array of 1 to 4096 changes, each touching a distinct path:
--   {"op": "put",    "path": "notes/a.md", "content": "...", "base_version": 3}
--   {"op": "put",    "path": "notes/new.md", "content": "..."}        -- create: no base_version
--   {"op": "delete", "path": "notes/old.md", "base_version": 2}
--   {"op": "move",   "path": "notes/a.md", "to": "archive/a.md", "base_version": 4}
--   {"op": "move",   "path": "a.md", "to": "b.md", "content": "...", "base_version": 5}  -- move and edit
--   {"op": "mkdir",  "path": "empty/folder"}
--   {"op": "rmdir",  "path": "empty/folder"}
--
-- Every change to an existing file names the version it was based on: the
-- version the client last read. If any of them is stale, nothing is written
-- and the result lists every conflict with the file's current state.
-- Otherwise every change is applied, the project revision goes up by one, and
-- every changed file takes that revision as its new version. The result is
-- stored under `mutation_id`: repeating the same save returns that stored
-- result, and reusing the id for a different save is an error. Conflicts are
-- not stored, so a client resolves them and saves again with a new mutation id.
--
-- Errors: 22023 for a malformed request, 23505 when a path is already used by
-- a file or folder, 42501 without editor access, 55000 when the project is
-- archived, 54000 when the project would exceed its size limits, PT429 when
-- the caller has saved too often this minute (limits.sql). Every call counts,
-- retries included.
create function private.save_files(project_id uuid, mutation_id uuid, changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.save_files(uuid, uuid, jsonb) from public, anon;
grant execute on function private.save_files(uuid, uuid, jsonb) to authenticated;

create function public.save_files(project_id uuid, mutation_id uuid, changes jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.save_files(project_id, mutation_id, changes)
$$;

revoke all on function public.save_files(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_files(uuid, uuid, jsonb) to authenticated;
