SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.read_image_upload (
  project_id uuid,
  asset_id   uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare uid uuid := private.require_user(); a public.image_assets;
begin
  if private.project_role(read_image_upload.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  select * into a from public.image_assets i where i.id = read_image_upload.asset_id
    and i.project_id = read_image_upload.project_id and i.created_by = uid
    and (i.state = 'committed' or (i.state = 'ready' and i.expires_at > now()));
  if a.id is null then return null; end if;
  return jsonb_build_object('id', a.id, 'media_type', a.media_type,
    'byte_length', a.byte_length, 'width', a.width, 'height', a.height, 'sha256', a.sha256,
    'object_key', a.object_key, 'preview_key', a.preview_key, 'preview_type', a.preview_type, 'preview_byte_length', a.preview_byte_length);
end;
$function$;

CREATE OR REPLACE FUNCTION public.read_image_upload (
  project_id uuid,
  asset_id   uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.read_image_upload(project_id, asset_id)
$function$;

REVOKE ALL ON FUNCTION "public"."read_image_upload"(uuid, uuid) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."read_image_upload"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."read_image_upload"(uuid, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."read_image_upload"(uuid, uuid) TO "authenticated", "postgres";
