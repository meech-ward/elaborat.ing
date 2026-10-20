SET local check_function_bodies = off;

CREATE TABLE "private"."image_object_deletions" (
  "object_key" text                     NOT NULL,
  "queued_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "claimed_at" timestamp with time zone,
  "attempts"   integer                  NOT NULL DEFAULT 0,
  CONSTRAINT "image_object_deletions_pkey" PRIMARY KEY (object_key)
);

ALTER TABLE "private"."image_object_deletions"
  ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."image_assets" (
  "id"                  uuid                     NOT NULL,
  "project_id"          uuid                     NOT NULL,
  "object_key"          text                     NOT NULL,
  "sha256"              text                     NOT NULL,
  "media_type"          text                     NOT NULL,
  "byte_length"         integer                  NOT NULL,
  "width"               integer                  NOT NULL,
  "height"              integer                  NOT NULL,
  "state"               text                     NOT NULL DEFAULT 'reserved'::text,
  "created_by"          uuid,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"          timestamp with time zone NOT NULL DEFAULT (now() + '01:00:00'::interval),
  "committed_at"        timestamp with time zone,
  "preview_key"         text                     NOT NULL,
  "preview_type"        text                     NOT NULL,
  "preview_byte_length" integer                  NOT NULL,
  CONSTRAINT "image_assets_byte_length_check" CHECK (((byte_length >= 1) AND (byte_length <= 5242880))),
  CONSTRAINT "image_assets_commit" CHECK (((state = 'committed'::text) = (committed_at IS NOT NULL))),
  CONSTRAINT "image_assets_height_check" CHECK (((height >= 1) AND (height <= 8000000))),
  CONSTRAINT "image_assets_key"
    CHECK
    (((object_key = ((((project_id)::text || '/'::text) || (id)::text) || '/original'::text)) AND (preview_key = ((((project_id)::text || '/'::text) || (id)::text) ||
    '/preview'::text)))),
  CONSTRAINT "image_assets_media_type_check" CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
  CONSTRAINT "image_assets_object_key_key" UNIQUE (object_key),
  CONSTRAINT "image_assets_pixels" CHECK ((((width)::bigint * (height)::bigint) <= 8000000)),
  CONSTRAINT "image_assets_pkey" PRIMARY KEY (id),
  CONSTRAINT "image_assets_preview_byte_length_check" CHECK (((preview_byte_length >= 1) AND (preview_byte_length <= 524288))),
  CONSTRAINT "image_assets_preview_type_check" CHECK ((preview_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
  CONSTRAINT "image_assets_project_id_id_key" UNIQUE (project_id, id),
  CONSTRAINT "image_assets_sha256_check" CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
  CONSTRAINT "image_assets_state_check" CHECK ((state = ANY (ARRAY['reserved'::text, 'ready'::text, 'committed'::text]))),
  CONSTRAINT "image_assets_width_check" CHECK (((width >= 1) AND (width <= 8000000)))
);

ALTER TABLE "public"."image_assets"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."image_assets" FROM "anon", "authenticated";

ALTER TABLE "public"."file_versions"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'text'::text;

ALTER TABLE "public"."file_versions"
  ADD COLUMN "asset_id" uuid;

ALTER TABLE "public"."file_versions"
  ADD COLUMN "asset" jsonb;

ALTER TABLE "public"."project_files"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'text'::text;

ALTER TABLE "public"."project_files"
  ADD COLUMN "asset_id" uuid;

ALTER TABLE "public"."project_files"
  ADD COLUMN "asset" jsonb;

CREATE OR REPLACE FUNCTION private.can_read_image_object (
  object_key text
)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  select exists (select 1 from public.image_assets a
    where (a.object_key = can_read_image_object.object_key or a.preview_key = can_read_image_object.object_key)
      and a.project_id in (select private.readable_project_ids())
      and (a.state = 'committed' or (a.state = 'ready' and a.created_by = (select auth.uid()) and a.expires_at > now())))
$function$;

CREATE OR REPLACE FUNCTION private.check_image_upload (
  project_id uuid
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  perform private.lock_project_for_edit(check_image_upload.project_id);
  perform private.check_limit('image_uploads_per_minute');
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
    'kind', v.kind, 'asset_id', v.asset_id, 'asset', v.asset,
    'content', case when coalesce(get_agent_change.previous_only, false) then null else v.content end,
    'previous', case when pv.file_id is not null then jsonb_build_object('version', pv.version, 'content', pv.content, 'kind', pv.kind, 'asset_id', pv.asset_id, 'asset', pv.asset) end
  );
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
    ('image_uploads_per_minute', 30, interval '1 minute', 'image uploads a minute'),
    ('searches_per_minute', 120, interval '1 minute', 'searches a minute'),
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute'),
    ('invitations_per_day', 50, interval '1 day', 'invitations a day'),
    ('comment_writes_per_minute', 120, interval '1 minute', 'comment changes a minute'),
    ('account_deletions_per_day', 5, interval '1 day', 'account deletion attempts a day')
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
           'kind', v.kind, 'asset_id', v.asset_id, 'asset', v.asset,
           'size', case when v.kind = 'image' then (v.asset ->> 'byte_length')::bigint else octet_length(v.content) end,
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
               'kind', pv.kind, 'asset_id', pv.asset_id, 'asset', pv.asset,
               'size', case when pv.kind = 'image' then (pv.asset ->> 'byte_length')::bigint else octet_length(pv.content) end,
               'same_content', pv.content is not distinct from v.content and pv.asset_id is not distinct from v.asset_id
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

CREATE OR REPLACE FUNCTION private.queue_file_passages()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  if (new.kind = 'text' and private.is_searchable_path(new.path))
    or (tg_op = 'UPDATE' and old.kind = 'text' and private.is_searchable_path(old.path)) then
    perform pgmq.send('file_passages', jsonb_build_object('fileId', new.id));
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION private.queue_project_image_deletion()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
begin
  insert into private.image_object_deletions(object_key)
    select k.object_key from public.image_assets a cross join lateral (values (a.object_key), (a.preview_key)) k(object_key) where a.project_id = old.id on conflict do nothing;
  return old;
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
    or reserve_image_asset.media_type not in ('image/png', 'image/jpeg', 'image/webp')
    or reserve_image_asset.byte_length is null or reserve_image_asset.byte_length not between 1 and 5242880
    or reserve_image_asset.width is null or reserve_image_asset.width <= 0
    or reserve_image_asset.height is null or reserve_image_asset.height <= 0
    or reserve_image_asset.preview_type is null or reserve_image_asset.preview_type not in ('image/png', 'image/jpeg', 'image/webp')
    or reserve_image_asset.preview_byte_length is null or reserve_image_asset.preview_byte_length not between 1 and 524288
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
      raise exception 'This image upload expired. Try again with a new image id.' using errcode = '55000';
    end if;
    return to_jsonb(a);
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
    if op = 'asset' then
      if jsonb_typeof(change -> 'asset_id') is distinct from 'string' or (change ->> 'asset_id') !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
        raise exception 'asset needs an image id' using errcode = '22023';
      end if;
      select * into image from public.image_assets a where a.id = (change ->> 'asset_id')::uuid for update;
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
      target_path := change ->> 'to';
      select case when f.kind = 'image' then (f.asset ->> 'byte_length')::bigint else octet_length(f.content) end into old_bytes
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

CREATE OR REPLACE FUNCTION private.transfer_project (
  project_id   uuid,
  new_owner_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  p public.projects;
  most integer;
begin
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can transfer a project' using errcode = '42501';
  end if;
  select * into p from public.projects where id = transfer_project.project_id for update;
  if p.id is null or p.owner_id <> uid then
    raise exception 'Only the project owner can transfer it' using errcode = '42501';
  end if;
  if transfer_project.new_owner_id is null or transfer_project.new_owner_id = uid then
    raise exception 'Invalid member' using errcode = '22023';
  end if;

  delete from public.project_members m
  where m.project_id = p.id
    and m.user_id = transfer_project.new_owner_id
    and m.accepted_at is not null;
  if not found then
    raise exception 'Only a member who has accepted their invitation can become the owner' using errcode = '22023';
  end if;

  select l.max_count into most from private.limits() l where l.name = 'projects';
  if (select count(*) from public.projects o where o.owner_id = transfer_project.new_owner_id) >= most then
    raise exception 'They have reached the limit of % projects, so cannot own another.', most
      using errcode = 'PT429', detail = 'projects';
  end if;

  -- Charge all retained originals and previews to the new owner atomically.
  -- Sorted account locks also serialize reservations in either account.
  perform 1 from auth.users u where u.id in (uid, transfer_project.new_owner_id) order by u.id for update;
  if (select coalesce(sum(a.byte_length + a.preview_byte_length), 0) from public.image_assets a join public.projects q on q.id = a.project_id
    where q.owner_id = transfer_project.new_owner_id or q.id = p.id) > 268435456 then
    raise exception 'They have reached the 256 MiB image limit, so cannot own this project' using errcode = '54000';
  end if;

  insert into public.project_members (project_id, user_id, role, accepted_at)
  values (p.id, uid, 'editor', now());
  update public.projects
  set owner_id = transfer_project.new_owner_id, revision = revision + 1, updated_at = now()
  where id = p.id
  returning * into p;
  return private.project_summary(p, 'editor');
end;
$function$;

CREATE OR REPLACE FUNCTION private.wake_image_cleanup()
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_secret_key');
begin
  if project_url is null or secret_key is null then return; end if;
  perform net.http_post(url => project_url || '/functions/v1/images?cleanup=1',
    headers => jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
    body => '{}'::jsonb, timeout_milliseconds => 30000);
end;
$function$;

CREATE OR REPLACE FUNCTION public.check_image_upload (
  project_id uuid
)
  RETURNS void
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.check_image_upload(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."check_image_upload"(uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.claim_image_cleanup()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare result jsonb;
begin
  -- The extra hour exceeds the bounded upload request lifetime. Ready and
  -- reserved objects that were never committed are safe to collect here.
  with expired as (
    delete from public.image_assets a where a.committed_at is null and a.expires_at < now() - interval '1 hour'
      and not exists (select 1 from public.project_files f where f.asset_id = a.id)
      and not exists (select 1 from public.file_versions v where v.asset_id = a.id)
      returning a.object_key, a.preview_key
  ) insert into private.image_object_deletions(object_key) select k.object_key from expired e cross join lateral (values (e.object_key), (e.preview_key)) k(object_key) on conflict do nothing;
  with batch as (
    select d.object_key from private.image_object_deletions d
    where d.claimed_at is null or d.claimed_at < now() - interval '5 minutes'
    order by d.queued_at for update skip locked limit 100
  ), claimed as (
    update private.image_object_deletions d set claimed_at = now(), attempts = d.attempts + 1
    from batch b where d.object_key = b.object_key returning d.object_key
  ) select coalesce(jsonb_agg(object_key), '[]'::jsonb) into result from claimed;
  return result;
end;
$function$;

REVOKE ALL ON FUNCTION "public"."claim_image_cleanup"() FROM PUBLIC, "anon", "authenticated";

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
    or a.preview_byte_length is distinct from complete_image_asset.preview_byte_length or (a.state <> 'committed' and a.expires_at <= now())
    or p.archived_at is not null
    or not (p.owner_id = complete_image_asset.user_id or exists (select 1 from public.project_members m
      where m.project_id = p.id and m.user_id = complete_image_asset.user_id and m.role = 'editor' and m.accepted_at is not null)) then
    raise exception 'Image upload is no longer available' using errcode = '42501';
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

REVOKE ALL ON FUNCTION "public"."complete_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.finish_image_cleanup (
  object_keys text[]
)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
  delete from private.image_object_deletions d where d.object_key = any(finish_image_cleanup.object_keys)
$function$;

REVOKE ALL ON FUNCTION "public"."finish_image_cleanup"(text[]) FROM PUBLIC, "anon", "authenticated";

CREATE OR REPLACE FUNCTION public.read_image_at_revision (
  project_id uuid,
  path       text,
  revision   bigint
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select a.asset from (
    select distinct on (v.file_id) v.path, v.asset_id, v.asset, v.deleted
    from public.file_versions v where v.project_id = read_image_at_revision.project_id
      and v.version <= read_image_at_revision.revision order by v.file_id, v.version desc
  ) a
  where a.path = read_image_at_revision.path and not a.deleted and a.asset is not null
    and read_image_at_revision.revision > 0
    and read_image_at_revision.revision <= (select p.revision from public.projects p where p.id = read_image_at_revision.project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."read_image_at_revision"(uuid, text, bigint) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.read_project (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.project_summary(p, private.project_role(p.id)) || jsonb_build_object(
    'folders', coalesce(
      (select jsonb_agg(d.path order by d.path) from public.project_folders d where d.project_id = p.id),
      '[]'::jsonb
    ),
    'files', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', f.id,
            'path', f.path,
            'content', f.content,
            'kind', f.kind,
            'asset_id', f.asset_id,
            'asset', f.asset,
            'version', f.version,
            'updated_at', f.updated_at
          )
          order by f.path
        )
        from public.project_files f
        where f.project_id = p.id
      ),
      '[]'::jsonb
    )
  )
  from public.projects p
  where p.id = read_project.project_id
$function$;

CREATE OR REPLACE FUNCTION public.reserve_image_asset (
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
  LANGUAGE sql
  SET search_path TO ''
  AS $function$
  select private.reserve_image_asset(project_id, asset_id, sha256, media_type, byte_length, width, height, preview_type, preview_byte_length)
$function$;

REVOKE ALL ON FUNCTION "public"."reserve_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_asset_payload" CHECK ((((kind = 'text'::text) AND (asset_id IS NULL) AND (asset IS NULL)) OR ((kind = 'image'::text) AND (asset_id IS
    NOT NULL) AND (asset IS NOT NULL) AND (deleted OR (content = ''::text)))));

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_kind_check" CHECK ((kind = ANY (ARRAY['text'::text, 'image'::text])));

ALTER TABLE "public"."image_assets"
  ADD CONSTRAINT "image_assets_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."image_assets"
  ADD CONSTRAINT "image_assets_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."file_versions"
  ADD CONSTRAINT "file_versions_project_id_asset_id_fkey" FOREIGN KEY (project_id, asset_id) REFERENCES public.image_assets(project_id, id);

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_asset_payload"
    CHECK ((((kind = 'text'::text) AND (asset_id IS NULL) AND (asset IS NULL)) OR ((kind = 'image'::text) AND (content = ''::text) AND (asset_id IS NOT NULL) AND (asset IS
    NOT NULL))));

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_kind_check" CHECK ((kind = ANY (ARRAY['text'::text, 'image'::text])));

ALTER TABLE "public"."project_files"
  ADD CONSTRAINT "project_files_project_id_asset_id_fkey" FOREIGN KEY (project_id, asset_id) REFERENCES public.image_assets(project_id, id);

CREATE INDEX image_assets_created_by_idx ON public.image_assets USING btree (created_by);

CREATE INDEX image_assets_project_id_idx ON public.image_assets USING btree (project_id);

CREATE INDEX image_assets_staging_idx ON public.image_assets USING btree (expires_at)
  WHERE (committed_at IS NULL);

CREATE TRIGGER queue_project_image_deletion
  BEFORE DELETE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION private.queue_project_image_deletion();

CREATE POLICY "Project members read committed images and their own drafts" ON "public"."image_assets"
  FOR SELECT
  TO "authenticated"
  USING
    (((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)) AND ((state = 'committed'::text) OR ((created_by = ( SELECT auth.uid() AS uid)) AND
    (expires_at > now())))));

CREATE POLICY "Members download immutable project images" ON "storage"."objects"
  FOR SELECT
  TO "authenticated"
  USING (((bucket_id = 'project-images'::text) AND private.can_read_image_object(name)));

REVOKE ALL ON FUNCTION "private"."can_read_image_object"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."can_read_image_object"(text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."check_image_upload"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."check_image_upload"(uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."queue_project_image_deletion"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."queue_project_image_deletion"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."reserve_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."reserve_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."wake_image_cleanup"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."wake_image_cleanup"() TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."check_image_upload"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."claim_image_cleanup"() TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."complete_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."finish_image_cleanup"(text[]) TO "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."read_image_at_revision"(uuid, text, bigint) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."reserve_image_asset"(uuid, uuid, text, text, integer, integer, integer, text, integer) TO "authenticated", "postgres";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "private"."image_object_deletions" TO "postgres";

REVOKE ALL ("asset_id") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("asset_id") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("asset") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("asset") ON TABLE "public"."file_versions" TO "authenticated";

REVOKE ALL ("kind") ON TABLE "public"."file_versions" FROM "authenticated";

GRANT SELECT ("kind") ON TABLE "public"."file_versions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."image_assets" TO "postgres";

REVOKE ALL ON TABLE "public"."image_assets" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."image_assets" TO "service_role";

SELECT cron.schedule_in_database('cleanup-project-images', '0 * * * *', 'select private.wake_image_cleanup()', 'postgres', NULL, true);
