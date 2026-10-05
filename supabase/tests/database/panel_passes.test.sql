-- Passes for the app in a chat's panel (panel_passes.sql): the MCP server
-- mints one with the person's token, and only that person, signed in
-- themselves (not through an agent), can redeem it, once, before it expires.
-- Every refusal is the same false. Run with the Supabase CLI:
-- `supabase test db` (pgTAP). Everything happens in one transaction that is
-- rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

select table_privs_are('private', 'panel_passes', 'authenticated', array[]::text[], 'Signed-in users cannot read or write passes directly');
select table_privs_are('private', 'panel_passes', 'anon', array[]::text[], 'Anonymous users cannot either');
select function_privs_are('public', 'mint_panel_pass', array[]::text[], 'authenticated', array['EXECUTE'], 'Signed-in callers can mint a pass');
select function_privs_are('public', 'mint_panel_pass', array[]::text[], 'anon', array[]::text[], 'Anonymous users cannot');
select function_privs_are('public', 'redeem_panel_pass', array['text'], 'authenticated', array['EXECUTE'], 'Signed-in callers can redeem a pass');
select function_privs_are('public', 'redeem_panel_pass', array['text'], 'anon', array[]::text[], 'Anonymous users cannot');

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com');

set local role authenticated;

-- The MCP server mints a pass with Alice's token, which was issued to her agent.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"agent-client"}';
select matches(set_config('test.pass', public.mint_panel_pass(), true), '^[0-9a-f]{64}$', 'The MCP server mints a pass with the person''s token: 32 bytes as hex');
select ok(not public.redeem_panel_pass(current_setting('test.pass')), 'A token issued to an agent cannot redeem a pass, even its person''s own');

-- Bob, signed in himself, cannot redeem Alice's pass.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select ok(not public.redeem_panel_pass(current_setting('test.pass')), 'Another person''s pass is refused');

-- Alice, signed in herself, redeems it once.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select ok(public.redeem_panel_pass(current_setting('test.pass')), 'Alice redeems her own pass');
select ok(not public.redeem_panel_pass(current_setting('test.pass')), 'A used pass is refused');

-- Only the pass's hash is kept.
reset role;
select is(
  (select count(*)::integer from private.panel_passes p
   where p.hash = sha256(decode(current_setting('test.pass'), 'hex'))
     and p.user_id = '11111111-1111-4111-8111-111111111111' and p.used_at is not null),
  1,
  'The pass is kept as its SHA-256 hash, marked used'
);
select is(
  (select count(*)::integer from private.panel_passes p where encode(p.hash, 'hex') = current_setting('test.pass')),
  0,
  'and never as itself'
);

-- An expired pass.
set local role authenticated;
select matches(set_config('test.old', public.mint_panel_pass(), true), '^[0-9a-f]{64}$', 'Alice mints a pass herself');
reset role;
update private.panel_passes set expires_at = now() - interval '1 second'
where hash = sha256(decode(current_setting('test.old'), 'hex'));
set local role authenticated;
select ok(not public.redeem_panel_pass(current_setting('test.old')), 'An expired pass is refused');

-- Anything that is not a pass.
select ok(
  not public.redeem_panel_pass(null) and not public.redeem_panel_pass('') and not public.redeem_panel_pass('not a pass')
    and not public.redeem_panel_pass(upper(current_setting('test.old')))
    and not public.redeem_panel_pass(repeat('0', 64)),
  'Anything that is not a live pass is the same false'
);

-- Bob has a live pass and an expired one.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select matches(set_config('test.bob', public.mint_panel_pass(), true), '^[0-9a-f]{64}$', 'Bob mints a pass');
select matches(set_config('test.bob_old', public.mint_panel_pass(), true), '^[0-9a-f]{64}$', 'and another');
reset role;
update private.panel_passes set expires_at = now() - interval '1 second'
where hash = sha256(decode(current_setting('test.bob_old'), 'hex'));

-- Alice mints 12 more: she keeps at most 10 live ones, her used and expired
-- ones and anyone's expired ones go, and Bob's live pass stays.
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is((select count(*)::integer from (select public.mint_panel_pass() from generate_series(1, 12)) minted), 12, 'Alice mints 12 more passes');
reset role;
select is(
  (select count(*)::integer from private.panel_passes where user_id = '11111111-1111-4111-8111-111111111111'),
  10,
  'A person keeps at most 10 passes'
);
select is(
  (select count(*)::integer from private.panel_passes
   where user_id = '11111111-1111-4111-8111-111111111111' and (used_at is not null or expires_at <= now())),
  0,
  'Her used and expired passes are gone'
);
select is(
  (select count(*)::integer from private.panel_passes where hash = sha256(decode(current_setting('test.bob_old'), 'hex'))),
  0,
  'Anyone''s expired passes are gone'
);
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select ok(public.redeem_panel_pass(current_setting('test.bob')), 'Bob''s live pass still works');

-- Signed out.
set local role anon;
select throws_ok($$ select public.mint_panel_pass() $$, '42501', null, 'Anonymous callers cannot mint');
select throws_ok($$ select public.redeem_panel_pass(repeat('0', 64)) $$, '42501', null, 'or redeem');

select * from finish();
rollback;
