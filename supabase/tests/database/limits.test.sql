-- Per-user limits: each one lets uses through up to its number, refuses the
-- next with PT429 and a message naming the limit and when it resets, starts
-- again in the next window, and never touches anyone else's count.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens in
-- one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(47);

-- Counters are private; people reach them only through the functions that count.
select table_privs_are('private', 'limit_counters', 'authenticated', array[]::text[], 'Signed-in users cannot touch the counters');
select table_privs_are('private', 'limit_counters', 'anon', array[]::text[], 'Anonymous users cannot touch the counters');
select ok((select relrowsecurity from pg_class where oid = 'private.limit_counters'::regclass), 'Row-level security is enabled on the counters');
select function_privs_are(
  'private', 'count_use', array['uuid', 'text', 'integer', 'interval', 'text'], 'authenticated', array[]::text[],
  'Signed-in users cannot count uses for someone else'
);
select function_privs_are('public', 'count_tool_call', array[]::text[], 'anon', array[]::text[], 'Anonymous users cannot count tool calls');

select results_eq(
  $$select name, max_count, window_length from private.limits() order by name$$,
  $$values ('account_deletions_per_day', 5, interval '1 day'),
      ('comment_writes_per_minute', 120, interval '1 minute'), ('invitations_per_day', 50, interval '1 day'),
      ('projects', 1000, null::interval), ('projects_per_day', 100, interval '1 day'),
      ('saves_per_minute', 300, interval '1 minute'), ('searches_per_minute', 120, interval '1 minute'),
      ('tool_calls_per_minute', 300, interval '1 minute')$$,
  'The limits and their numbers'
);

select is(private.limit_wait(interval '0.2 seconds'), '1 second', 'A wait under a second reads as 1 second');
select is(private.limit_wait(interval '41.5 seconds'), '42 seconds', 'Seconds round up');
select is(private.limit_wait(interval '61 seconds'), '2 minutes', 'Minutes round up');
select is(private.limit_wait(interval '5 hours'), '5 hours', 'Hours for long waits');

-- Alice and Bob each own a project, made directly so they count toward no limit.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com');
insert into public.projects (id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Alice'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bob');

-- One save of an empty folder, with a fresh mutation id.
create function pg_temp.save(project uuid)
returns text
language sql
as $$
  select public.save_files(project, gen_random_uuid(), '[{"op":"mkdir","path":"f"}]') ->> 'status'
$$;

-- A search, with any query vector.
create function pg_temp.search()
returns bigint
language sql
as $$
  select count(*) from public.hybrid_search('tomato', array_fill(0, array[384])::real[]::extensions.vector, 5)
$$;

-- Put a user's count for a limit at `uses` in the current window.
create function pg_temp.set_uses(who uuid, limit_name text, uses integer)
returns void
language sql
as $$
  insert into private.limit_counters (user_id, name, window_start, uses)
  select who, limit_name, date_bin(l.window_length, now(), timestamptz '2000-01-01 00:00:00+00'), uses
  from private.limits() l where l.name = limit_name
  on conflict (user_id, name) do update set window_start = excluded.window_start, uses = excluded.uses
$$;

-- Move a user's window for a limit into the past, as if it had ended.
create function pg_temp.end_window(who uuid, limit_name text)
returns void
language sql
as $$
  update private.limit_counters c set window_start = c.window_start - l.window_length
  from private.limits() l
  where l.name = limit_name and c.user_id = who and c.name = limit_name
$$;

create function pg_temp.uses(who uuid, limit_name text)
returns integer
language sql
as $$
  select uses from private.limit_counters where user_id = who and name = limit_name
$$;

-- Saves a minute.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(pg_temp.save('aaaaaaaa-0000-4000-8000-000000000001'), 'saved', 'Under the limit, a save goes through');
reset role;
select is(pg_temp.uses('11111111-1111-4111-8111-111111111111', 'saves_per_minute'), 1, 'and counts once');
select pg_temp.set_uses('11111111-1111-4111-8111-111111111111', 'saves_per_minute', 299);
set local role authenticated;
select is(pg_temp.save('aaaaaaaa-0000-4000-8000-000000000001'), 'saved', 'The 300th save in a minute goes through');
select throws_ok(
  $$select pg_temp.save('aaaaaaaa-0000-4000-8000-000000000001')$$,
  'PT429', null, 'The 301st is refused with PT429'
);
select throws_like(
  $$select pg_temp.save('aaaaaaaa-0000-4000-8000-000000000001')$$,
  'You have reached the limit of 300 saves a minute. Try again in % second%.',
  'saying which limit and when it resets'
);
reset role;
select is(pg_temp.uses('11111111-1111-4111-8111-111111111111', 'saves_per_minute'), 300, 'Refused saves do not count');
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(pg_temp.save('bbbbbbbb-0000-4000-8000-000000000001'), 'saved', 'Someone else still saves');
reset role;
select pg_temp.end_window('11111111-1111-4111-8111-111111111111', 'saves_per_minute');
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(pg_temp.save('aaaaaaaa-0000-4000-8000-000000000001'), 'saved', 'In the next minute, saves go through again');
reset role;
select is(pg_temp.uses('11111111-1111-4111-8111-111111111111', 'saves_per_minute'), 1, 'counted from one');

-- New projects a day.
set local role authenticated;
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000002', 'Two') ->> 'role', 'owner',
  'Under the limit, a new project is created'
);
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000002', 'Two') ->> 'role', 'owner',
  'and creating it again returns it'
);
reset role;
select is(pg_temp.uses('11111111-1111-4111-8111-111111111111', 'projects_per_day'), 1, 'which counts once');
select pg_temp.set_uses('11111111-1111-4111-8111-111111111111', 'projects_per_day', 99);
set local role authenticated;
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000003', 'Three') ->> 'role', 'owner',
  'The 100th new project in a day is created'
);
select throws_ok(
  $$select public.create_project('aaaaaaaa-0000-4000-8000-000000000004', 'Four')$$,
  'PT429', null, 'The 101st is refused with PT429'
);
select throws_like(
  $$select public.create_project('aaaaaaaa-0000-4000-8000-000000000004', 'Four')$$,
  'You have reached the limit of 100 new projects a day. Try again in %.',
  'saying which limit and when it resets'
);
select is(
  (select count(*) from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000004'),
  0::bigint,
  'and the refused project is not created'
);
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000003', 'Three') ->> 'role', 'owner',
  'Over the limit, creating an existing project again still returns it'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(
  public.create_project('bbbbbbbb-0000-4000-8000-000000000002', 'Bob two') ->> 'role', 'owner',
  'Someone else still creates projects'
);
reset role;
select pg_temp.end_window('11111111-1111-4111-8111-111111111111', 'projects_per_day');
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000004', 'Four') ->> 'role', 'owner',
  'The next day, new projects are created again'
);

-- Projects in total. Carol already has 999, archived ones among them.
reset role;
insert into public.projects (id, owner_id, title, archived_at)
select gen_random_uuid(), '33333333-3333-4333-8333-333333333333', 'Old ' || i, case when i % 2 = 0 then now() end
from generate_series(1, 999) as i;
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  public.create_project('cccccccc-0000-4000-8000-000000000001', 'Carol') ->> 'role', 'owner',
  'The 1000th project is created'
);
select throws_ok(
  $$select public.create_project('cccccccc-0000-4000-8000-000000000002', 'One more')$$,
  'PT429',
  'You have reached the limit of 1000 projects. Permanently delete one to make room.',
  'The 1001st is refused, saying how to make room'
);
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  public.create_project('aaaaaaaa-0000-4000-8000-000000000005', 'Alice five') ->> 'role', 'owner',
  'Someone else still creates projects'
);
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  public.delete_project('cccccccc-0000-4000-8000-000000000001') ->> 'deleted', 'true',
  'Carol permanently deletes one'
);
select is(
  public.create_project('cccccccc-0000-4000-8000-000000000002', 'One more') ->> 'role', 'owner',
  'and then can create one'
);

-- Searches a minute.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$select pg_temp.search()$$, 'Under the limit, a search runs');
reset role;
select pg_temp.set_uses('11111111-1111-4111-8111-111111111111', 'searches_per_minute', 119);
set local role authenticated;
select lives_ok($$select pg_temp.search()$$, 'The 120th search in a minute runs');
select throws_ok($$select pg_temp.search()$$, 'PT429', null, 'The 121st is refused with PT429');
select throws_like(
  $$select pg_temp.search()$$,
  'You have reached the limit of 120 searches a minute. Try again in % second%.',
  'saying which limit and when it resets'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select lives_ok($$select pg_temp.search()$$, 'Someone else still searches');
reset role;
select pg_temp.end_window('11111111-1111-4111-8111-111111111111', 'searches_per_minute');
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$select pg_temp.search()$$, 'In the next minute, searches run again');

-- Agent tool calls a minute, counted by the MCP server before each call.
select lives_ok($$select public.count_tool_call()$$, 'Under the limit, a tool call is counted');
reset role;
select pg_temp.set_uses('11111111-1111-4111-8111-111111111111', 'tool_calls_per_minute', 299);
set local role authenticated;
select lives_ok($$select public.count_tool_call()$$, 'The 300th tool call in a minute goes through');
select throws_ok($$select public.count_tool_call()$$, 'PT429', null, 'The 301st is refused with PT429');
select throws_like(
  $$select public.count_tool_call()$$,
  'You have reached the limit of 300 agent tool calls a minute. Try again in % second%.',
  'saying which limit and when it resets'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select lives_ok($$select public.count_tool_call()$$, 'Someone else still calls tools');
reset role;
select pg_temp.end_window('11111111-1111-4111-8111-111111111111', 'tool_calls_per_minute');
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$select public.count_tool_call()$$, 'In the next minute, tool calls go through again');

set local role anon;
select throws_ok($$select public.count_tool_call()$$, '42501', null, 'Anonymous callers are refused');

reset role;
select * from finish();
rollback;
