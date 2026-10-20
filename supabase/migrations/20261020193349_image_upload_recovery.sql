SET local check_function_bodies = off;

DROP FUNCTION "private"."read_image_upload"(uuid, uuid);

DROP FUNCTION "public"."read_image_upload"(uuid, uuid);

CREATE OR REPLACE FUNCTION private.read_image_upload (
  project_id     uuid,
  asset_id       uuid,
  include_status boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.require_user(); a public.image_assets; snapshot jsonb;
begin
  if private.project_role(read_image_upload.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  perform 1 from public.projects p where p.id = read_image_upload.project_id for update;
  if private.project_role(read_image_upload.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  select * into a from public.image_assets i where i.id = read_image_upload.asset_id
    and i.project_id = read_image_upload.project_id
    and (i.state = 'committed' or i.created_by = uid);
  if a.id is null then
    return case when include_status then jsonb_build_object('status', 'missing') else null end;
  end if;
  if a.state <> 'committed' and a.expires_at <= now() then
    return case when include_status then jsonb_build_object('status', 'expired') else null end;
  end if;
  if a.state = 'reserved' then
    return case when include_status then jsonb_build_object('status', 'pending') else null end;
  end if;
  snapshot := jsonb_build_object('id', a.id, 'media_type', a.media_type,
    'byte_length', a.byte_length, 'width', a.width, 'height', a.height, 'sha256', a.sha256,
    'object_key', a.object_key, 'preview_key', a.preview_key, 'preview_type', a.preview_type, 'preview_byte_length', a.preview_byte_length);
  return case when include_status then jsonb_build_object('status', 'available', 'asset', snapshot) else snapshot end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.reserve_image_asset (
  project_id          uuid,
  asset_id            uuid,
  sha256              text,
  media_type          text,
  byte_length         integer,
  width               integer,
  height              integer,
  preview_type        text,
  preview_byte_length integer
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects := private.lock_project_for_edit(reserve_image_asset.project_id);
  a public.image_assets;
begin
  if reserve_image_asset.asset_id is null or reserve_image_asset.sha256 is null
    or reserve_image_asset.sha256 !~ '^[a-f0-9]{64}$'
    or reserve_image_asset.media_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif')
    or reserve_image_asset.byte_length is null or reserve_image_asset.byte_length not between 1 and 5242880
    or reserve_image_asset.width is null or reserve_image_asset.width <= 0
    or reserve_image_asset.height is null or reserve_image_asset.height <= 0
    or reserve_image_asset.preview_type is null or reserve_image_asset.preview_type not in ('image/png', 'image/jpeg', 'image/webp')
    or reserve_image_asset.preview_byte_length is null or reserve_image_asset.preview_byte_length not between 1 and 32768
    or reserve_image_asset.width::bigint * reserve_image_asset.height::bigint > 8000000 then
    raise exception 'Invalid image metadata' using errcode = '22023';
  end if;
  -- Locks serialize reservations across all projects charged to this owner.
  perform 1 from auth.users u where u.id = p.owner_id for update;
  select * into a from public.image_assets i where i.id = reserve_image_asset.asset_id for update;
  if a.id is not null then
    if a.project_id <> p.id or a.created_by is distinct from uid
      or a.sha256 <> reserve_image_asset.sha256 or a.media_type <> reserve_image_asset.media_type
      or a.byte_length <> reserve_image_asset.byte_length or a.width <> reserve_image_asset.width or a.height <> reserve_image_asset.height
      or a.preview_type <> reserve_image_asset.preview_type or a.preview_byte_length <> reserve_image_asset.preview_byte_length then
      raise exception 'This image id was already used for another upload' using errcode = '22023';
    end if;
    if a.state <> 'committed' and a.expires_at <= now() then
      raise exception 'This image upload expired. Try again with a new image id.' using errcode = 'PT410';
    end if;
    return to_jsonb(a);
  end if;
  -- Never recreate keys that a cleanup worker may already be deleting.
  if exists (select 1 from private.image_object_deletions d where d.object_key in
    (p.id::text || '/' || reserve_image_asset.asset_id::text || '/original', p.id::text || '/' || reserve_image_asset.asset_id::text || '/preview')) then
    raise exception 'This image upload expired. Try again with a new image id.' using errcode = 'PT410';
  end if;
  if (select count(*) from public.image_assets i where i.created_by = uid and i.state <> 'committed') >= 20 then
    raise exception 'Finish or discard existing image uploads before adding more' using errcode = 'PT429';
  end if;
  if (select coalesce(sum(i.byte_length + i.preview_byte_length), 0) from public.image_assets i
    join public.projects q on q.id = i.project_id where q.owner_id = p.owner_id) + reserve_image_asset.byte_length + reserve_image_asset.preview_byte_length > 268435456 then
    raise exception 'The project owner has reached the 256 MiB image limit, including image history and pending uploads' using errcode = '54000';
  end if;
  insert into public.image_assets(id, project_id, object_key, sha256, media_type, byte_length, width, height, created_by, preview_key, preview_type, preview_byte_length)
  values (reserve_image_asset.asset_id, p.id, p.id::text || '/' || reserve_image_asset.asset_id::text || '/original',
    reserve_image_asset.sha256, reserve_image_asset.media_type, reserve_image_asset.byte_length,
    reserve_image_asset.width, reserve_image_asset.height, uid,
    p.id::text || '/' || reserve_image_asset.asset_id::text || '/preview', reserve_image_asset.preview_type, reserve_image_asset.preview_byte_length) returning * into a;
  return to_jsonb(a);
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
  image public.image_assets;
  image_snapshot jsonb;
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
    if op is null or op not in ('put', 'asset', 'delete', 'move', 'mkdir', 'rmdir') then
      raise exception 'Unknown change op: %', left(coalesce(op, '(missing)'), 50) using errcode = '22023';
    end if;
    if not private.is_valid_path(change_path) then
      raise exception 'Invalid path: %', left(coalesce(change_path, '(missing)'), 200) using errcode = '22023';
    end if;
    if change_path = any (touched) then
      raise exception 'A save can change each path only once: %', change_path using errcode = '22023';
    end if;
    touched := touched || change_path;

    if op in ('put', 'asset', 'delete', 'move') and coalesce(jsonb_typeof(change -> 'base_version'), 'null') <> 'null' then
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

    if op in ('put', 'asset', 'delete', 'move') then
      select * into current_file
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      if (base_version is null and current_file.id is not null)
        or (base_version is not null and current_file.version is distinct from base_version) then
        conflict_list := conflict_list || jsonb_build_object(
          'path', change_path,
          'base_version', base_version,
          'current', case when current_file.id is null then null else jsonb_build_object(
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content, 'kind', current_file.kind, 'asset_id', current_file.asset_id, 'asset', current_file.asset) end
        );
      end if;
    end if;

    if (op = 'put' or (op = 'move' and change ? 'content')) and current_file.kind = 'image' then
      raise exception 'Image files need an explicit image operation: %', change_path using errcode = '22023';
    end if;
    if op = 'asset' or (op = 'move' and change ? 'asset_id') then
      if op = 'move' and change ? 'content' then
        raise exception 'A move can carry text or an image reference, not both' using errcode = '22023';
      end if;
      if jsonb_typeof(change -> 'asset_id') is distinct from 'string' or (change ->> 'asset_id') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
        raise exception 'asset needs an image id' using errcode = '22023';
      end if;
      select * into image from public.image_assets a where a.id = (change ->> 'asset_id')::uuid for update;
      if image.project_id = p.id and image.created_by = uid and image.state <> 'committed' and image.expires_at <= now() then
        raise exception 'This image upload expired. Try again with a new image id.' using errcode = 'PT410';
      end if;
      if image.id is null or image.project_id <> p.id
        or (image.state <> 'committed' and (image.state <> 'ready' or image.created_by is distinct from uid or image.expires_at <= now())) then
        raise exception 'Image is not ready in this project' using errcode = '42501';
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
            'id', current_file.id, 'version', current_file.version, 'content', current_file.content, 'kind', current_file.kind, 'asset_id', current_file.asset_id, 'asset', current_file.asset)
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

    if op in ('put', 'asset') then
      image_snapshot := null;
      if op = 'asset' then
        select * into image from public.image_assets a where a.id = (change ->> 'asset_id')::uuid;
        image_snapshot := jsonb_build_object('id', image.id, 'media_type', image.media_type,
          'byte_length', image.byte_length, 'width', image.width, 'height', image.height, 'sha256', image.sha256,
          'object_key', image.object_key, 'preview_key', image.preview_key, 'preview_type', image.preview_type, 'preview_byte_length', image.preview_byte_length);
        update public.image_assets a set state = 'committed', committed_at = coalesce(a.committed_at, now()) where a.id = image.id;
      end if;
      select case when f.kind = 'image' then (f.asset ->> 'byte_length')::bigint else octet_length(f.content) end into old_bytes
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      insert into public.project_files as f (project_id, path, content, kind, asset_id, asset, version, updated_by)
      values (p.id, change_path, case when op = 'asset' then '' else change ->> 'content' end,
        case when op = 'asset' then 'image' else 'text' end, case when op = 'asset' then image.id else null end, image_snapshot, new_revision, uid)
      on conflict on constraint project_files_project_path_key do update
        set content = excluded.content,
            kind = excluded.kind, asset_id = excluded.asset_id, asset = excluded.asset,
            version = excluded.version,
            updated_by = excluded.updated_by,
            updated_at = now()
      returning * into saved_file;
      byte_delta := byte_delta + case when saved_file.kind = 'image' then (saved_file.asset ->> 'byte_length')::bigint else octet_length(saved_file.content) end - coalesce(old_bytes, 0);
      if old_bytes is null then
        added_file_paths := added_file_paths || change_path;
        added_paths := added_paths || change_path;
      end if;
      insert into public.file_versions (file_id, version, project_id, path, content, kind, asset_id, asset, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, saved_file.kind, saved_file.asset_id, saved_file.asset, uid, agent_client, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'delete' then
      delete from public.project_files f
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta - case when saved_file.kind = 'image' then (saved_file.asset ->> 'byte_length')::bigint else octet_length(saved_file.content) end;
      insert into public.file_versions (file_id, version, project_id, path, content, kind, asset_id, asset, deleted, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, null, saved_file.kind, saved_file.asset_id, saved_file.asset, true, uid, agent_client, save_files.mutation_id);
      applied := applied || jsonb_build_object(
        'op', op, 'path', change_path, 'id', saved_file.id, 'version', new_revision);

    elsif op = 'move' then
      image_snapshot := null;
      if change ? 'asset_id' then
        select * into image from public.image_assets a where a.id = (change ->> 'asset_id')::uuid;
        image_snapshot := jsonb_build_object('id', image.id, 'media_type', image.media_type,
          'byte_length', image.byte_length, 'width', image.width, 'height', image.height, 'sha256', image.sha256,
          'object_key', image.object_key, 'preview_key', image.preview_key, 'preview_type', image.preview_type, 'preview_byte_length', image.preview_byte_length);
        update public.image_assets a set state = 'committed', committed_at = coalesce(a.committed_at, now()) where a.id = image.id;
      end if;
      target_path := change ->> 'to';
      select case when f.kind = 'image' then (f.asset ->> 'byte_length')::bigint else octet_length(f.content) end into old_bytes
      from public.project_files f
      where f.project_id = p.id and f.path = change_path;
      -- A move may also carry new content, so moving a file and rewriting
      -- its own content (for example a self-reference) is one change.
      update public.project_files f
      set path = target_path,
          content = case when image_snapshot is not null then '' else coalesce(change ->> 'content', f.content) end,
          kind = case when image_snapshot is not null then 'image' else f.kind end,
          asset_id = case when image_snapshot is not null then image.id else f.asset_id end,
          asset = coalesce(image_snapshot, f.asset),
          version = new_revision,
          updated_by = uid,
          updated_at = now()
      where f.project_id = p.id and f.path = change_path
      returning * into saved_file;
      byte_delta := byte_delta + case when saved_file.kind = 'image' then (saved_file.asset ->> 'byte_length')::bigint else octet_length(saved_file.content) end - old_bytes;
      added_file_paths := added_file_paths || target_path;
      added_paths := added_paths || target_path;
      insert into public.file_versions (file_id, version, project_id, path, content, kind, asset_id, asset, author_id, agent_client_id, mutation_id)
      values (saved_file.id, new_revision, p.id, saved_file.path, saved_file.content, saved_file.kind, saved_file.asset_id, saved_file.asset, uid, agent_client, save_files.mutation_id);
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

CREATE OR REPLACE FUNCTION public.complete_image_asset (
  asset_id            uuid,
  user_id             uuid,
  sha256              text,
  media_type          text,
  byte_length         integer,
  width               integer,
  height              integer,
  preview_type        text,
  preview_byte_length integer
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare a public.image_assets; p public.projects;
begin
  select * into a from public.image_assets i where i.id = complete_image_asset.asset_id for update;
  select * into p from public.projects q where q.id = a.project_id;
  if a.id is null or a.created_by is distinct from complete_image_asset.user_id
    or a.sha256 is distinct from complete_image_asset.sha256 or a.media_type is distinct from complete_image_asset.media_type
    or a.byte_length is distinct from complete_image_asset.byte_length or a.width is distinct from complete_image_asset.width
    or a.height is distinct from complete_image_asset.height
    or a.preview_type is distinct from complete_image_asset.preview_type
    or a.preview_byte_length is distinct from complete_image_asset.preview_byte_length
    or p.archived_at is not null
    or not (p.owner_id = complete_image_asset.user_id or exists (select 1 from public.project_members m
      where m.project_id = p.id and m.user_id = complete_image_asset.user_id and m.role = 'editor' and m.accepted_at is not null)) then
    raise exception 'Image upload is no longer available' using errcode = '42501';
  end if;
  if a.state <> 'committed' and a.expires_at <= now() then
    raise exception 'This image upload expired. Try again with a new image id.' using errcode = 'PT410';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'project-images' and o.name = a.object_key)
    or not exists (select 1 from storage.objects o where o.bucket_id = 'project-images' and o.name = a.preview_key) then
    raise exception 'Image upload is missing' using errcode = '55000';
  end if;
  update public.image_assets i set state = case when i.state = 'committed' then 'committed' else 'ready' end
    where i.id = a.id returning * into a;
  return to_jsonb(a);
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_image_upload (
  project_id     uuid,
  asset_id       uuid,
  include_status boolean DEFAULT false
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.read_image_upload(project_id, asset_id, include_status)
$function$;

REVOKE ALL ON FUNCTION "public"."read_image_upload"(uuid, uuid, boolean) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."read_image_upload"(uuid, uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."read_image_upload"(uuid, uuid, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."read_image_upload"(uuid, uuid, boolean) TO "authenticated", "postgres";
