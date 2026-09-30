-- MCP Events: who can see and change event subscriptions, which comments
-- queue an event for whose subscription, what is checked again when an event
-- is delivered, and where the signing secrets live.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens
-- in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(98);

-- Alice owns the project; Bob is an editor. Frank has nothing to do with it.
-- Each has an agent connected (Claude); Alice also has a second one.
create function pg_temp.id(who text)
returns uuid
language sql
immutable
as $$
  select (case who
    when 'alice' then '11111111-1111-4111-8111-111111111111'
    when 'bob' then '22222222-2222-4222-8222-222222222222'
    when 'frank' then '66666666-6666-4666-8666-666666666666'
  end)::uuid
$$;

create function pg_temp.client(name text)
returns text
language sql
immutable
as $$
  select case name
    when 'claude' then 'a9000000-0000-4000-8000-000000000001'
    when 'other' then 'a9000000-0000-4000-8000-000000000002'
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

create function pg_temp.sub(n integer)
returns text
language sql
immutable
as $$ select 'sub_' || lpad(n::text, 24, 'x') $$;

create function pg_temp.secret(fill text)
returns text
language sql
immutable
as $$ select 'whsec_' || encode(convert_to(repeat(fill, 32), 'UTF8'), 'base64') $$;

create function pg_temp.file_id(file_path text)
returns uuid
language sql
as $$ select id from public.project_files where project_id = pg_temp.project() and path = file_path $$;

-- Start a thread on a file's whole text, as the caller.
create function pg_temp.start(n integer, file_path text, ask boolean default false)
returns jsonb
language sql
as $$
  select public.add_comment(pg_temp.project(), pg_temp.t(n),
    (select id from public.project_files where project_id = pg_temp.project() and path = file_path),
    (select version from public.project_files where project_id = pg_temp.project() and path = file_path),
    '{"kind": "document"}'::jsonb, 'Thread ' || n, ask)
$$;

-- Save a subscription, as the MCP server does once the callback answered.
create function pg_temp.subscribe(n integer, who text, client text, file_path text default null,
  url text default 'https://receiver.example.com/cb', key text default null, ttl_ms bigint default null, verified boolean default true)
returns jsonb
language sql
as $$
  select public.save_event_subscription(pg_temp.id(who), pg_temp.client(client), pg_temp.sub(n), pg_temp.project(), file_path,
    url, jsonb_build_object('project_id', pg_temp.project())
      || case when file_path is null then '{}'::jsonb else jsonb_build_object('path', file_path) end,
    coalesce(key, pg_temp.secret('k')), ttl_ms, verified)
$$;

-- Events queued for a subscription, and all of them.
create function pg_temp.queued(n integer)
returns bigint
language sql
as $$ select count(*) from pgmq.q_comment_events where message ->> 'subscriptionId' = pg_temp.sub(n) $$;

create function pg_temp.queued_total()
returns bigint
language sql
as $$ select count(*) from pgmq.q_comment_events $$;

create function pg_temp.requests()
returns bigint
language sql
as $$ select count(*) from net.http_request_queue $$;

-- What delivery would send now for the event queued for this subscription and comment.
create function pg_temp.delivery(n integer, comment uuid)
returns jsonb
language sql
as $$ select private.comment_event_delivery(pg_temp.sub(n), comment) $$;

-- Comments written in one transaction share a time, so the opening comment is
-- the one that is not a reply (pg_temp.r).
create function pg_temp.opening(n integer)
returns uuid
language sql
as $$ select id from public.comments where thread_id = pg_temp.t(n) and id::text not like 'c1000000-%' $$;

------------------------------------------------------------------------------
-- Grants.

select is(
  (select array_agg(a.attname::text order by a.attnum) from pg_attribute a
   where a.attrelid = 'public.event_subscriptions'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.event_subscriptions', a.attname, 'select')),
  array['id', 'user_id', 'client_id', 'event', 'arguments', 'project_id', 'file_id', 'expires_at', 'created_at', 'refreshed_at', 'delivery_failed_at'],
  'Signed-in users select every column except the callback, the secrets and when it was verified'
);
select is(
  (select count(*)::int from unnest(array['INSERT', 'UPDATE', 'DELETE']) p
   where has_table_privilege('authenticated', 'public.event_subscriptions', p) or has_table_privilege('anon', 'public.event_subscriptions', p)),
  0,
  'Nobody writes subscriptions through the API'
);
select is(
  (select count(*)::int from pg_attribute a
   where a.attrelid = 'public.event_subscriptions'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('anon', 'public.event_subscriptions', a.attname, 'select')),
  0,
  'Anonymous users select nothing'
);
select function_privs_are('public', 'save_event_subscription', array['uuid', 'text', 'text', 'uuid', 'text', 'text', 'jsonb', 'text', 'bigint', 'boolean'], 'authenticated', array[]::text[], 'Signed-in users cannot save a subscription');
select function_privs_are('public', 'save_event_subscription', array['uuid', 'text', 'text', 'uuid', 'text', 'text', 'jsonb', 'text', 'bigint', 'boolean'], 'service_role', array['EXECUTE'], 'only the service role can');
select function_privs_are('public', 'prepare_event_subscription', array['uuid', 'text', 'text', 'uuid', 'text', 'text'], 'authenticated', array[]::text[], 'Signed-in users cannot prepare one');
select function_privs_are('public', 'delete_event_subscription', array['uuid', 'text'], 'authenticated', array[]::text[], 'or delete one by id');
select function_privs_are('public', 'delete_event_subscription', array['uuid', 'text'], 'anon', array[]::text[], 'nor can anonymous users');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('comment_event_delivery', 'queue_comment_events', 'sweep_comment_events', 'wake_event_sender',
                       'agent_connected', 'person_can_read_project', 'forget_event_subscription_secrets',
                       'prepare_event_subscription', 'save_event_subscription', 'delete_event_subscription')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  0,
  'None of the private event functions can be called by people or agents'
);

------------------------------------------------------------------------------
-- The people, their agents, the project and its files.

insert into auth.users (id, email)
select pg_temp.id(name), name || '@example.com'
from unnest(array['alice', 'bob', 'frank']) name;

insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name, token_endpoint_auth_method, client_type)
values
  (pg_temp.client('claude')::uuid, 'dynamic', 'https://agent.example/callback', 'authorization_code', 'Claude', 'none', 'public'),
  (pg_temp.client('other')::uuid, 'dynamic', 'https://agent.example/callback', 'authorization_code', 'Other', 'none', 'public');

insert into auth.oauth_consents (id, user_id, client_id, scopes)
values
  (gen_random_uuid(), pg_temp.id('alice'), pg_temp.client('claude')::uuid, 'email'),
  (gen_random_uuid(), pg_temp.id('alice'), pg_temp.client('other')::uuid, 'email'),
  (gen_random_uuid(), pg_temp.id('bob'), pg_temp.client('claude')::uuid, 'email');

insert into public.projects (id, owner_id, title) values (pg_temp.project(), pg_temp.id('alice'), 'Shared');
insert into public.project_members (project_id, user_id, role, accepted_at) values
  (pg_temp.project(), pg_temp.id('bob'), 'editor', now());

-- The sender is woken only once the project URL and key are in Vault.
select vault.create_secret('https://project.example.test', 'project_url')
where not exists (select 1 from vault.secrets where name = 'project_url');
select vault.create_secret('a-test-key', 'embed_secret_key')
where not exists (select 1 from vault.secrets where name = 'embed_secret_key');

set local role authenticated;
select pg_temp.act('alice');
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(),
       '[{"op":"put","path":"notes/a.md","content":"A"},{"op":"put","path":"notes/b.md","content":"B"}]') $$,
  'Alice saves two notes'
);
reset role;

------------------------------------------------------------------------------
-- Subscribing (the service role, as the MCP server calls it).

set local role service_role;
select throws_ok(
  $$ select public.prepare_event_subscription(pg_temp.id('frank'), pg_temp.client('claude'), pg_temp.sub(90), pg_temp.project(), null, 'https://receiver.example.com/cb') $$,
  '42501', 'Project unavailable', 'Someone outside the project cannot watch it'
);
select throws_ok(
  $$ select public.prepare_event_subscription(pg_temp.id('alice'), pg_temp.client('claude'), pg_temp.sub(90), pg_temp.project(), 'notes/missing.md', 'https://receiver.example.com/cb') $$,
  '22023', 'No such file in this project', 'A file that is not in the project cannot be watched'
);
select throws_ok(
  $$ select pg_temp.subscribe(1, 'alice', 'claude', verified => false) $$,
  '22023', 'The callback has not been verified', 'A callback that never answered the challenge is not saved'
);
select ok(
  (pg_temp.subscribe(1, 'alice', 'claude', ttl_ms => 3600000) ->> 'expires_at')::timestamptz between now() + interval '59 minutes' and now() + interval '61 minutes',
  'Alice''s agent watches the project for the hour it asked for'
);
select lives_ok($$ select pg_temp.subscribe(2, 'alice', 'claude', 'notes/b.md', verified => false) $$,
  'and notes/b.md, with the callback it verified a moment ago'
);
select lives_ok($$ select pg_temp.subscribe(3, 'bob', 'claude') $$, 'Bob''s agent watches the project');
select is(
  public.prepare_event_subscription(pg_temp.id('alice'), pg_temp.client('other'), pg_temp.sub(91), pg_temp.project(), null, 'https://receiver.example.com/cb') ->> 'verified',
  'false',
  'Another agent of hers has to verify the same callback itself'
);
reset role;

select ok(
  (select expires_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' from public.event_subscriptions where id = pg_temp.sub(3)),
  'Asking for no lifetime gets 7 days'
);
select is(
  (select file_id from public.event_subscriptions where id = pg_temp.sub(2)),
  pg_temp.file_id('notes/b.md'),
  'A watched file is kept by its id, so the watch follows a rename'
);
select is(
  (select count(*) from vault.decrypted_secrets d join public.event_subscriptions s on s.secret_id = d.id
   where d.decrypted_secret = pg_temp.secret('k')),
  3::bigint,
  'Each signing secret is in Vault'
);

------------------------------------------------------------------------------
-- Refreshing a watch on a file that was renamed.

set local role authenticated;
select pg_temp.act('alice');
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(), '[{"op":"put","path":"notes/c.md","content":"C"}]') $$,
  'Alice saves notes/c.md'
);
reset role;
select set_config('test.file_c', pg_temp.file_id('notes/c.md')::text, true);
set local role service_role;
select lives_ok($$ select pg_temp.subscribe(20, 'alice', 'claude', 'notes/c.md') $$, 'Her agent watches it');
reset role;
set local role authenticated;
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(), jsonb_build_array(jsonb_build_object(
       'op', 'move', 'path', 'notes/c.md', 'to', 'notes/d.md',
       'base_version', (select version from public.project_files where project_id = pg_temp.project() and path = 'notes/c.md')))) $$,
  'She renames it to notes/d.md'
);
reset role;
set local role service_role;
select lives_ok($$ select pg_temp.subscribe(20, 'alice', 'claude', 'notes/c.md') $$,
  'Her agent refreshes the watch with the path it subscribed with');
select throws_ok(
  $$ select public.prepare_event_subscription(pg_temp.id('bob'), pg_temp.client('claude'), pg_temp.sub(20), pg_temp.project(), 'notes/c.md', 'https://receiver.example.com/cb') $$,
  '22023', 'No such file in this project', 'Someone else using that subscription''s id still needs the file to exist'
);
reset role;
select is((select file_id::text from public.event_subscriptions where id = pg_temp.sub(20)), current_setting('test.file_c'),
  'The refreshed watch is still on the renamed file');
set local role authenticated;
select lives_ok(
  $$ select public.save_files(pg_temp.project(), gen_random_uuid(), '[{"op":"put","path":"notes/c.md","content":"Another C"}]') $$,
  'She saves a new notes/c.md'
);
reset role;
set local role service_role;
select lives_ok($$ select pg_temp.subscribe(20, 'alice', 'claude', 'notes/c.md') $$, 'Her agent refreshes again');
reset role;
select is((select file_id::text from public.event_subscriptions where id = pg_temp.sub(20)), current_setting('test.file_c'),
  'and the watch stays on the renamed file, not the new one at its old path');
delete from public.event_subscriptions where id = pg_temp.sub(20);

------------------------------------------------------------------------------
-- Who sees subscriptions.

set local role authenticated;
select pg_temp.act('alice');
select set_eq($$ select id from public.event_subscriptions $$, array[pg_temp.sub(1), pg_temp.sub(2)], 'Alice sees her own subscriptions');
select pg_temp.act('alice', 'other');
select set_eq($$ select id from public.event_subscriptions $$, array[pg_temp.sub(1), pg_temp.sub(2)], 'and so does her other agent, as her');
select pg_temp.act('bob');
select set_eq($$ select id from public.event_subscriptions $$, array[pg_temp.sub(3)], 'Bob sees only his');
select pg_temp.act('frank');
select is_empty($$ select id from public.event_subscriptions $$, 'Frank sees none');
select pg_temp.act('alice');
select throws_ok($$ select callback_url from public.event_subscriptions $$, '42501', null, 'Nobody reads a callback through the API');
select throws_ok($$ select decrypted_secret from vault.decrypted_secrets $$, '42501', null, 'or a secret');
select throws_ok(
  $$ update public.event_subscriptions set expires_at = now() + interval '1 year' $$,
  '42501', null, 'Alice cannot change her subscription directly'
);
select throws_ok($$ delete from public.event_subscriptions $$, '42501', null, 'or delete it');
select throws_ok(
  $$ select public.save_event_subscription(pg_temp.id('alice'), pg_temp.client('claude'), pg_temp.sub(4), pg_temp.project(), null,
       'https://receiver.example.com/cb', '{}', pg_temp.secret('k'), null, true) $$,
  '42501', null, 'or save one herself, skipping the challenge'
);
reset role;

------------------------------------------------------------------------------
-- Which comments queue an event, for whom.

select set_config('test.requests', pg_temp.requests()::text, true);
set local role authenticated;
select pg_temp.act('alice');
select lives_ok($$ select pg_temp.start(1, 'notes/a.md', true) $$, 'Alice starts a thread on notes/a.md asking an agent');
reset role;
select is(pg_temp.queued(1), 1::bigint, 'It queues an event for her project watch');
select is(pg_temp.queued(2), 0::bigint, 'but not for her watch on notes/b.md');
select is(pg_temp.queued(3), 0::bigint, 'nor for Bob''s agent');
select is(pg_temp.requests() - current_setting('test.requests')::bigint, 1::bigint, 'and wakes the sender once');

select set_config('test.requests', pg_temp.requests()::text, true);
select set_config('test.queued', pg_temp.queued_total()::text, true);
set local role authenticated;
select lives_ok($$ select pg_temp.start(2, 'notes/a.md') $$, 'A thread she does not ask an agent about');
select pg_temp.act('alice', 'claude');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(1), 'Done, in version 2.') $$, 'her agent''s reply on her asked thread');
select pg_temp.act('bob');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(2), 'I agree.') $$, 'Bob''s reply on her asked thread');
reset role;
select is(pg_temp.queued_total() - current_setting('test.queued')::bigint, 0::bigint,
  'None of these queue anything: not asked, written by an agent, or someone else''s comment');
select is(pg_temp.requests() - current_setting('test.requests')::bigint, 0::bigint, 'and the sender is not woken');

set local role authenticated;
select pg_temp.act('bob');
select lives_ok($$ select pg_temp.start(3, 'notes/a.md', true) $$, 'Bob starts his own thread asking an agent');
reset role;
select is(pg_temp.queued(3), 1::bigint, 'It queues an event for his agent');
select is(pg_temp.queued(1) + pg_temp.queued(2), 1::bigint, 'and none more for Alice''s');

set local role authenticated;
select pg_temp.act('alice');
select lives_ok($$ select public.reply_comment(pg_temp.t(1), pg_temp.r(3), 'Also the dates, please.') $$,
  'Alice replies on her own asked thread');
reset role;
select is(pg_temp.queued(1), 2::bigint, 'Her reply asks again, so it queues an event');
select is(pg_temp.queued(3), 1::bigint, 'still nothing for Bob''s agent');

set local role authenticated;
select lives_ok($$ select pg_temp.start(4, 'notes/b.md', true) $$, 'She asks about notes/b.md');
reset role;
select is(pg_temp.queued(1) + pg_temp.queued(2), 4::bigint, 'It queues an event for her project watch and her notes/b.md watch');

set local role authenticated;
select lives_ok($$ select public.resolve_comment(pg_temp.t(4)) $$, 'She resolves that thread');
select lives_ok($$ select public.reply_comment(pg_temp.t(4), pg_temp.r(4), 'A note for later.') $$, 'and replies on it');
reset role;
select is(pg_temp.queued(1) + pg_temp.queued(2), 4::bigint, 'A reply on a resolved thread queues nothing');

update public.event_subscriptions set expires_at = now() - interval '1 second' where id = pg_temp.sub(2);
update public.event_subscriptions set delivery_failed_at = now() where id = pg_temp.sub(3);
set local role authenticated;
select lives_ok($$ select pg_temp.start(5, 'notes/b.md', true) $$, 'Alice asks about notes/b.md again');
select pg_temp.act('bob');
select lives_ok($$ select pg_temp.start(6, 'notes/b.md', true) $$, 'and so does Bob');
reset role;
select is(pg_temp.queued(2), 1::bigint, 'An expired watch gets nothing new');
select is(pg_temp.queued(3), 1::bigint, 'nor does one whose deliveries failed');
update public.event_subscriptions set delivery_failed_at = null where id = pg_temp.sub(3);

------------------------------------------------------------------------------
-- Turning Ask an agent on for a thread that exists.

set local role authenticated;
select pg_temp.act('alice');
select lives_ok($$ select public.reply_comment(pg_temp.t(2), pg_temp.r(10), 'And the summary.') $$,
  'Alice replies on her thread that does not ask an agent');
select pg_temp.act('alice', 'claude');
select lives_ok($$ select public.reply_comment(pg_temp.t(2), pg_temp.r(11), 'Noted.') $$, 'then her agent does');
select pg_temp.act('bob');
select lives_ok($$ select public.reply_comment(pg_temp.t(2), pg_temp.r(12), 'Me too.') $$, 'and Bob');
reset role;
-- One transaction gives them all the same time: space them a minute apart, in order.
update public.comments c
set created_at = now() - interval '1 minute' * (3 - coalesce(array_position(array[pg_temp.r(10), pg_temp.r(11), pg_temp.r(12)], c.id), 0))
where c.thread_id = pg_temp.t(2);
select set_config('test.requests', pg_temp.requests()::text, true);
select set_config('test.queued1', pg_temp.queued(1)::text, true);
select set_config('test.queued3', pg_temp.queued(3)::text, true);
set local role authenticated;
select pg_temp.act('alice');
select lives_ok($$ select public.set_comment_ask_agent(pg_temp.t(2), true) $$, 'Alice turns Ask an agent on for it');
reset role;
select is(pg_temp.queued(1) - current_setting('test.queued1')::bigint, 1::bigint, 'It queues an event for her project watch');
select is(
  (select message ->> 'commentId' from pgmq.q_comment_events
   where message ->> 'subscriptionId' = pg_temp.sub(1) order by msg_id desc limit 1),
  pg_temp.r(10)::text,
  'with her latest comment on the thread as a person, not her agent''s or Bob''s'
);
select is(pg_temp.queued(3) - current_setting('test.queued3')::bigint, 0::bigint, 'Bob''s agent gets nothing');
select is(pg_temp.requests() - current_setting('test.requests')::bigint, 1::bigint, 'and the sender is woken once');
select is(pg_temp.delivery(1, pg_temp.r(10)) ->> 'deliver', 'true', 'Delivery checks it again and sends it');

select set_config('test.queued', pg_temp.queued_total()::text, true);
set local role authenticated;
select lives_ok($$ select public.set_comment_ask_agent(pg_temp.t(2), false) $$, 'She turns it off');
select lives_ok($$ select public.set_comment_ask_agent(pg_temp.t(4), false) $$, 'and off for her resolved thread');
select lives_ok($$ select public.set_comment_ask_agent(pg_temp.t(4), true) $$, 'then on again');
reset role;
select is(pg_temp.queued_total() - current_setting('test.queued')::bigint, 0::bigint,
  'Turning it off queues nothing, and neither does turning it on for a resolved thread');

------------------------------------------------------------------------------
-- What delivery checks again.

select is(
  pg_temp.delivery(1, pg_temp.opening(1)) - 'timestamp',
  jsonb_build_object(
    'deliver', true,
    'url', 'https://receiver.example.com/cb',
    'secrets', jsonb_build_array(pg_temp.secret('k')),
    'data', jsonb_build_object(
      'project_id', pg_temp.project(), 'path', 'notes/a.md', 'thread_id', pg_temp.t(1),
      'comment_id', pg_temp.opening(1), 'quote', '', 'text', 'Thread 1'
    )
  ),
  'A matching event is sent to the callback, signed with its secret, with the thread and a short excerpt'
);
select is(pg_temp.delivery(1, pg_temp.r(1)) ->> 'reason', 'not_asked', 'An agent''s reply is never delivered, even if it was queued');
select is(pg_temp.delivery(1, pg_temp.r(2)) ->> 'reason', 'not_asked', 'nor another person''s comment');
select is(pg_temp.delivery(3, pg_temp.opening(1)) ->> 'reason', 'not_asked', 'nor her comment to his agent');
select is(pg_temp.delivery(2, pg_temp.opening(1)) ->> 'reason', 'expired', 'An expired watch gets nothing');

update public.comment_threads set resolved_at = now() where id = pg_temp.t(1);
select is(pg_temp.delivery(1, pg_temp.r(3)) ->> 'reason', 'not_asked', 'A thread resolved before delivery is not sent');
update public.comment_threads set resolved_at = null where id = pg_temp.t(1);

set local role service_role;
select lives_ok($$ select pg_temp.subscribe(1, 'alice', 'claude', key => pg_temp.secret('n'), verified => false) $$,
  'Alice''s agent refreshes its watch with a new secret');
reset role;
select is(
  pg_temp.delivery(1, pg_temp.opening(1)) -> 'secrets',
  jsonb_build_array(pg_temp.secret('n'), pg_temp.secret('k')),
  'For a while, events are signed with the new secret and the old one'
);
update public.event_subscriptions set previous_secret_until = now() - interval '1 second' where id = pg_temp.sub(1);
select is(pg_temp.delivery(1, pg_temp.opening(1)) -> 'secrets', jsonb_build_array(pg_temp.secret('n')), 'then with the new one only');

delete from public.project_members where project_id = pg_temp.project() and user_id = pg_temp.id('bob');
select is(pg_temp.delivery(3, pg_temp.opening(3)) ->> 'reason', 'no_access', 'Someone who lost the project gets nothing');
select is((select count(*) from public.event_subscriptions where id = pg_temp.sub(3)), 0::bigint, 'and their watch is removed');
select is(
  (select count(*) from vault.secrets where description = 'MCP Events signing secret'),
  (select count(*) + count(previous_secret_id) from public.event_subscriptions),
  'with its secret: Vault holds only the secrets of watches that exist'
);

update auth.oauth_consents set revoked_at = now() where user_id = pg_temp.id('alice') and client_id = pg_temp.client('claude')::uuid;
select is(pg_temp.delivery(1, pg_temp.opening(1)) ->> 'reason', 'agent_disconnected', 'An agent its person disconnected gets nothing');
select is((select count(*) from public.event_subscriptions where id = pg_temp.sub(1)), 0::bigint, 'and that watch is removed');

------------------------------------------------------------------------------
-- The once-a-minute sweep, and the cap.

set local role service_role;
select lives_ok($$ select pg_temp.subscribe(10, 'alice', 'other', ttl_ms => 1) $$, 'Her other agent watches for the shortest time');
reset role;
select ok(
  (select expires_at between now() + interval '9 minutes' and now() + interval '11 minutes' from public.event_subscriptions where id = pg_temp.sub(10)),
  'which is 10 minutes'
);
delete from pgmq.q_comment_events;
select set_config('test.requests', pg_temp.requests()::text, true);
update public.event_subscriptions set expires_at = now() - interval '1 second' where id = pg_temp.sub(10);
select private.sweep_comment_events();
select is((select count(*) from public.event_subscriptions where id = pg_temp.sub(10)), 0::bigint, 'The sweep removes expired watches');
select is(pg_temp.requests() - current_setting('test.requests')::bigint, 0::bigint, 'and with nothing due, calls no function');
select pgmq.send('comment_events', '{"subscriptionId": "sub_none", "commentId": "c", "eventId": "evt_x"}'::jsonb);
select private.sweep_comment_events();
select is(pg_temp.requests() - current_setting('test.requests')::bigint, 1::bigint, 'With an event due, it wakes the sender');

set local role service_role;
select lives_ok(
  $$ select pg_temp.subscribe(100 + n, 'alice', 'other', url => 'https://receiver.example.com/cb/' || n) from generate_series(1, 20) n $$,
  'Alice can have 20 subscriptions'
);
select throws_ok(
  $$ select pg_temp.subscribe(200, 'alice', 'other', url => 'https://receiver.example.com/cb/200') $$,
  '54000', 'A person can have at most 20 event subscriptions', 'but not 21'
);
select lives_ok($$ select pg_temp.subscribe(101, 'alice', 'other', url => 'https://receiver.example.com/cb/1') $$, 'Refreshing one of them still works');
reset role;

select * from finish();
rollback;
