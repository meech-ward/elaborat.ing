-- Per-user limits: generous enough that normal use never reaches them, low
-- enough to stop a runaway script or agent. They are enforced here, in the
-- functions that do the work, so the app, the MCP server and direct API calls
-- all get them. See "Limits" in docs/architecture.md.
--
-- Every refusal raises errcode PT429 (the Data API answers HTTP 429) with a
-- plain message that says which limit was reached and when it resets, and the
-- limit's name as the detail.

-- The numbers, in one place. A limit with a window counts uses in fixed
-- windows of that length, starting at whole multiples of it since 2000-01-01
-- UTC, so a day is a UTC day. A limit without a window caps a total.
create function private.limits()
returns table (name text, max_count integer, window_length interval, what text)
language sql
immutable
set search_path = ''
as $$
  values
    ('projects_per_day', 100, interval '1 day', 'new projects a day'),
    ('projects', 1000, null, 'projects'),
    ('saves_per_minute', 300, interval '1 minute', 'saves a minute'),
    ('searches_per_minute', 120, interval '1 minute', 'searches a minute'),
    ('tool_calls_per_minute', 300, interval '1 minute', 'agent tool calls a minute')
$$;

revoke all on function private.limits() from public, anon;
grant execute on function private.limits() to authenticated;

-- One row per user and limit: the uses counted in its current window.
create table private.limit_counters (
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  window_start timestamptz not null,
  uses integer not null,
  primary key (user_id, name)
);

alter table private.limit_counters enable row level security;

revoke all on table private.limit_counters from anon, authenticated;

-- "Try again in 42 seconds", "in 3 minutes", "in 5 hours": how long until a
-- window resets, rounded up.
create function private.limit_wait(wait interval)
returns text
language sql
immutable
set search_path = ''
as $$
  select n || ' ' || unit || case when n = 1 then '' else 's' end
  from (
    select
      case
        when seconds < 60 then greatest(ceil(seconds), 1)
        when seconds < 3600 then ceil(seconds / 60)
        else ceil(seconds / 3600)
      end::integer as n,
      case when seconds < 60 then 'second' when seconds < 3600 then 'minute' else 'hour' end as unit
    from (select extract(epoch from wait) as seconds) s
  ) w
$$;

revoke all on function private.limit_wait(interval) from public, anon;
grant execute on function private.limit_wait(interval) to authenticated;

-- Count one use of `name` by `user_id` in the current window, and refuse it
-- when that makes more than max_count uses in the window. The upsert locks
-- the counter row until the transaction ends, so concurrent uses by the same
-- user are counted one after another and never slip past the limit together.
-- A refused use rolls back with the rest of its transaction, so it does not
-- count. Only other functions call this: it trusts its user_id.
create function private.count_use(user_id uuid, name text, max_count integer, window_length interval, what text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  this_window timestamptz := date_bin(count_use.window_length, now(), timestamptz '2000-01-01 00:00:00+00');
  counted private.limit_counters;
begin
  insert into private.limit_counters as c (user_id, name, window_start, uses)
  values (count_use.user_id, count_use.name, this_window, 1)
  on conflict on constraint limit_counters_pkey do update
    set uses = case when c.window_start >= excluded.window_start then c.uses + 1 else 1 end,
        window_start = greatest(c.window_start, excluded.window_start)
  returning * into counted;
  if counted.uses > count_use.max_count then
    raise exception 'You have reached the limit of % %. Try again in %.',
      count_use.max_count, count_use.what,
      private.limit_wait(counted.window_start + count_use.window_length - now())
      using errcode = 'PT429', detail = count_use.name;
  end if;
end;
$$;

revoke all on function private.count_use(uuid, text, integer, interval, text) from public, anon, authenticated;

-- Count one use of a limit from private.limits() by the signed-in caller.
create function private.check_limit(name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_user();
  found_limit record;
begin
  select * into found_limit
  from private.limits() l
  where l.name = check_limit.name and l.window_length is not null;
  if not found then
    raise exception 'Unknown limit: %', check_limit.name using errcode = '22023';
  end if;
  perform private.count_use(uid, found_limit.name, found_limit.max_count, found_limit.window_length, found_limit.what);
end;
$$;

revoke all on function private.check_limit(text) from public, anon;
grant execute on function private.check_limit(text) to authenticated;

-- The MCP server calls this before every tool call, so an agent's calls count
-- against its user's limit whichever tool they use.
create function public.count_tool_call()
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.check_limit('tool_calls_per_minute')
$$;

revoke all on function public.count_tool_call() from public, anon;
grant execute on function public.count_tool_call() to authenticated;
