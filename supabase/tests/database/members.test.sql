-- Who a project is shared with (list_members): the owner and accepted members
-- may list them, only the owner sees invitations still waiting, and anyone
-- else is refused. Run with the Supabase CLI: `supabase test db` (pgTAP).
-- Everything happens in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

select function_privs_are('public', 'list_members', array['uuid'], 'authenticated', array['EXECUTE'], 'Signed-in users can list members');
select function_privs_are('public', 'list_members', array['uuid'], 'anon', array[]::text[], 'Anonymous users cannot list members');

-- Alice owns a project. Bob (editor) and Carol (viewer) accept their
-- invitations; Dave (commenter) has not yet. Erin has nothing to do with it.
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'erin@example.com');

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

-- The owner sees everyone: herself first, then accepted members, then the invitation.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(
  (select jsonb_agg(jsonb_build_array(m ->> 'email', m ->> 'role'))
   from jsonb_array_elements(public.list_members('aaaaaaaa-0000-4000-8000-000000000001')) m),
  '[["alice@example.com", "owner"], ["bob@example.com", "editor"], ["carol@example.com", "viewer"], ["dave@example.com", "commenter"]]'::jsonb,
  'The owner sees the owner first, then accepted members, then pending invitations'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 1) k),
  array['accepted_at', 'email', 'invited_at', 'role', 'user_id'],
  'Each entry has the id, email, role and the invitation and acceptance times'
);
select is(
  public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 1 ->> 'user_id',
  '22222222-2222-4222-8222-222222222222',
  'Entries carry the user id'
);
select ok(
  (public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 1 ->> 'accepted_at') is not null
    and (public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 1 ->> 'invited_at') is not null,
  'An accepted member has both times'
);
select ok(
  (public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 3 ->> 'accepted_at') is null,
  'A pending invitation has no acceptance time'
);
select ok(
  (public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 0 ->> 'invited_at') is null
    and (public.list_members('aaaaaaaa-0000-4000-8000-000000000001') -> 0 ->> 'accepted_at') is null,
  'The owner has neither time'
);

-- An accepted member sees the owner and the accepted members, not invitations.
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is(
  (select jsonb_agg(m ->> 'email') from jsonb_array_elements(public.list_members('aaaaaaaa-0000-4000-8000-000000000001')) m),
  '["alice@example.com", "bob@example.com", "carol@example.com"]'::jsonb,
  'An accepted member sees the owner and accepted members, but no pending invitations'
);

-- A person whose invitation is still pending is refused.
set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select throws_ok(
  $$ select public.list_members('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Project unavailable',
  'A pending invitee cannot list members'
);

-- So is anyone else, and a project that does not exist says the same.
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select throws_ok(
  $$ select public.list_members('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Project unavailable',
  'An outsider cannot list members'
);
select throws_ok(
  $$ select public.list_members('aaaaaaaa-0000-4000-8000-000000000099') $$,
  '42501',
  'Project unavailable',
  'A missing project is refused the same way'
);

-- Removing a member takes them off the list, and their access with it.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok(
  $$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', null) $$,
  'The owner removes Bob'
);
select is(
  (select jsonb_agg(m ->> 'email') from jsonb_array_elements(public.list_members('aaaaaaaa-0000-4000-8000-000000000001')) m),
  '["alice@example.com", "carol@example.com", "dave@example.com"]'::jsonb,
  'A removed member is no longer listed'
);
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select throws_ok(
  $$ select public.list_members('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  'Project unavailable',
  'A removed member can no longer list members'
);

-- Anonymous callers get nothing.
set local role anon;
select throws_ok(
  $$ select public.list_members('aaaaaaaa-0000-4000-8000-000000000001') $$,
  '42501',
  null,
  'Anonymous users cannot call list_members'
);

select * from finish();
rollback;
