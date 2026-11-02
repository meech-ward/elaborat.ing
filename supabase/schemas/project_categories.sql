-- Categories organize one person's projects. They never change project access,
-- file revisions or another person's organization of the same project.
create table public.project_categories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  archived_at timestamptz,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_categories_name_valid check (
    char_length(name) >= 1 and char_length(name) <= 160
    and name = btrim(name) and name ~ '\S' and name !~ '[[:cntrl:]]'
    and name is nfc normalized
  ),
  constraint project_categories_revision_nonnegative check (revision >= 0)
);

create index project_categories_owner_id_idx on public.project_categories (owner_id);
create unique index project_categories_active_name_idx
  on public.project_categories (owner_id, lower(name)) where archived_at is null;

alter table public.project_categories enable row level security;
revoke all on table public.project_categories from anon, authenticated;
grant select on table public.project_categories to authenticated;

create policy "People can read their own project categories"
  on public.project_categories for select to authenticated
  using (owner_id = (select auth.uid()));

-- Removing a project keeps its association recoverable. Archiving a category
-- keeps all its assignments, including assignments to archived projects.
create table public.project_category_memberships (
  category_id uuid not null references public.project_categories (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (category_id, project_id)
);

create index project_category_memberships_project_id_idx
  on public.project_category_memberships (project_id);
create index project_category_memberships_included_idx
  on public.project_category_memberships (category_id, project_id) where removed_at is null;

alter table public.project_category_memberships enable row level security;
revoke all on table public.project_category_memberships from anon, authenticated;
grant select on table public.project_category_memberships to authenticated;

create policy "People can read category assignments for projects they can still read"
  on public.project_category_memberships for select to authenticated
  using (
    category_id in (select c.id from public.project_categories c where c.owner_id = (select auth.uid()))
    and project_id in (select private.readable_project_ids())
  );

create function private.project_category_summary(c public.project_categories)
returns jsonb
language sql
stable
set search_path = ''
as $$
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
$$;

revoke all on function private.project_category_summary(public.project_categories) from public, anon;
grant execute on function private.project_category_summary(public.project_categories) to authenticated;

create function public.list_project_categories()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.project_category_summary(c) order by lower(c.name), c.id), '[]'::jsonb)
  from public.project_categories c
  where c.owner_id = (select auth.uid())
$$;

revoke all on function public.list_project_categories() from public, anon;
grant execute on function public.list_project_categories() to authenticated;

-- Internal helpers are not executable by clients. Mutations acquire the
-- category_changes_per_minute counter first, serializing this owner's writes
-- before locking category rows. That also makes total/active limits race-safe.
create function private.project_category_name(name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  cleaned text := normalize(btrim(project_category_name.name), NFC);
begin
  if cleaned is null or char_length(cleaned) < 1 or char_length(cleaned) > 160
    or cleaned !~ '\S' or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Category names must contain 1 to 160 characters without control characters.' using errcode = '22023';
  end if;
  return cleaned;
end;
$$;

revoke all on function private.project_category_name(text) from public, anon, authenticated;

create function private.check_project_category_counts()
returns void
language plpgsql
set search_path = ''
as $$
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
$$;

revoke all on function private.check_project_category_counts() from public, anon, authenticated;

create function private.create_project_category(category_id uuid, name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.create_project_category(uuid, text) from public, anon;
grant execute on function private.create_project_category(uuid, text) to authenticated;

create function public.create_project_category(category_id uuid, name text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.create_project_category(category_id, name) $$;
revoke all on function public.create_project_category(uuid, text) from public, anon;
grant execute on function public.create_project_category(uuid, text) to authenticated;

create function private.rename_project_category(category_id uuid, name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.rename_project_category(uuid, text) from public, anon;
grant execute on function private.rename_project_category(uuid, text) to authenticated;

create function public.rename_project_category(category_id uuid, name text)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.rename_project_category(category_id, name) $$;
revoke all on function public.rename_project_category(uuid, text) from public, anon;
grant execute on function public.rename_project_category(uuid, text) to authenticated;

create function private.set_project_category_archived(category_id uuid, archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.set_project_category_archived(uuid, boolean) from public, anon;
grant execute on function private.set_project_category_archived(uuid, boolean) to authenticated;

create function public.set_project_category_archived(category_id uuid, archived boolean)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.set_project_category_archived(category_id, archived) $$;
revoke all on function public.set_project_category_archived(uuid, boolean) from public, anon;
grant execute on function public.set_project_category_archived(uuid, boolean) to authenticated;

create function private.set_project_category_membership(category_id uuid, project_id uuid, included boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.set_project_category_membership(uuid, uuid, boolean) from public, anon;
grant execute on function private.set_project_category_membership(uuid, uuid, boolean) to authenticated;

create function public.set_project_category_membership(category_id uuid, project_id uuid, included boolean)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.set_project_category_membership(category_id, project_id, included) $$;
revoke all on function public.set_project_category_membership(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_project_category_membership(uuid, uuid, boolean) to authenticated;

-- Replace only this caller's active category assignments in one transaction.
-- Categories archived earlier retain their assignments for a later restore.
create function private.set_project_categories(project_id uuid, category_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

revoke all on function private.set_project_categories(uuid, uuid[]) from public, anon;
grant execute on function private.set_project_categories(uuid, uuid[]) to authenticated;

create function public.set_project_categories(project_id uuid, category_ids uuid[])
returns jsonb language sql security invoker set search_path = ''
as $$ select private.set_project_categories(project_id, category_ids) $$;
revoke all on function public.set_project_categories(uuid, uuid[]) from public, anon;
grant execute on function public.set_project_categories(uuid, uuid[]) to authenticated;
