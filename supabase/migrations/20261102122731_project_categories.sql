SET local check_function_bodies = off;

CREATE TABLE "public"."project_categories" (
  "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "owner_id"    uuid                     NOT NULL,
  "name"        text                     NOT NULL,
  "archived_at" timestamp with time zone,
  "revision"    bigint                   NOT NULL DEFAULT 0,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_categories_name_valid"
    CHECK
    (((char_length(name) >= 1) AND (char_length(name) <= 160) AND (name = btrim(name)) AND (name ~ '\S'::text) AND (name !~ '[[:cntrl:]]'::text) AND (name IS NFC NORMALIZED))),
  CONSTRAINT "project_categories_pkey" PRIMARY KEY (id),
  CONSTRAINT "project_categories_revision_nonnegative" CHECK ((revision >= 0))
);

ALTER TABLE "public"."project_categories"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."project_categories" FROM "anon";

CREATE TABLE "public"."project_category_memberships" (
  "category_id" uuid                     NOT NULL,
  "project_id"  uuid                     NOT NULL,
  "removed_at"  timestamp with time zone,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_category_memberships_pkey" PRIMARY KEY (category_id, project_id)
);

ALTER TABLE "public"."project_category_memberships"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."project_category_memberships" FROM "anon";

CREATE OR REPLACE FUNCTION private.check_project_category_counts()
  RETURNS void
  LANGUAGE plpgsql
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  total integer;
  active integer;
  maximum integer;
begin
  select count(*), count(*) filter (where archived_at is null) into total, active
  from public.project_categories where owner_id = uid;
  select l.max_count into maximum from private.limits() l where l.name = 'project_categories';
  if total > maximum then
    raise exception 'You have reached the limit of % categories, including archived categories.', maximum
      using errcode = 'PT429', detail = 'project_categories';
  end if;
  select l.max_count into maximum from private.limits() l where l.name = 'active_project_categories';
  if active > maximum then
    raise exception 'You have reached the limit of % active categories. Archive one to make room.', maximum
      using errcode = 'PT429', detail = 'active_project_categories';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.create_project_category (
  category_id uuid,
  name        text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  cleaned text := private.project_category_name(create_project_category.name);
  c public.project_categories;
begin
  if create_project_category.category_id is null then
    raise exception 'Category id required' using errcode = '22023';
  end if;
  perform private.check_limit('category_changes_per_minute');
  select * into c from public.project_categories where id = create_project_category.category_id;
  if found then
    if c.owner_id is distinct from uid then
      raise exception 'Category unavailable' using errcode = '42501';
    end if;
    return private.project_category_summary(c);
  end if;
  begin
    insert into public.project_categories (id, owner_id, name)
    values (create_project_category.category_id, uid, cleaned)
    on conflict (id) do nothing;
  exception when unique_violation then
    raise exception 'A category with that name already exists. Choose a different name.' using errcode = '23505';
  end;
  select * into c from public.project_categories where id = create_project_category.category_id;
  if c.owner_id is distinct from uid then
    raise exception 'Category unavailable' using errcode = '42501';
  end if;
  perform private.check_project_category_counts();
  return private.project_category_summary(c);
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
    ('project_categories', 1000, null, 'categories, including archived categories'),
    ('projects_per_category', 10000, null, 'projects in a category'),
    ('active_project_categories', 128, null, 'active categories'),
    ('category_changes_per_minute', 300, interval '1 minute', 'category changes a minute'),
    ('saves_per_minute', 300, interval '1 minute', 'saves a minute'),
    ('image_uploads_per_minute', 30, interval '1 minute', 'image uploads a minute'),
    ('searches_per_minute', 120, interval '1 minute', 'searches a minute'),
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute'),
    ('invitations_per_day', 50, interval '1 day', 'invitations a day'),
    ('comment_writes_per_minute', 120, interval '1 minute', 'comment changes a minute'),
    ('account_deletions_per_day', 5, interval '1 day', 'account deletion attempts a day')
$function$;

CREATE OR REPLACE FUNCTION private.project_category_name (
  name text
)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  cleaned text := normalize(btrim(project_category_name.name), NFC);
begin
  if cleaned is null or char_length(cleaned) < 1 or char_length(cleaned) > 160
    or cleaned !~ '\S' or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Category names must contain 1 to 160 characters without control characters.' using errcode = '22023';
  end if;
  return cleaned;
end;
$function$;

CREATE OR REPLACE FUNCTION private.project_category_summary (
  c public.project_categories
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'archived_at', c.archived_at,
    'updated_at', c.updated_at,
    'revision', c.revision,
    'project_ids', coalesce((
      select jsonb_agg(m.project_id order by m.project_id)
      from public.project_category_memberships m
      where m.category_id = c.id and m.removed_at is null
        and c.owner_id = (select auth.uid())
        and m.project_id in (select private.readable_project_ids())
    ), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION private.rename_project_category (
  category_id uuid,
  name        text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  cleaned text := private.project_category_name(rename_project_category.name);
  c public.project_categories;
begin
  perform private.check_limit('category_changes_per_minute');
  select * into c from public.project_categories
  where id = rename_project_category.category_id and owner_id = uid for update;
  if not found then raise exception 'Category unavailable' using errcode = '42501'; end if;
  if c.name is distinct from cleaned then
    begin
      update public.project_categories set name = cleaned, revision = revision + 1, updated_at = now()
      where id = c.id returning * into c;
    exception when unique_violation then
      raise exception 'A category with that name already exists. Choose a different name.' using errcode = '23505';
    end;
  end if;
  return private.project_category_summary(c);
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_project_categories (
  project_id   uuid,
  category_ids uuid[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  chosen uuid[];
  maximum integer;
begin
  if set_project_categories.category_ids is null
    or cardinality(set_project_categories.category_ids) > 128
    or coalesce(array_ndims(set_project_categories.category_ids), 1) <> 1
    or array_position(set_project_categories.category_ids, null) is not null then
    raise exception 'Choose at most 128 category ids without empty entries.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct id order by id), '{}'::uuid[]) into chosen
  from unnest(set_project_categories.category_ids) as ids(id);
  perform private.check_limit('category_changes_per_minute');
  if private.project_role(set_project_categories.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  perform 1 from public.project_categories c
  where c.owner_id = uid and c.archived_at is null order by c.id for update;
  if (select count(*) from public.project_categories c
      where c.owner_id = uid and c.archived_at is null and c.id = any(chosen)) <> cardinality(chosen) then
    raise exception 'Category unavailable' using errcode = '42501';
  end if;
  select l.max_count into maximum from private.limits() l where l.name = 'projects_per_category';
  if exists (
    select 1 from public.project_categories c where c.id = any(chosen)
      and not exists (select 1 from public.project_category_memberships m
        where m.category_id = c.id and m.project_id = set_project_categories.project_id and m.removed_at is null)
      and (select count(*) from public.project_category_memberships m where m.category_id = c.id and m.removed_at is null) >= maximum
  ) then
    raise exception 'A category can contain at most % projects. Remove a project before adding another.', maximum
      using errcode = 'PT429', detail = 'projects_per_category';
  end if;
  with changed as (
    insert into public.project_category_memberships as m (category_id, project_id)
    select c.id, set_project_categories.project_id from public.project_categories c
    where c.owner_id = uid and c.archived_at is null and c.id = any(chosen)
    on conflict on constraint project_category_memberships_pkey do update set removed_at = null where m.removed_at is not null
    returning category_id
  )
  update public.project_categories c set revision = revision + 1, updated_at = now()
  where c.id in (select category_id from changed);
  with changed as (
    update public.project_category_memberships m set removed_at = now()
    where m.project_id = set_project_categories.project_id and m.removed_at is null
      and m.category_id in (select c.id from public.project_categories c
        where c.owner_id = uid and c.archived_at is null and not (c.id = any(chosen)))
    returning category_id
  )
  update public.project_categories c set revision = revision + 1, updated_at = now()
  where c.id in (select category_id from changed);
  return (select coalesce(jsonb_agg(private.project_category_summary(c) order by lower(c.name), c.id), '[]'::jsonb)
    from public.project_categories c where c.owner_id = uid);
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_project_category_archived (
  category_id uuid,
  archived    boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  c public.project_categories;
begin
  if set_project_category_archived.archived is null then
    raise exception 'Archived must be true or false' using errcode = '22023';
  end if;
  perform private.check_limit('category_changes_per_minute');
  select * into c from public.project_categories
  where id = set_project_category_archived.category_id and owner_id = uid for update;
  if not found then raise exception 'Category unavailable' using errcode = '42501'; end if;
  if (c.archived_at is not null) is distinct from set_project_category_archived.archived then
    begin
      update public.project_categories
      set archived_at = case when set_project_category_archived.archived then now() end,
          revision = revision + 1, updated_at = now()
      where id = c.id returning * into c;
    exception when unique_violation then
      raise exception 'A category with that name already exists. Rename this category before restoring it.' using errcode = '23505';
    end;
    perform private.check_project_category_counts();
  end if;
  return private.project_category_summary(c);
end;
$function$;

CREATE OR REPLACE FUNCTION private.set_project_category_membership (
  category_id uuid,
  project_id  uuid,
  included    boolean
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user();
  c public.project_categories;
  changed boolean;
  maximum integer;
begin
  if set_project_category_membership.included is null then
    raise exception 'Included must be true or false' using errcode = '22023';
  end if;
  perform private.check_limit('category_changes_per_minute');
  select * into c from public.project_categories
  where id = set_project_category_membership.category_id and owner_id = uid for update;
  if not found then raise exception 'Category unavailable' using errcode = '42501'; end if;
  if private.project_role(set_project_category_membership.project_id) is null then
    raise exception 'Project unavailable' using errcode = '42501';
  end if;
  if c.archived_at is not null then raise exception 'Category is archived' using errcode = '55000'; end if;
  if set_project_category_membership.included then
    select l.max_count into maximum from private.limits() l where l.name = 'projects_per_category';
    if not exists (select 1 from public.project_category_memberships m
        where m.category_id = c.id and m.project_id = set_project_category_membership.project_id and m.removed_at is null)
      and (select count(*) from public.project_category_memberships m where m.category_id = c.id and m.removed_at is null) >= maximum then
      raise exception 'A category can contain at most % projects. Remove a project before adding another.', maximum
        using errcode = 'PT429', detail = 'projects_per_category';
    end if;
    insert into public.project_category_memberships as m (category_id, project_id)
    values (c.id, set_project_category_membership.project_id)
    on conflict on constraint project_category_memberships_pkey do update set removed_at = null where m.removed_at is not null;
    changed := found;
  else
    update public.project_category_memberships as m set removed_at = now()
    where m.category_id = c.id and m.project_id = set_project_category_membership.project_id and m.removed_at is null;
    changed := found;
  end if;
  if changed then
    update public.project_categories set revision = revision + 1, updated_at = now()
    where id = c.id returning * into c;
  end if;
  return private.project_category_summary(c);
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_project_category (
  category_id uuid,
  name        text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.create_project_category(category_id, name) $function$;

REVOKE ALL ON FUNCTION "public"."create_project_category"(uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.list_project_categories()
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$
  select coalesce(jsonb_agg(private.project_category_summary(c) order by lower(c.name), c.id), '[]'::jsonb)
  from public.project_categories c
  where c.owner_id = (select auth.uid())
$function$;

REVOKE ALL ON FUNCTION "public"."list_project_categories"() FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.rename_project_category (
  category_id uuid,
  name        text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.rename_project_category(category_id, name) $function$;

REVOKE ALL ON FUNCTION "public"."rename_project_category"(uuid, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.set_project_categories (
  project_id   uuid,
  category_ids uuid[]
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.set_project_categories(project_id, category_ids) $function$;

REVOKE ALL ON FUNCTION "public"."set_project_categories"(uuid, uuid[]) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.set_project_category_archived (
  category_id uuid,
  archived    boolean
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.set_project_category_archived(category_id, archived) $function$;

REVOKE ALL ON FUNCTION "public"."set_project_category_archived"(uuid, boolean) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.set_project_category_membership (
  category_id uuid,
  project_id  uuid,
  included    boolean
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.set_project_category_membership(category_id, project_id, included) $function$;

REVOKE ALL ON FUNCTION "public"."set_project_category_membership"(uuid, uuid, boolean) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."project_categories"
  ADD CONSTRAINT "project_categories_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE "public"."project_category_memberships"
  ADD CONSTRAINT "project_category_memberships_category_id_fkey" FOREIGN KEY (category_id) REFERENCES public.project_categories(id) ON DELETE CASCADE;

ALTER TABLE "public"."project_category_memberships"
  ADD CONSTRAINT "project_category_memberships_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX project_categories_active_name_idx ON public.project_categories USING btree (owner_id, lower(name))
  WHERE (archived_at IS NULL);

CREATE INDEX project_categories_owner_id_idx ON public.project_categories USING btree (owner_id);

CREATE INDEX project_category_memberships_included_idx ON public.project_category_memberships USING btree (category_id, project_id)
  WHERE (removed_at IS NULL);

CREATE INDEX project_category_memberships_project_id_idx ON public.project_category_memberships USING btree (project_id);

CREATE POLICY "People can read their own project categories" ON "public"."project_categories"
  FOR SELECT
  TO "authenticated"
  USING ((owner_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "People can read category assignments for projects they can stil" ON "public"."project_category_memberships"
  FOR SELECT
  TO "authenticated"
  USING (((category_id IN ( SELECT c.id
   FROM public.project_categories c
  WHERE (c.owner_id = ( SELECT auth.uid() AS uid)))) AND (project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids))));

REVOKE ALL ON FUNCTION "private"."check_project_category_counts"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."check_project_category_counts"() TO "postgres";

REVOKE ALL ON FUNCTION "private"."create_project_category"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."create_project_category"(uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."project_category_name"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."project_category_name"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."project_category_summary"(public.project_categories) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."project_category_summary"(public.project_categories) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."rename_project_category"(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."rename_project_category"(uuid, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_project_categories"(uuid, uuid[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_project_categories"(uuid, uuid[]) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_project_category_archived"(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_project_category_archived"(uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."set_project_category_membership"(uuid, uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."set_project_category_membership"(uuid, uuid, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."create_project_category"(uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."list_project_categories"() TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."rename_project_category"(uuid, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."set_project_categories"(uuid, uuid[]) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."set_project_category_archived"(uuid, boolean) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."set_project_category_membership"(uuid, uuid, boolean) TO "authenticated", "postgres";

REVOKE ALL ON TABLE "public"."project_categories" FROM "authenticated";

GRANT SELECT ON TABLE "public"."project_categories" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."project_categories" TO "postgres";

REVOKE ALL ON TABLE "public"."project_categories" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."project_categories" TO "service_role";

REVOKE ALL ON TABLE "public"."project_category_memberships" FROM "authenticated";

GRANT SELECT ON TABLE "public"."project_category_memberships" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."project_category_memberships" TO "postgres";

REVOKE ALL ON TABLE "public"."project_category_memberships" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."project_category_memberships" TO "service_role";
