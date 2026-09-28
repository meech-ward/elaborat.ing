SET local check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.comment_person (
  user_id uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'user_id', u.id,
    'email', u.email::text,
    'name', private.person_name(u.raw_user_meta_data, u.email::text)
  )
  from auth.users u
  where u.id = comment_person.user_id
$function$;

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
          'name', x.name,
          'role', x.role,
          'invited_at', x.invited_at,
          'accepted_at', x.accepted_at
        )
        order by x.rank, x.invited_at, x.email
      ),
      '[]'::jsonb
    )
    from (
      select p.owner_id as user_id, u.email::text as email,
        private.person_name(u.raw_user_meta_data, u.email::text) as name, 'owner' as role,
        null::timestamptz as invited_at, null::timestamptz as accepted_at, 0 as rank
      from public.projects p
      join auth.users u on u.id = p.owner_id
      where p.id = list_members.project_id
      union all
      select m.user_id, u.email::text, private.person_name(u.raw_user_meta_data, u.email::text),
        m.role, m.created_at, m.accepted_at,
        case when m.accepted_at is null then 2 else 1 end
      from public.project_members m
      join auth.users u on u.id = m.user_id
      where m.project_id = list_members.project_id
        and (m.accepted_at is not null or caller_role = 'owner')
    ) x
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.person_name (
  metadata jsonb,
  email    text
)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(
    (select named.name
     from (
       select nullif(left(btrim(regexp_replace(person_name.metadata ->> k.key, '\s+', ' ', 'g')), 80), '') as name, k.rank
       from unnest(array['display_name', 'full_name', 'name']) with ordinality as k(key, rank)
     ) named
     where named.name is not null
     order by named.rank
     limit 1),
    person_name.email
  )
$function$;

REVOKE ALL ON FUNCTION "private"."person_name"(jsonb, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."person_name"(jsonb, text) TO "postgres";
