-- An agent's OAuth session can't change the account's password; people and
-- the admin API still can. Each case does what Auth does when it changes a
-- password: write the new hash and clear the one-time tokens, sign out the
-- other sessions, then commit (SET CONSTRAINTS ... IMMEDIATE stands in for the
-- commit). Run with the Supabase CLI: `supabase test db` (pgTAP). Everything
-- happens in one transaction that is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(7);

select function_privs_are('private', 'refuse_agent_password_change', array[]::text[], 'authenticated', array[]::text[], 'Signed-in users cannot call the guard');

-- Four people, each signed in on the web and connected to an agent, except
-- the last, who is signed in only through the agent.
insert into auth.users (id, email, encrypted_password) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com', 'old-hash'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com', 'old-hash'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com', 'old-hash'),
  ('44444444-4444-4444-8444-444444444444', 'dave@example.com', 'old-hash');

insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_type, token_endpoint_auth_method)
values ('cccccccc-0000-4000-8000-000000000001', 'dynamic', 'https://agent.example/callback', 'authorization_code,refresh_token', 'public', 'none');

insert into auth.sessions (id, user_id, oauth_client_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', null),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'cccccccc-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', null),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'cccccccc-0000-4000-8000-000000000001'),
  ('dddddddd-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'cccccccc-0000-4000-8000-000000000001'),
  ('eeeeeeee-0000-4000-8000-000000000002', '44444444-4444-4444-8444-444444444444', 'cccccccc-0000-4000-8000-000000000001');

-- Alice's agent changes her password: her web session is signed out, and only
-- the agent's session is left when it commits.
select throws_ok(
  $$ set constraints all deferred;
     update auth.users set encrypted_password = 'agent-hash', reauthentication_token = '', recovery_token = ''
       where id = '11111111-1111-4111-8111-111111111111';
     delete from auth.sessions
       where user_id = '11111111-1111-4111-8111-111111111111' and id <> 'aaaaaaaa-0000-4000-8000-000000000002';
     set constraints all immediate $$,
  '42501',
  'Agents can''t change a password',
  'An agent cannot change the password'
);

-- Bob changes his own password on the web: the agent's session is signed out.
select lives_ok(
  $$ set constraints all deferred;
     update auth.users set encrypted_password = 'new-hash', reauthentication_token = '', recovery_token = ''
       where id = '22222222-2222-4222-8222-222222222222';
     delete from auth.sessions
       where user_id = '22222222-2222-4222-8222-222222222222' and id <> 'bbbbbbbb-0000-4000-8000-000000000001';
     set constraints all immediate $$,
  'A person can change their password'
);

-- The admin API (or a recovery link) changes Carol's password: every session is
-- signed out.
select lives_ok(
  $$ set constraints all deferred;
     update auth.users set encrypted_password = 'admin-hash', reauthentication_token = '', recovery_token = ''
       where id = '33333333-3333-4333-8333-333333333333';
     delete from auth.sessions where user_id = '33333333-3333-4333-8333-333333333333';
     set constraints all immediate $$,
  'The admin API can change a password'
);

-- Dave, signed in only through his agent, keeps working normally.
select lives_ok(
  $$ set constraints all deferred;
     update auth.users set last_sign_in_at = now() where id = '44444444-4444-4444-8444-444444444444';
     set constraints all immediate $$,
  'Updates that leave the password alone go through'
);
select lives_ok(
  $$ set constraints all deferred;
     update auth.users set reauthentication_token = 'nonce' where id = '44444444-4444-4444-8444-444444444444';
     set constraints all immediate $$,
  'Asking for a reauthentication code goes through'
);
select lives_ok(
  $$ set constraints all deferred;
     update auth.users set encrypted_password = 're-encrypted-hash' where id = '44444444-4444-4444-8444-444444444444';
     set constraints all immediate $$,
  'A password sign-in that re-encrypts the stored hash goes through'
);

select * from finish();
rollback;
