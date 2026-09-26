SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.list_members (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  caller_role text;
begin
  perform private.require_user();
  caller_role := private.project_role(list_members.project_id);
  if caller_role is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'user_id', x.user_id,
          'email', x.email,
          'role', x.role,
          'invited_at', x.invited_at,
          'accepted_at', x.accepted_at
        )
        order by x.rank, x.invited_at, x.email
      ),
      '[]'::jsonb
    )
    from (
      select p.owner_id as user_id, u.email::text as email, 'owner' as role,
        null::timestamptz as invited_at, null::timestamptz as accepted_at, 0 as rank
      from public.projects p
      join auth.users u on u.id = p.owner_id
      where p.id = list_members.project_id
      union all
      select m.user_id, u.email::text, m.role, m.created_at, m.accepted_at,
        case when m.accepted_at is null then 2 else 1 end
      from public.project_members m
      join auth.users u on u.id = m.user_id
      where m.project_id = list_members.project_id
        and (m.accepted_at is not null or caller_role = 'owner')
    ) x
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_members (
  project_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select private.list_members(project_id)
$function$;

REVOKE ALL ON FUNCTION "public"."list_members"(uuid) FROM PUBLIC, "anon", "service_role";

REVOKE ALL ON FUNCTION "private"."list_members"(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."list_members"(uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_members"(uuid) TO "authenticated", "postgres";
