-- Sharing by email (email_invitations.sql): only the service role, which the
-- `share` Edge Function uses after checking its caller, may look up an account
-- by email or record an invitation for a new account, only for a project the
-- named inviter owns, and at most 50 times a UTC day per inviter. Run with the
-- Supabase CLI: `supabase test db` (pgTAP). Everything happens in one
-- transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

select function_privs_are('public', 'prepare_email_invitation', array['uuid', 'uuid', 'text'], 'service_role', array['EXECUTE'], 'The service role can prepare an invitation');
select function_privs_are('public', 'prepare_email_invitation', array['uuid', 'uuid', 'text'], 'authenticated', array[]::text[], 'Signed-in users cannot prepare an invitation');
select function_privs_are('public', 'prepare_email_invitation', array['uuid', 'uuid', 'text'], 'anon', array[]::text[], 'Anonymous users cannot prepare an invitation');
select function_privs_are('private', 'prepare_email_invitation', array['uuid', 'uuid', 'text'], 'authenticated', array[]::text[], 'Signed-in users cannot call the private function either');
select function_privs_are('public', 'record_email_invitation', array['uuid', 'uuid', 'uuid', 'text'], 'service_role', array['EXECUTE'], 'The service role can record an invitation');
select function_privs_are('public', 'record_email_invitation', array['uuid', 'uuid', 'uuid', 'text'], 'authenticated', array[]::text[], 'Signed-in users cannot record an invitation');
select function_privs_are('public', 'record_email_invitation', array['uuid', 'uuid', 'uuid', 'text'], 'anon', array[]::text[], 'Anonymous users cannot record an invitation');
select function_privs_are('private', 'record_email_invitation', array['uuid', 'uuid', 'uuid', 'text'], 'authenticated', array[]::text[], 'Signed-in users cannot call the private function either');

-- Alice owns a project. Bob has an account. Erin owns nothing of hers.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'erin@example.com');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes') $$, 'Alice creates a project');

-- Alice cannot call them herself, not even for her own project.
select throws_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'bob@example.com') $$,
  '42501', null, 'A signed-in owner cannot look up an account by email'
);
select throws_ok(
  $$ select public.record_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor') $$,
  '42501', null, 'A signed-in owner cannot record an invitation directly'
);

reset role;
set local role service_role;
set local request.jwt.claims to '{"role":"service_role"}';

select is(
  public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'BOB@Example.com'),
  '{"member_id": "22222222-2222-4222-8222-222222222222", "title": "Notes", "inviter_email": "alice@example.com"}'::jsonb,
  'An email with an account gives that account, whatever its case, with the title and the inviter''s email'
);
select is(
  public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'new@example.com') -> 'member_id',
  'null'::jsonb,
  'An email without an account gives no account'
);
select throws_ok(
  $$ select public.prepare_email_invitation('55555555-5555-4555-8555-555555555555', 'aaaaaaaa-0000-4000-8000-000000000001', 'bob@example.com') $$,
  '42501', 'Only the project owner can change sharing', 'Someone who does not own the project cannot invite to it'
);
select throws_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com') $$,
  '22023', 'You own this project already', 'The owner cannot invite herself'
);
select throws_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'not an email') $$,
  '22023', 'Enter an email address', 'Something that is not an email is refused'
);

-- Auth has created an account for new@example.com; the invitation is recorded for it.
reset role;
insert into auth.users (id, email) values ('66666666-6666-4666-8666-666666666666', 'new@example.com');
set local role service_role;
select throws_ok(
  $$ select public.record_email_invitation('55555555-5555-4555-8555-555555555555', 'aaaaaaaa-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'viewer') $$,
  '42501', 'Only the project owner can change sharing', 'An invitation is recorded only for the project''s owner'
);
select throws_ok(
  $$ select public.record_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'owner') $$,
  '22023', 'Role must be viewer, commenter or editor', 'Only the three member roles can be given'
);
select lives_ok(
  $$ select public.record_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'editor') $$,
  'The service role records the invitation for the new account'
);

-- The new account sees it once signed in, has no access yet, and accepts it.
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}';
select is(
  (select jsonb_agg(jsonb_build_array(i ->> 'title', i ->> 'role')) from jsonb_array_elements(public.list_invitations()) i),
  '[["Notes", "editor"]]'::jsonb,
  'The invited account sees the invitation'
);
select is(public.read_project('aaaaaaaa-0000-4000-8000-000000000001'), null, 'An invitation grants nothing until accepted');
select is(
  public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') ->> 'role',
  'editor',
  'The invited account accepts and becomes an editor'
);

-- The limit: 50 a day per inviter, counted in the shared per-user counters.
-- Alice has invited two so far today; make it 49.
reset role;
update private.limit_counters set uses = 49
where user_id = '11111111-1111-4111-8111-111111111111' and name = 'invitations_per_day';
set local role service_role;
select lives_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'fifty@example.com') $$,
  'The 50th invitation of the day is allowed'
);
select throws_like(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'fifty-one@example.com') $$,
  'You have reached the limit of 50 invitations a day. Try again in %',
  'The 51st is refused with a message that says when to try again'
);
select throws_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'fifty-one@example.com') $$,
  'PT429', null, 'as a per-account limit (HTTP 429)'
);
reset role;
select is(
  (select uses from private.limit_counters where user_id = '11111111-1111-4111-8111-111111111111' and name = 'invitations_per_day'),
  50,
  'Refused invitations do not count'
);

-- Yesterday's invitations do not count today.
update private.limit_counters set window_start = window_start - interval '1 day'
where user_id = '11111111-1111-4111-8111-111111111111' and name = 'invitations_per_day';
set local role service_role;
select lives_ok(
  $$ select public.prepare_email_invitation('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'next-day@example.com') $$,
  'A new day starts a new count'
);
reset role;
select is(
  (select count(*)::int from private.limit_counters where user_id = '55555555-5555-4555-8555-555555555555' and name = 'invitations_per_day'),
  0,
  'A refused non-owner uses none of their own'
);

select * from finish();
rollback;
