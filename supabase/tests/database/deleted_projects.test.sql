-- When an owner deletes a project, each person who had accepted it gets a row
-- in deleted_projects, which only they can read, so their devices can say the
-- owner deleted it. People only invited, people removed before, the owner and
-- everyone else get none. Run with the Supabase CLI: `supabase test db`
-- (pgTAP). Everything happens in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

select table_privs_are('public', 'deleted_projects', 'authenticated', array['SELECT'], 'Signed-in users can only read deleted_projects');
select table_privs_are('public', 'deleted_projects', 'anon', array[]::text[], 'Anonymous users cannot read it');

-- Alice owns Notes. Bob (editor) and Carol (viewer) have accepted; Dave is
-- only invited; Erin accepted and was then removed. Frank has nothing to do with it.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com', '{}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com', '{}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com', '{}'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com', '{}'),
  ('55555555-5555-4555-8555-555555555555', 'erin@example.com', '{}'),
  ('66666666-6666-4666-8666-666666666666', 'frank@example.com', '{}');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'viewer');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'commenter');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', 'viewer') $$,
  'Alice creates a project and invites four people'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Bob accepts');
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Carol accepts');
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select lives_ok($$ select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Erin accepts');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '55555555-5555-4555-8555-555555555555', null);
     select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  'Alice removes Erin, then deletes the project'
);

-- Each person reads only their own rows.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select results_eq($$ select project_id from public.deleted_projects $$, $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$, 'Bob hears the project was deleted');
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select results_eq($$ select project_id from public.deleted_projects $$, $$ values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid) $$, 'So does Carol');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select is_empty($$ select * from public.deleted_projects $$, 'Dave, only invited, does not');
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select is_empty($$ select * from public.deleted_projects $$, 'Erin, removed before, does not');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is_empty($$ select * from public.deleted_projects $$, 'Alice, the owner, does not');
set local request.jwt.claims to '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}';
select is_empty($$ select * from public.deleted_projects $$, 'Frank does not');

-- The same id made, shared and deleted again updates Bob's row. A row older
-- than 90 days goes with the next deletion.
reset role;
update public.deleted_projects set deleted_at = now() - interval '91 days'
where user_id = '33333333-3333-4333-8333-333333333333';
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.create_project('aaaaaaaa-0000-4000-8000-000000000001', 'Notes again');
     select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor');
     set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
     select public.accept_invitation('aaaaaaaa-0000-4000-8000-000000000001');
     set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
     select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$,
  'Alice makes the same project again, Bob joins, and she deletes it again'
);
reset role;
select results_eq(
  $$ select user_id from public.deleted_projects order by user_id $$,
  $$ values ('22222222-2222-4222-8222-222222222222'::uuid) $$,
  'Bob has one row, and Carol''s old row is gone'
);

select * from finish();
rollback;
