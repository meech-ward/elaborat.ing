-- Agents' names on what they write, and "Ask an agent": who saved each file
-- version, who may ask an agent about a thread, which threads each person's
-- agents are asked about, and replies that link the version an agent saved.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens
-- in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(51);

-- Alice owns the project; Bob is an editor and Dave a viewer, both accepted.
-- Frank has nothing to do with it.
create function pg_temp.id(who text)
returns uuid
language sql
immutable
as $$
  select (case who
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob' then '22222222-2222-4222-8222-222222222222'
    when 'dave' then '44444444-4444-4444-8444-444444444444'
    when 'frank' then '66666666-6666-4666-8666-666666666666'
  end)::uuid
$$;

-- Agents (OAuth clients): one with a name, one without.
create function pg_temp.client(name text)
returns text
language sql
immutable
as $$
  select case name
    when 'named' then 'a9000000-0000-4000-8000-000000000001'
    when 'unnamed' then 'a9000000-0000-4000-8000-000000000002'
    else name
  end
$$;

-- Act as someone, in a person session or through one of their agents.
create function pg_temp.act(who text, client text default null)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    (jsonb_build_object('sub', pg_temp.id(who), 'role', 'authenticated')
      || case when client is not null then jsonb_build_object('client_id', pg_temp.client(client)) else '{}'::jsonb end)::text,
    true
  )
$$;

create function pg_temp.project()
returns uuid
language sql
immutable
as $$ select 'aaaaaaaa-0000-4000-8000-000000000001'::uuid $$;

create function pg_temp.t(n integer)
returns uuid
language sql
immutable
as $$ select ('c0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

create function pg_temp.r(n integer)
returns uuid
language sql
immutable
as $$ select ('c1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;

create function pg_temp.revision()
returns bigint
language sql
as $$ select revision from public.projects where id = pg_temp.project() $$;

create function pg_temp.file_id(file_path text)
returns uuid
language sql
as $$ select id from public.project_files where project_id = pg_temp.project() and path = file_path $$;

create function pg_temp.version(file_path text)
returns bigint
language sql
as $$ select version from public.project_files where project_id = pg_temp.project() and path = file_path $$;

-- Start a thread on a file's whole text, as the caller.
create function pg_temp.start(n integer, file_path text, ask boolean default false)
returns jsonb
language sql
as $$
  select public.add_comment(pg_temp.project(), pg_temp.t(n), pg_temp.file_id(file_path), pg_temp.version(file_path),
    '{"kind": "document"}'::jsonb, 'Thread ' || n, ask)
$$;

-- The thread ids the caller's agent is asked about, in order.
create function pg_temp.asked(since bigint default null)
returns uuid[]
language sql
as $$
  select coalesce(array_agg((t ->> 'id')::uuid order by t ->> 'created_at', t ->> 'id'), '{}')
  from jsonb_array_elements(public.list_comments(pg_temp.project(), null, true, since) -> 'threads') t
$$;

-- A comment as the caller lists it.
create function pg_temp.listed_comment(comment uuid)
returns jsonb
language sql
as $$
  select c
  from jsonb_array_elements(public.list_comments(pg_temp.project()) -> 'threads') t,
       jsonb_array_elements(t -> 'comments') c
  where c ->> 'id' = comment::text
$$;

------------------------------------------------------------------------------
-- Grants.

select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
   where a.attrelid = 'public.file_versions'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.file_versions', a.attname, 'select')),
  array['file_id', 'version', 'project_id', 'path', 'content', 'deleted', 'author_id', 'mutation_id', 'created_at'],
  'Signed-in users select every file history column except the agent''s OAuth client'
);
select function_privs_are('public', 'set_comment_ask_agent', array['uuid', 'boolean'], 'authenticated', array['EXECUTE'], 'Signed-in users can ask an agent');
select function_privs_are('public', 'set_comment_ask_agent', array['uuid', 'boolean'], 'anon', array[]::text[], 'Anonymous users cannot');
select function_privs_are('public', 'list_file_authors', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can list who saved each file');
select function_privs_are('public', 'list_file_authors', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'agent_name'
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'Nobody can look up an agent''s name by its id'
);

------------------------------------------------------------------------------
-- The people, the agents, the project and its files.

insert into auth.users (id, email)
select pg_temp.id(name), name || '@example.com'
from unnest(array['alice', 'bob', 'dave', 'frank']) name;

insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name, token_endpoint_auth_method, client_type)
values
  (pg_temp.client('named')::uuid, 'dynamic', 'https://agent.example/callback', 'authorization_code', E'  Claude \n Code ', 'none', 'public'),
  (pg_temp.client('unnamed')::uuid, 'dynamic', 'https://agent.example/callback', 'authorization_code', null, 'none', 'public');

insert into public.projects (id, owner_id, title) values (pg_temp.project(), pg_temp.id('alice'), 'Shared');
insert into public.project_members (project_id, user_id, role, accepted_at) values
  (pg_temp.project(), pg_temp.id('bob'), 'editor', now()),
  (pg_temp.project(), pg_temp.id('dave'), 'viewer', now());

set local role authenticated;
select pg_temp.act('alice');
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(),
       '[{"op":"put","path":"notes/a.md","content":"A"},{"op":"put","path":"notes/b.md","content":"B"},{"op":"put","path":"notes/c.md","content":"C"}]') $$,
  'Alice saves three notes in the app'
);

------------------------------------------------------------------------------
-- Who saved each version.

select pg_temp.act('alice', 'named');
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(),
       format('[{"op":"put","path":"notes/a.md","content":"A, changed","base_version":%s}]', pg_temp.version('notes/a.md'))::jsonb) $$,
  'Her agent changes notes/a.md'
);
select pg_temp.act('alice', 'unnamed');
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(),
       format('[{"op":"delete","path":"notes/c.md","base_version":%s}]', pg_temp.version('notes/c.md'))::jsonb) $$,
  'Her other agent deletes notes/c.md'
);
select throws_ok(
  $$ select agent_client_id from public.file_versions $$,
  '42501', null, 'Readers cannot select the agent''s client id'
);

reset role;
select is(
  (select array_agg(coalesce(v.agent_client_id, 'app') order by v.version, v.path) from public.file_versions v where v.project_id = pg_temp.project()),
  array['app', 'app', 'app', pg_temp.client('named'), pg_temp.client('unnamed')],
  'Each version records the agent that saved it from its token, and nothing for the app, deletes included'
);

set local role authenticated;
select pg_temp.act('bob');
select is(
  (select jsonb_agg(jsonb_build_object('path', f ->> 'path', 'by', f -> 'author' ->> 'email', 'via_agent', f -> 'via_agent', 'agent', f -> 'agent') order by f ->> 'path')
   from jsonb_array_elements(public.list_file_authors(pg_temp.project())) f),
  '[{"path": "notes/a.md", "by": "alice@example.com", "via_agent": true, "agent": "Claude Code"},
    {"path": "notes/b.md", "by": "alice@example.com", "via_agent": false, "agent": null}]'::jsonb,
  'Another member sees who saved each current file, and the agent''s name when an agent did'
);
select pg_temp.act('frank');
select throws_ok(
  $$ select public.list_file_authors(pg_temp.project()) $$,
  '42501', 'Project unavailable', 'Someone outside the project cannot list who saved its files'
);

------------------------------------------------------------------------------
-- Agents' names on comments.

select pg_temp.act('alice');
select lives_ok($$ select pg_temp.start(1, 'notes/a.md', true) $$, 'Alice starts a thread asking an agent');
select lives_ok($$ select pg_temp.start(2, 'notes/a.md') $$, 'and one that does not');

select pg_temp.act('alice', 'named');
select lives_ok(
  $$ select public.reply_comment(pg_temp.t(1), pg_temp.r(1), 'On it.') $$,
  'Her named agent replies'
);
select pg_temp.act('alice', 'unnamed');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(2), 'Me too.') $$, 'her unnamed agent replies');
select pg_temp.act('alice', 'not-a-client-id');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(3), 'And me.') $$, 'and a client the server does not know replies');

select pg_temp.act('dave');
select is(
  (select jsonb_build_object('via_agent', c -> 'via_agent', 'agent', c -> 'agent', 'by', c -> 'author' ->> 'email') from pg_temp.listed_comment(pg_temp.r(1)) c),
  '{"via_agent": true, "agent": "Claude Code", "by": "alice@example.com"}'::jsonb,
  'A viewer sees the agent''s name, cleaned up, on the comment it wrote for its person'
);
select is(
  (select jsonb_build_array(a -> 'via_agent', a -> 'agent', b -> 'via_agent', b -> 'agent')
   from pg_temp.listed_comment(pg_temp.r(2)) a, pg_temp.listed_comment(pg_temp.r(3)) b),
  '[true, null, true, null]'::jsonb,
  'An agent without a name, or one the server does not know, is still an agent, with no name'
);
select is(
  (select c -> 'agent' from pg_temp.listed_comment((select id from public.comments where thread_id = pg_temp.t(1) and body = 'Thread 1')) c),
  'null'::jsonb,
  'A comment written in the app has no agent'
);

------------------------------------------------------------------------------
-- Who may ask an agent.

select pg_temp.act('alice', 'named');
select throws_ok(
  $$ select pg_temp.start(3, 'notes/a.md', true) $$,
  '42501', 'Only a signed-in person can ask an agent', 'An agent cannot start a thread asking an agent'
);
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(2), true) $$,
  '42501', 'Only a signed-in person can ask an agent', 'nor ask one about its person''s thread'
);

select pg_temp.act('bob');
select lives_ok($$ select pg_temp.start(4, 'notes/b.md', true) $$, 'Bob starts a thread asking his agent');
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(2), true) $$,
  '42501', 'Only the person who started a thread can ask an agent about it', 'An editor cannot ask an agent about someone else''s thread'
);
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(1), false) $$,
  '42501', 'Only the person who started a thread can ask an agent about it', 'nor stop one'
);

select pg_temp.act('alice');
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(4), false) $$,
  '42501', 'Only the person who started a thread can ask an agent about it', 'The owner cannot either, on a thread she did not start'
);

select pg_temp.act('frank');
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(1), false) $$,
  '42501', 'Comment unavailable', 'Someone outside the project gets the answer a missing thread gets'
);
select throws_ok(
  $$ select public.set_comment_ask_agent(pg_temp.t(99), false) $$,
  '42501', 'Comment unavailable', 'which is this'
);

select pg_temp.act('alice');
select set_config('test.revision', pg_temp.revision()::text, true);
select is(
  public.set_comment_ask_agent(pg_temp.t(2), true) -> 'thread' -> 'ask_agent',
  'true'::jsonb,
  'Alice asks an agent about her other thread'
);
select is(pg_temp.revision(), current_setting('test.revision')::bigint + 1, 'and the project revision goes up');
select is(
  public.set_comment_ask_agent(pg_temp.t(2), false) -> 'thread' -> 'ask_agent',
  'false'::jsonb,
  'and stops asking'
);
select set_config('test.revision', pg_temp.revision()::text, true);
select is(
  (select public.set_comment_ask_agent(pg_temp.t(2), false) -> 'revision')::bigint,
  current_setting('test.revision')::bigint,
  'Stopping again changes nothing'
);

------------------------------------------------------------------------------
-- What each person's agents are asked about.

select pg_temp.act('alice', 'named');
select is(pg_temp.asked(), array[pg_temp.t(1)], 'Alice''s agent lists her open thread asking an agent, and nothing else');
select pg_temp.act('bob', 'named');
select is(pg_temp.asked(), array[pg_temp.t(4)], 'Bob''s agent lists only his, never hers');
select pg_temp.act('dave');
select is(pg_temp.asked(), '{}'::uuid[], 'Someone who asked nothing gets nothing');
select pg_temp.act('frank', 'named');
select throws_ok(
  $$ select pg_temp.asked() $$,
  '42501', 'Project unavailable', 'Someone outside the project cannot list'
);
select pg_temp.act('alice', 'named');
select throws_ok(
  $$ select public.list_comments(pg_temp.project(), null, false, 1) $$,
  '22023', 'since works with ask_agent', 'A cursor goes with the ask_agent filter'
);

-- A cursor: the revision the last list returned.
select set_config('test.cursor', (public.list_comments(pg_temp.project(), null, true) ->> 'revision'), true);
select is(pg_temp.asked(current_setting('test.cursor')::bigint), '{}'::uuid[], 'Nothing new since the last list');

select lives_ok(
  $$ select public.reply_comment(pg_temp.t(1), pg_temp.r(4), 'Done.', pg_temp.version('notes/a.md')) $$,
  'The agent answers'
);
select is(pg_temp.asked(current_setting('test.cursor')::bigint), '{}'::uuid[], 'Its own reply does not ask it again');

select pg_temp.act('bob');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(5), 'Looks good to me.') $$, 'Bob replies on Alice''s thread');
select pg_temp.act('alice', 'named');
select is(pg_temp.asked(current_setting('test.cursor')::bigint), '{}'::uuid[], 'Someone else''s reply does not ask her agent again');

select pg_temp.act('alice');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(6), 'Shorter, please.') $$, 'Alice replies in the app');
select pg_temp.act('alice', 'named');
select is(pg_temp.asked(current_setting('test.cursor')::bigint), array[pg_temp.t(1)], 'Her own reply asks her agent again');

select pg_temp.act('alice');
select lives_ok($$ select public.resolve_comment(pg_temp.t(1)) $$, 'Alice resolves it');
select pg_temp.act('alice', 'named');
select is(pg_temp.asked(), '{}'::uuid[], 'A resolved thread is not asked about');

------------------------------------------------------------------------------
-- Replies that link a version.

select is(
  (select c -> 'file_version' from pg_temp.listed_comment(pg_temp.r(4)) c),
  to_jsonb(pg_temp.version('notes/a.md')),
  'The agent''s reply links the version of the file it saved'
);
select pg_temp.act('bob', 'named');
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(4), pg_temp.r(7), 'Linked the wrong file.', pg_temp.version('notes/a.md')) $$,
  '22023', 'No such version of this file', 'A version of another file is refused'
);
select throws_ok(
  $$ select public.reply_comment(pg_temp.t(4), pg_temp.r(8), 'Linked a version to come.', pg_temp.revision() + 1) $$,
  '22023', 'No such version of this file', 'and so is one that does not exist'
);
select is(
  (select public.reply_comment(pg_temp.t(4), pg_temp.r(9), 'Done.', pg_temp.version('notes/b.md')) -> 'comment' -> 'file_version'),
  to_jsonb(pg_temp.version('notes/b.md')),
  'A version of the thread''s own file is linked'
);

select * from finish();
rollback;
