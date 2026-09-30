-- Agent changes: the file versions agents saved, with each one's previous
-- version and the thread it answered, only for people who can read the
-- project, and each person's own marker of what they have seen.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens
-- in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(40);

-- Alice owns the project; Bob is an editor and Dave a viewer, both accepted.
-- Erin was a member until Alice removed her. Frank has nothing to do with it.
create function pg_temp.id(who text)
returns uuid
language sql
immutable
as $$
  select (case who
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob' then '22222222-2222-4222-8222-222222222222'
    when 'dave' then '44444444-4444-4444-8444-444444444444'
    when 'erin' then '55555555-5555-4555-8555-555555555555'
    when 'frank' then '66666666-6666-4666-8666-666666666666'
  end)::uuid
$$;

create function pg_temp.client()
returns text
language sql
immutable
as $$ select 'a9000000-0000-4000-8000-000000000001' $$;

-- Act as someone, in the app or through their agent.
create function pg_temp.act(who text, agent boolean default false)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    (jsonb_build_object('sub', pg_temp.id(who), 'role', 'authenticated')
      || case when agent then jsonb_build_object('client_id', pg_temp.client()) else '{}'::jsonb end)::text,
    true
  )
$$;

create function pg_temp.project()
returns uuid
language sql
immutable
as $$ select 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $$;

create function pg_temp.version(file_path text)
returns bigint
language sql
as $$ select version from public.project_files where project_id = pg_temp.project() and path = file_path $$;

create function pg_temp.file_id(file_path text)
returns uuid
language sql
as $$ select id from public.project_files where project_id = pg_temp.project() and path = file_path $$;

create function pg_temp.save(changes text)
returns jsonb
language sql
as $$ select public.save_files(pg_temp.project(), gen_random_uuid(), changes::jsonb) $$;

-- The changes the caller lists, as [path, version] pairs, newest first.
create function pg_temp.listed(before bigint default null, max_count integer default 20)
returns jsonb
language sql
as $$
  select coalesce(jsonb_agg(jsonb_build_array(c ->> 'path', (c ->> 'version')::bigint) order by ord), '[]'::jsonb)
  from jsonb_array_elements(public.list_agent_changes(pg_temp.project(), before, max_count) -> 'changes') with ordinality as l(c, ord)
$$;

create function pg_temp.change(file_path text)
returns jsonb
language sql
as $$
  select c from jsonb_array_elements(public.list_agent_changes(pg_temp.project()) -> 'changes') c
  where c ->> 'path' = file_path
  order by (c ->> 'version')::bigint desc
  limit 1
$$;

------------------------------------------------------------------------------
-- Grants.

select table_privs_are('public', 'agent_changes_seen', 'authenticated', array['SELECT'], 'Signed-in users only read markers');
select table_privs_are('public', 'agent_changes_seen', 'anon', array[]::text[], 'Anonymous users cannot');
select policies_are('public', 'agent_changes_seen', array['People can read their own agent changes marker'], 'Markers have one policy');
select function_privs_are('public', 'list_agent_changes', array['uuid', 'bigint', 'integer'], 'authenticated', array['EXECUTE'], 'Signed-in users can list agent changes');
select function_privs_are('public', 'list_agent_changes', array['uuid', 'bigint', 'integer'], 'anon', array[]::text[], 'Anonymous users cannot');
select function_privs_are('public', 'count_agent_changes', array['uuid'], 'anon', array[]::text[], 'nor count them');
select function_privs_are('public', 'mark_agent_changes_seen', array['uuid', 'bigint'], 'anon', array[]::text[], 'nor mark them seen');

------------------------------------------------------------------------------
-- The people, the project, and what the app and an agent saved.

insert into auth.users (id, email)
select pg_temp.id(name), name || '@example.com'
from unnest(array['alice', 'bob', 'dave', 'erin', 'frank']) name;

insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name, token_endpoint_auth_method, client_type)
values (pg_temp.client()::uuid, 'dynamic', 'https://agent.example/callback', 'authorization_code', 'Claude', 'none', 'public');

insert into public.projects (id, owner_id, title) values (pg_temp.project(), pg_temp.id('alice'), 'Shared');
insert into public.project_members (project_id, user_id, role, accepted_at) values
  (pg_temp.project(), pg_temp.id('bob'), 'editor', now()),
  (pg_temp.project(), pg_temp.id('dave'), 'viewer', now()),
  (pg_temp.project(), pg_temp.id('erin'), 'viewer', now());

set local role authenticated;
select pg_temp.act('alice');
select lives_ok(
  $$ select pg_temp.save('[{"op":"put","path":"notes/a.md","content":"A1"},{"op":"put","path":"notes/b.md","content":"B1"}]') $$,
  'Alice saves two notes in the app'
);
select pg_temp.act('alice', true);
select lives_ok(
  $$ select pg_temp.save(format('[{"op":"put","path":"notes/a.md","content":"A2","base_version":%s}]', pg_temp.version('notes/a.md'))) $$,
  'Her agent changes notes/a.md'
);
select lives_ok(
  $$ select pg_temp.save(format(
       '[{"op":"put","path":"notes/b.md","content":"B2","base_version":%s},{"op":"put","path":"notes/c.md","content":"C1"}]',
       pg_temp.version('notes/b.md'))) $$,
  'then changes notes/b.md and creates notes/c.md in one save'
);
select pg_temp.act('bob');
select lives_ok(
  $$ select pg_temp.save(format('[{"op":"put","path":"notes/b.md","content":"B3","base_version":%s}]', pg_temp.version('notes/b.md'))) $$,
  'Bob changes notes/b.md in the app'
);

-- Alice asked on a thread, and her agent's reply links the version it saved.
select pg_temp.act('alice');
select lives_ok(
  $$ select public.add_comment(pg_temp.project(), 'c0000000-0000-4000-8000-000000000001', pg_temp.file_id('notes/a.md'),
       pg_temp.version('notes/a.md'), '{"kind": "document"}'::jsonb, 'Say it twice') $$,
  'Alice starts a thread on notes/a.md'
);
select pg_temp.act('alice', true);
select lives_ok(
  $$ select public.reply_comment('c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'Done.', pg_temp.version('notes/a.md')) $$,
  'and her agent replies with the version it saved'
);

-- Alice removes Erin, who had looked before.
select pg_temp.act('erin');
select lives_ok($$ select public.mark_agent_changes_seen(pg_temp.project(), 1) $$, 'Erin looks while she is a member');
select pg_temp.act('alice');
select lives_ok($$ select public.share_project(pg_temp.project(), pg_temp.id('erin'), null) $$, 'Alice removes Erin');

------------------------------------------------------------------------------
-- What readers see.

select pg_temp.act('dave');
select is(
  pg_temp.listed(),
  '[["notes/b.md", 3], ["notes/c.md", 3], ["notes/a.md", 2]]'::jsonb,
  'A viewer lists the versions agents saved, newest first, and none the app saved'
);
select is(
  (select jsonb_build_object('agent', c -> 'agent', 'by', c -> 'author' ->> 'email', 'content', c -> 'content', 'latest', c -> 'latest',
     'previous', (c -> 'previous') - 'path', 'thread', (c -> 'thread') - 'comment_id')
   from pg_temp.change('notes/a.md') c),
  '{"agent": "Claude", "by": "alice@example.com", "content": "A2", "latest": true,
    "previous": {"version": 1, "deleted": false, "content": "A1"},
    "thread": {"id": "c0000000-0000-4000-8000-000000000001", "opening": "Say it twice"}}'::jsonb,
  'Each has the agent''s name and its person, its content, the previous version''s, and the thread its reply answered'
);
select is(
  (select jsonb_build_array(b -> 'latest', b -> 'previous' -> 'content', c -> 'previous', c -> 'thread')
   from pg_temp.change('notes/b.md') b, pg_temp.change('notes/c.md') c),
  '[false, "B1", null, null]'::jsonb,
  'A version changed since is not the latest; a file the agent created has no previous version, and no thread'
);
select ok(
  not (public.list_agent_changes(pg_temp.project()) -> 'changes' -> 0 ? 'agent_client_id')
    and position(pg_temp.client() in public.list_agent_changes(pg_temp.project())::text) = 0,
  'The agent''s client id is never returned'
);
select is(
  (select jsonb_build_array(l -> 'more', pg_temp.listed(null, 1), pg_temp.listed(3, 1))
   from public.list_agent_changes(pg_temp.project(), null, 1) l),
  '[true, [["notes/b.md", 3], ["notes/c.md", 3]], [["notes/a.md", 2]]]'::jsonb,
  'A page holds whole saves, and older ones follow before its oldest'
);

------------------------------------------------------------------------------
-- Outsiders and removed members get nothing.

select pg_temp.act('frank');
select throws_ok($$ select public.list_agent_changes(pg_temp.project()) $$, '42501', 'Project unavailable', 'Someone outside the project cannot list its agent changes');
select throws_ok($$ select public.count_agent_changes(pg_temp.project()) $$, '42501', 'Project unavailable', 'nor count them');
select throws_ok($$ select public.mark_agent_changes_seen(pg_temp.project(), 3) $$, '42501', 'Project unavailable', 'nor mark them seen');
select throws_ok(
  $$ select public.list_agent_changes('aaaaaaaa-0000-4000-8000-000000000099') $$,
  '42501', 'Project unavailable', 'which is what a missing project gets'
);
select pg_temp.act('erin');
select throws_ok($$ select public.list_agent_changes(pg_temp.project()) $$, '42501', 'Project unavailable', 'A removed member cannot list them');
select throws_ok($$ select public.count_agent_changes(pg_temp.project()) $$, '42501', 'Project unavailable', 'nor count them');
select throws_ok($$ select public.mark_agent_changes_seen(pg_temp.project(), 3) $$, '42501', 'Project unavailable', 'nor mark them seen');
select is((select count(*)::int from public.agent_changes_seen), 0, 'and no longer reads the marker she had');
select pg_temp.act('frank', true);
select throws_ok($$ select public.list_agent_changes(pg_temp.project()) $$, '42501', 'Project unavailable', 'An outsider''s agent cannot list them either');

------------------------------------------------------------------------------
-- The seen marker is each person's own.

select pg_temp.act('bob');
select is(public.count_agent_changes(pg_temp.project()), 3, 'Bob has three agent changes new to him');
select is(public.list_agent_changes(pg_temp.project()) -> 'seen', '0'::jsonb, 'before he first looks');
select is(public.mark_agent_changes_seen(pg_temp.project(), 3) -> 'seen', '3'::jsonb, 'He looks, up to the newest');
select is(public.count_agent_changes(pg_temp.project()), 0, 'and none are new to him');
select is(public.mark_agent_changes_seen(pg_temp.project(), 2) -> 'seen', '3'::jsonb, 'An older window does not move his marker back');
select is(
  public.mark_agent_changes_seen(pg_temp.project(), 99) -> 'seen',
  (select to_jsonb(revision) from public.projects where id = pg_temp.project()),
  'nor past the project''s revision'
);
select is(
  (select array_agg(user_id) from public.agent_changes_seen),
  array[pg_temp.id('bob')],
  'He reads his own marker only'
);

select pg_temp.act('alice');
select is(public.count_agent_changes(pg_temp.project()), 3, 'Alice''s count is her own: still three');
select is((select count(*)::int from public.agent_changes_seen), 0, 'and she cannot read Bob''s marker');
select pg_temp.act('alice', true);
select throws_ok(
  $$ select public.mark_agent_changes_seen(pg_temp.project(), 3) $$,
  '42501', 'Only a signed-in person can mark agent changes seen', 'Her agent cannot mark them seen for her'
);
select throws_ok(
  $$ insert into public.agent_changes_seen (project_id, user_id, seen_version) values (pg_temp.project(), pg_temp.id('alice'), 3) $$,
  '42501', null, 'Nobody writes a marker directly'
);

select * from finish();
rollback;
