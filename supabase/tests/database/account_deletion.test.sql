-- Deleting your own account (account_deletion.sql): the summary shows only
-- the caller's own projects and memberships, starting a deletion refuses
-- agents and counts at most 5 attempts a UTC day, and the delete path the
-- `delete-account` Edge Function takes (delete_project for each owned
-- project, then the account itself) leaves other people's projects and the
-- person's comments in them, with no author. Run with the Supabase CLI:
-- `supabase test db` (pgTAP). Everything happens in one transaction that is
-- rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

select function_privs_are('public', 'account_deletion_summary', array[]::text[], 'authenticated', array['EXECUTE'], 'Signed-in people can read their summary');
select function_privs_are('public', 'account_deletion_summary', array[]::text[], 'anon', array[]::text[], 'Anonymous users cannot');
select function_privs_are('public', 'begin_account_deletion', array[]::text[], 'authenticated', array['EXECUTE'], 'Signed-in people can start deleting their account');
select function_privs_are('public', 'begin_account_deletion', array[]::text[], 'anon', array[]::text[], 'Anonymous users cannot');

-- Alice owns Team (Bob has accepted it, Carol is only invited) and Solo. Bob
-- owns Bobs, which Alice has accepted, and Later, where she is only invited.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com');
insert into public.projects (id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Team'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'solo'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Bobs'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Later');
insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'viewer', null),
  ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'commenter', now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'viewer', null);
insert into public.project_files (id, project_id, path, content, version, updated_by) values
  ('f0000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'plan.md', 'Plan', 1, '22222222-2222-4222-8222-222222222222');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is(
  public.account_deletion_summary(),
  '{"owned": [
     {"id": "aaaaaaaa-0000-4000-8000-000000000002", "title": "solo", "archived": false, "members": 0},
     {"id": "aaaaaaaa-0000-4000-8000-000000000001", "title": "Team", "archived": false, "members": 1}
   ], "shared": 1}'::jsonb,
  'Alice sees the projects she owns, with the people who accepted each, and the one shared project she accepted'
);

-- Alice comments on Bob's project, where she is a commenter.
select lives_ok(
  $$ select public.add_comment('bbbbbbbb-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
       'f0000000-0000-4000-8000-000000000001', 1, '{"kind": "document"}', 'Looks good') $$,
  'Alice comments on Bob''s project'
);

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(
  public.account_deletion_summary(),
  '{"owned": [
     {"id": "bbbbbbbb-0000-4000-8000-000000000001", "title": "Bobs", "archived": false, "members": 1},
     {"id": "bbbbbbbb-0000-4000-8000-000000000002", "title": "Later", "archived": false, "members": 0}
   ], "shared": 1}'::jsonb,
  'Bob sees only his own projects and memberships'
);

-- Only a person starts deleting their account, never their agent.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"agent-client"}';
select throws_ok(
  $$ select public.begin_account_deletion() $$,
  '42501', 'Only a signed-in person can delete their account', 'An agent cannot start deleting the account'
);
select throws_ok(
  $$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000002') $$,
  '42501', null, 'Nor delete a project on the way'
);

set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(public.begin_account_deletion() -> 'owned' -> 1 ->> 'title', 'Team', 'Alice starts, and gets the projects to delete');
select lives_ok($$ select public.begin_account_deletion() $$, 'A second attempt the same day');
select lives_ok($$ select public.begin_account_deletion() $$, 'A third');
select lives_ok($$ select public.begin_account_deletion() $$, 'A fourth');
select lives_ok($$ select public.begin_account_deletion() $$, 'A fifth');
select throws_ok(
  $$ select public.begin_account_deletion() $$,
  'PT429', null, 'A sixth attempt the same day is refused'
);
select throws_like(
  $$ select public.begin_account_deletion() $$,
  'You have reached the limit of 5 account deletion attempts a day. Try again in %', 'and says when to try again'
);

-- The function's path: each owned project through delete_project, as Alice.
select lives_ok($$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Alice deletes Team');
select lives_ok($$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000002') $$, 'Alice deletes solo');
select is(public.account_deletion_summary() -> 'owned', '[]'::jsonb, 'Alice owns nothing now');

-- Then Auth's admin API deletes the account.
reset role;
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';

select is(
  (select count(*)::integer from public.project_members where user_id = '11111111-1111-4111-8111-111111111111'),
  0, 'Alice has left Bobs and declined Later'
);
select is(
  (select count(*)::integer from private.limit_counters where user_id = '11111111-1111-4111-8111-111111111111'),
  0, 'Her limit counters are gone'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(
  (select count(*)::integer from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  0, 'Bob no longer has Team'
);
select is(
  public.account_deletion_summary(),
  '{"owned": [
     {"id": "bbbbbbbb-0000-4000-8000-000000000001", "title": "Bobs", "archived": false, "members": 0},
     {"id": "bbbbbbbb-0000-4000-8000-000000000002", "title": "Later", "archived": false, "members": 0}
   ], "shared": 0}'::jsonb,
  'Bob keeps his own projects, now with no members'
);
select is(
  public.list_comments('bbbbbbbb-0000-4000-8000-000000000001') -> 'threads' -> 0 -> 'comments' -> 0 -> 'author',
  'null'::jsonb,
  'Alice''s comment on Bob''s project stays, with no author'
);
select is(
  public.list_comments('bbbbbbbb-0000-4000-8000-000000000001') -> 'threads' -> 0 -> 'comments' -> 0 ->> 'body',
  'Looks good',
  'and keeps its words'
);

select * from finish();
rollback;
