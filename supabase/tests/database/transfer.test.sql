-- Handing a project to one of its members (transfer_project): only the owner,
-- only a signed-in person (never an agent), only to a member who has
-- accepted, archived projects included. The new owner then has the owner's
-- rights, permanent delete included, and the old owner stays as an editor.
-- Run with the Supabase CLI: `supabase test db` (pgTAP). Everything happens
-- in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

select function_privs_are('public', 'transfer_project', array['uuid', 'uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can transfer projects');
select function_privs_are('public', 'transfer_project', array['uuid', 'uuid'], 'anon', array[]::text[], 'Anonymous users cannot');

-- Alice owns Notes. Bob (editor) and Carol (viewer) have accepted; Dave
-- (commenter) is only invited. Erin has nothing to do with it.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com', '{}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com', '{}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com', '{}'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com', '{}'),
  ('55555555-5555-4555-8555-555555555555', 'erin@example.com', '{}');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'viewer');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'commenter') $$,
  'Alice creates a project and invites three people'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Bob accepts');
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Carol accepts');

-- Only the owner. An editor is refused, and so is anyone for a missing project.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222') $$,
  '42501', 'Only the project owner can transfer it', 'An editor cannot make themselves the owner'
);
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000099', '22222222-2222-4222-8222-222222222222') $$,
  '42501', 'Only the project owner can transfer it', 'A missing project is refused the same way'
);

-- Only a person: the owner's agent is refused.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"agent-client"}';
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222') $$,
  '42501', 'Only a signed-in person can transfer a project', 'An agent cannot transfer a project, even its owner''s'
);

-- Only to a member who has accepted.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444') $$,
  '22023', 'Only a member who has accepted their invitation can become the owner', 'Someone only invited cannot become the owner'
);
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555') $$,
  '22023', 'Only a member who has accepted their invitation can become the owner', 'Someone outside the project cannot become the owner'
);
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111') $$,
  '22023', 'Invalid member', 'The owner cannot transfer to themselves'
);
select is(
  (select owner_id from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'Refused transfers change nothing'
);

-- An archived project can be handed over, to a member of any role.
select lives_ok($$ select public.archive_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Alice archives Notes');
create temporary table rev_before on commit drop as
  select revision from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001';
create temporary table handed on commit drop as
  select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333') as summary;
select is((select summary ->> 'role' from handed), 'editor', 'Alice makes Carol, a viewer, the owner, and sees herself as an editor');
select is(
  (select (summary ->> 'revision')::bigint from handed),
  (select revision + 1 from rev_before),
  'The revision goes up by one, so other devices hear of it'
);
select ok((select summary ->> 'archived_at' from handed) is not null, 'The project stays archived');
-- (Sorted by email: in one transaction every membership has the same time.)
select is(
  (select jsonb_agg(jsonb_build_array(m ->> 'email', m ->> 'role') order by m ->> 'email')
   from jsonb_array_elements(public.list_members('aaaaaaaa-0000-4000-8000-000000000001')) m),
  '[["alice@example.com", "editor"], ["bob@example.com", "editor"], ["carol@example.com", "owner"]]'::jsonb,
  'The members list shows Carol as the owner and Alice as an editor; Alice no longer sees the invitation'
);

-- Alice is an editor now: no more sharing, transferring or deleting.
select throws_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'viewer') $$,
  '42501', 'Only the project owner can change sharing', 'The old owner cannot change sharing'
);
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111') $$,
  '42501', 'Only the project owner can transfer it', 'The old owner cannot take it back'
);
select throws_ok(
  $$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501', 'Only the project owner can permanently delete it', 'The old owner cannot delete it permanently'
);
select lives_ok($$ select public.unarchive_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'As an editor, she can still unarchive it');

-- Carol has the owner's rights, and sees the invitation still waiting.
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  (select jsonb_agg(m ->> 'email' order by m ->> 'email') from jsonb_array_elements(public.list_members('aaaaaaaa-0000-4000-8000-000000000001')) m),
  '["alice@example.com", "bob@example.com", "carol@example.com", "dave@example.com"]'::jsonb,
  'The new owner sees the invitation still waiting'
);
select is(
  (select p ->> 'role' from jsonb_array_elements(public.list_projects()) p where p ->> 'id' = 'aaaaaaaa-0000-4000-8000-000000000001'),
  'owner',
  'The new owner lists the project as its owner'
);
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'viewer') $$,
  'The new owner changes the old owner''s role'
);
select lives_ok($$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'The new owner deletes it permanently');
select is((select count(*)::integer from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0, 'and it is gone');

-- The project counts against the new owner's total: Bob already owns 1000.
reset role;
insert into public.projects (id, owner_id, title)
select gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'Old ' || i from generate_series(1, 1000) as i;
insert into public.projects (id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'More');
insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'editor', now());
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select throws_ok(
  $$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222') $$,
  'PT429', 'They have reached the limit of 1000 projects, so cannot own another.', 'A member at the project limit cannot become the owner'
);

select * from finish();
rollback;
