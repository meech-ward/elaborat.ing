-- Change signals over Realtime Broadcast: what the database queues when a
-- project changes, and who may receive it.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens in
-- one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(20);

-- Realtime keeps these messages in daily partitions of realtime.messages. It
-- creates them when a client connects; realtime.send does not. If this fails,
-- connect any Realtime client to the project and run the tests again.
select ok(
  to_regclass('realtime.messages_' || to_char(localtimestamp, 'YYYY_MM_DD')) is not null,
  'Realtime has created today''s partition of realtime.messages'
);

select policies_are(
  'realtime', 'messages',
  array['People can receive change signals for projects they can read'],
  'The only policy on realtime.messages lets people receive change signals'
);

select function_privs_are(
  'private', 'broadcast_project_change', array[]::text[], 'authenticated', array[]::text[],
  'Signed-in users cannot call the trigger function'
);

select function_privs_are(
  'private', 'broadcast_project_change', array[]::text[], 'anon', array[]::text[],
  'Anonymous users cannot call the trigger function'
);

-- Alice owns a project. Bob has accepted an invitation to it; Carol has one she
-- has not accepted yet; Dave has nothing to do with it.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com');

insert into public.projects (id, owner_id, title) values
  ('eeeeeeee-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Signals');

insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('eeeeeeee-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'viewer', now()),
  ('eeeeeeee-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'viewer', null);

select is(
  (select count(*)::int from realtime.messages where topic = 'project:eeeeeeee-0000-4000-8000-000000000001'),
  0,
  'Nothing is sent until the project changes'
);

-- A save, a rename and an archive each queue one signal with the new revision.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is(
  public.save_files('eeeeeeee-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001',
    '[{"op":"put","path":"a.md","content":"one"}]') ->> 'status',
  'saved',
  'Alice saves a file'
);

reset role;
select is(
  array(select (payload ->> 'revision')::int from realtime.messages
        where topic = 'project:eeeeeeee-0000-4000-8000-000000000001' order by 1),
  array[1],
  'A save queues one signal, on the project''s topic, with the new revision'
);

set local role authenticated;
select is(
  public.save_files('eeeeeeee-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000002',
    '[{"op":"put","path":"a.md","content":"a different first version"}]') ->> 'status',
  'conflict',
  'A save that conflicts changes nothing'
);

select is(
  public.rename_project('eeeeeeee-0000-4000-8000-000000000001', 'Signals, renamed') ->> 'revision',
  '2',
  'Alice renames the project'
);

reset role;
select is(
  array(select (payload ->> 'revision')::int from realtime.messages
        where topic = 'project:eeeeeeee-0000-4000-8000-000000000001' order by 1),
  array[1, 2],
  'A rename queues one signal, and a conflicting save queues none'
);

set local role authenticated;
select is(
  public.archive_project('eeeeeeee-0000-4000-8000-000000000001') ->> 'revision',
  '3',
  'Alice archives the project'
);

select is(
  public.archive_project('eeeeeeee-0000-4000-8000-000000000001') ->> 'revision',
  '3',
  'Archiving it again changes nothing'
);

reset role;
select is(
  array(select (payload ->> 'revision')::int from realtime.messages
        where topic = 'project:eeeeeeee-0000-4000-8000-000000000001' order by 1),
  array[1, 2, 3],
  'An archive queues one signal, and archiving again queues none'
);

-- Realtime adds its own message id to the payload; nothing else is in it.
select is(
  (select count(*)::int from realtime.messages
   where topic = 'project:eeeeeeee-0000-4000-8000-000000000001'
     and event = 'changed'
     and extension = 'broadcast'
     and private
     and payload - 'id' = jsonb_build_object('revision', payload -> 'revision')),
  3,
  'Each signal is a private broadcast named changed, carrying only the revision'
);

-- A presence message on the same topic, to show members receive broadcasts only.
insert into realtime.messages (topic, extension, payload, private)
values ('project:eeeeeeee-0000-4000-8000-000000000001', 'presence', '{}', true);

-- Receiving. Realtime lets someone join a private channel when they can read
-- its messages with realtime.topic() set to the channel's topic.
set local realtime.topic to 'project:eeeeeeee-0000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  (select count(*)::int from realtime.messages
   where topic = 'project:eeeeeeee-0000-4000-8000-000000000001' and extension = 'broadcast'),
  3,
  'The owner can receive the change signals'
);

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select results_eq(
  $$ select extension, count(*)::int from realtime.messages
     where topic = 'project:eeeeeeee-0000-4000-8000-000000000001' group by extension $$,
  $$ values ('broadcast', 3) $$,
  'A member can receive every change signal, and nothing else on the topic'
);

select throws_ok(
  $$ insert into realtime.messages (topic, extension, event, payload, private)
     values ('project:eeeeeeee-0000-4000-8000-000000000001', 'broadcast', 'changed', '{"revision": 99}', true) $$,
  '42501',
  null,
  'A member cannot send on the project''s channel'
);

set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  (select count(*)::int from realtime.messages where topic = 'project:eeeeeeee-0000-4000-8000-000000000001'),
  0,
  'Someone who has not accepted their invitation cannot receive them'
);

set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select is(
  (select count(*)::int from realtime.messages where topic = 'project:eeeeeeee-0000-4000-8000-000000000001'),
  0,
  'A non-member cannot receive them'
);

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select is(
  (select count(*)::int from realtime.messages where topic = 'project:eeeeeeee-0000-4000-8000-000000000001'),
  0,
  'An anonymous caller cannot receive them'
);

select * from finish();
rollback;
