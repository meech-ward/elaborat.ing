SET local check_function_bodies = off;

ALTER TABLE "public"."image_assets"
  DROP CONSTRAINT "image_assets_preview_byte_length_check";

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

ALTER TABLE "public"."image_assets"
  ADD CONSTRAINT "image_assets_preview_byte_length_check" CHECK (((preview_byte_length >= 1) AND (preview_byte_length <= 32768)));
