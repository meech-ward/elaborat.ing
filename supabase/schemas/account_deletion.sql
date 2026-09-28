-- Deleting your own account, for the `delete-account` Edge Function and the
-- Settings page that explains it first. See "Accounts" in docs/architecture.md.
--
-- The function runs as the person: it starts here (which refuses agents and
-- counts the daily limit), deletes each project they own with
-- `delete_project`, as them, and only then deletes the account with Auth's
-- admin API. Deleting the account removes their memberships and limit
-- counters, and leaves their comments, file versions and threads with no
-- author (the foreign keys say so).

-- What deleting the caller's account would do: the projects they own, each
-- with how many people have accepted it (they lose it too), and how many
-- projects shared with them they would leave. Runs as the caller, so RLS
-- decides what is visible.
create function public.account_deletion_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'owned', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'title', p.title,
            'archived', p.archived_at is not null,
            'members', (
              select count(*)
              from public.project_members m
              where m.project_id = p.id and m.accepted_at is not null
            )
          )
          order by lower(p.title), p.id
        )
        from public.projects p
        where p.owner_id = private.require_user()
      ),
      '[]'::jsonb
    ),
    'shared', (
      select count(*)
      from public.project_members m
      where m.user_id = private.require_user() and m.accepted_at is not null
    )
  )
$$;

revoke all on function public.account_deletion_summary() from public, anon;
grant execute on function public.account_deletion_summary() to authenticated;

-- Start deleting the caller's account: refuses a token issued to an OAuth
-- client (only a person deletes their account), counts one attempt against
-- the daily limit (`account_deletions_per_day` in limits.sql), and returns
-- the summary above, whose owned projects the function then deletes.
create function public.begin_account_deletion()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.require_user();
  if private.is_oauth_client() then
    raise exception 'Only a signed-in person can delete their account' using errcode = '42501';
  end if;
  perform private.check_limit('account_deletions_per_day');
  return public.account_deletion_summary();
end;
$$;

revoke all on function public.begin_account_deletion() from public, anon;
grant execute on function public.begin_account_deletion() to authenticated;
