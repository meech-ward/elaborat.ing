-- Immutable, private image bytes. Only the images Edge Function writes objects
-- or marks a reservation ready; clients commit those ready references through
-- save_files. Reserved and retained bytes are charged to the project owner.
create table public.image_assets (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif')),
  byte_length integer not null check (byte_length between 1 and 5242880),
  width integer not null check (width between 1 and 8000000),
  height integer not null check (height between 1 and 8000000),
  state text not null default 'reserved' check (state in ('reserved', 'ready', 'committed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  committed_at timestamptz,
  preview_key text not null,
  preview_type text not null check (preview_type in ('image/png', 'image/jpeg', 'image/webp')),
  preview_byte_length integer not null check (preview_byte_length between 1 and 32768),
  unique (project_id, id),
  constraint image_assets_pixels check (width::bigint * height::bigint <= 8000000),
  constraint image_assets_key check (object_key = project_id::text || '/' || id::text || '/original' and preview_key = project_id::text || '/' || id::text || '/preview'),
  constraint image_assets_commit check ((state = 'committed') = (committed_at is not null))
);
create index image_assets_project_id_idx on public.image_assets(project_id);
create index image_assets_created_by_idx on public.image_assets(created_by);
create index image_assets_staging_idx on public.image_assets(expires_at) where committed_at is null;
alter table public.image_assets enable row level security;
revoke all on table public.image_assets from anon, authenticated;
-- Metadata is exposed only as verified file snapshots, never reservations.
create policy "Project members read committed images and their own drafts"
  on public.image_assets for select to authenticated
  using (project_id in (select private.readable_project_ids())
    and (state = 'committed' or (created_by = (select auth.uid()) and expires_at > now())));

-- The predicate is hidden so Storage need not receive access to private tables.
create function private.can_read_image_object(object_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.image_assets a
    where (a.object_key = can_read_image_object.object_key or a.preview_key = can_read_image_object.object_key)
      and a.project_id in (select private.readable_project_ids())
      and (a.state = 'committed' or (a.state = 'ready' and a.created_by = (select auth.uid()) and a.expires_at > now())))
$$;
revoke all on function private.can_read_image_object(text) from public, anon;
grant execute on function private.can_read_image_object(text) to authenticated;
create policy "Members download immutable project images"
  on storage.objects for select to authenticated
  using (bucket_id = 'project-images' and private.can_read_image_object(name));
-- There is intentionally no client INSERT, UPDATE or DELETE policy. The
-- authenticated image endpoint validates bytes, then uses the Storage API.

create function private.reserve_image_asset(project_id uuid, asset_id uuid, sha256 text, media_type text, byte_length integer, width integer, height integer, preview_type text, preview_byte_length integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function private.reserve_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) from public, anon;
grant execute on function private.reserve_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) to authenticated;
create function public.reserve_image_asset(project_id uuid, asset_id uuid, sha256 text, media_type text, byte_length integer, width integer, height integer, preview_type text, preview_byte_length integer)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.reserve_image_asset(project_id, asset_id, sha256, media_type, byte_length, width, height, preview_type, preview_byte_length)
$$;
revoke all on function public.reserve_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) from public, anon;
grant execute on function public.reserve_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) to authenticated;

-- Service-only completion receives the validator's exact metadata. No value
-- supplied by a browser can mark an upload ready.
create function public.complete_image_asset(asset_id uuid, user_id uuid, sha256 text, media_type text, byte_length integer, width integer, height integer, preview_type text, preview_byte_length integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function public.complete_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.complete_image_asset(uuid, uuid, text, text, integer, integer, integer, text, integer) to service_role;

-- Resolve paths at a saved project revision, considering each file's latest
-- state at that revision before comparing its path. A later replacement or
-- rename can therefore never change an old note's image.
create function public.read_image_at_revision(project_id uuid, path text, revision bigint)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select a.asset from (
    select distinct on (v.file_id) v.path, v.asset_id, v.asset, v.deleted
    from public.file_versions v where v.project_id = read_image_at_revision.project_id
      and v.version <= read_image_at_revision.revision order by v.file_id, v.version desc
  ) a
  where a.path = read_image_at_revision.path and not a.deleted and a.asset is not null
    and read_image_at_revision.revision > 0
    and read_image_at_revision.revision <= (select p.revision from public.projects p where p.id = read_image_at_revision.project_id)
$$;
revoke all on function public.read_image_at_revision(uuid, text, bigint) from public, anon;
grant execute on function public.read_image_at_revision(uuid, text, bigint) to authenticated;

-- Storage removal must survive the database cascade and an interrupted HTTP
-- request. This queue holds immutable keys until Storage confirms deletion.
create table private.image_object_deletions (
  object_key text primary key,
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts integer not null default 0
);
alter table private.image_object_deletions enable row level security;
revoke all on table private.image_object_deletions from public, anon, authenticated;
create function private.queue_project_image_deletion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.image_object_deletions(object_key)
    select k.object_key from public.image_assets a cross join lateral (values (a.object_key), (a.preview_key)) k(object_key) where a.project_id = old.id on conflict do nothing;
  return old;
end;
$$;
revoke all on function private.queue_project_image_deletion() from public, anon, authenticated;
create trigger queue_project_image_deletion before delete on public.projects
  for each row execute function private.queue_project_image_deletion();

create function public.claim_image_cleanup()
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function public.claim_image_cleanup() from public, anon, authenticated;
grant execute on function public.claim_image_cleanup() to service_role;
create function public.finish_image_cleanup(object_keys text[])
returns void language sql security definer set search_path = '' as $$
  delete from private.image_object_deletions d where d.object_key = any(finish_image_cleanup.object_keys)
$$;
revoke all on function public.finish_image_cleanup(text[]) from public, anon, authenticated;
grant execute on function public.finish_image_cleanup(text[]) to service_role;

create function private.check_image_upload(project_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_project_for_edit(check_image_upload.project_id);
  perform private.check_limit('image_uploads_per_minute');
end;
$$;
revoke all on function private.check_image_upload(uuid) from public, anon;
grant execute on function private.check_image_upload(uuid) to authenticated;
create function public.check_image_upload(project_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.check_image_upload(project_id)
$$;
revoke all on function public.check_image_upload(uuid) from public, anon;
grant execute on function public.check_image_upload(uuid) to authenticated;

create function private.wake_image_cleanup()
returns void language plpgsql security definer set search_path = '' as $$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  secret_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'embed_secret_key');
begin
  if project_url is null or secret_key is null then return; end if;
  perform net.http_post(url => project_url || '/functions/v1/images?cleanup=1',
    headers => jsonb_build_object('Content-Type', 'application/json', 'apikey', secret_key),
    body => '{}'::jsonb, timeout_milliseconds => 30000);
end;
$$;
revoke all on function private.wake_image_cleanup() from public, anon, authenticated;
select cron.schedule('cleanup-project-images', '0 * * * *', $$select private.wake_image_cleanup()$$);

-- Lost answers retain their immutable identity when the save already committed.
-- Status reads serialize with save_files before declaring an identity expired
-- or missing; a browser can then safely replace an uncommitted pending batch.
create function private.read_image_upload(project_id uuid, asset_id uuid, include_status boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;
revoke all on function private.read_image_upload(uuid, uuid, boolean) from public, anon;
grant execute on function private.read_image_upload(uuid, uuid, boolean) to authenticated;
create function public.read_image_upload(project_id uuid, asset_id uuid, include_status boolean default false)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.read_image_upload(project_id, asset_id, include_status)
$$;
revoke all on function public.read_image_upload(uuid, uuid, boolean) from public, anon;
grant execute on function public.read_image_upload(uuid, uuid, boolean) to authenticated;
