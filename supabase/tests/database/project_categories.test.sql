-- Private, flat project organization. Every fixture and mutation rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select table_privs_are('public', 'project_categories', 'authenticated', array['SELECT'], 'Category tables are read-only to clients');
select table_privs_are('public', 'project_category_memberships', 'authenticated', array['SELECT'], 'Assignment tables are read-only to clients');
select table_privs_are('public', 'project_categories', 'anon', array[]::text[], 'Anonymous users have no category table grants');
select table_privs_are('public', 'project_category_memberships', 'anon', array[]::text[], 'Anonymous users have no assignment table grants');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.project_categories'::regclass, 'public.project_category_memberships'::regclass)), 'Both tables enable RLS');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.proname like '%project_categor%'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
), 'No category function is executable anonymously');
select ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '%project_categor%' and p.prosecdef
), 'Exposed category functions are security invokers');
select function_privs_are('private', 'project_category_name', array['text'], 'authenticated', array[]::text[], 'Clients cannot call the internal name helper');
select function_privs_are('private', 'check_project_category_counts', array[]::text[], 'authenticated', array[]::text[], 'Clients cannot call the internal quota helper');

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'categories-alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'categories-bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'categories-limits@example.com');
insert into public.projects (id, owner_id, title, revision, archived_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Alice project', 7, null),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Private project', 11, null),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Pending invite', 12, null),
  ('bbbbbbbb-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'Viewer project', 13, null),
  ('bbbbbbbb-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'Commenter project', 14, null),
  ('bbbbbbbb-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222222', 'Archived project', 15, now());
insert into public.project_members (project_id, user_id, role, accepted_at) values
  ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'editor', null),
  ('bbbbbbbb-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'viewer', now()),
  ('bbbbbbbb-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'commenter', now()),
  ('bbbbbbbb-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'viewer', now());

create function pg_temp.category(category_id uuid) returns jsonb language sql as $$
  select value from jsonb_array_elements(public.list_project_categories())
  where value ->> 'id' = category_id::text
$$;

set local role anon;
select throws_ok($$ select public.list_project_categories() $$, '42501', null, 'Anonymous callers cannot list categories');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Video scripts') $$, '42501', null, 'Anonymous callers cannot create categories');

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(public.list_project_categories(), '[]'::jsonb, 'An account starts with no categories');
select is(public.create_project_category('caaaaaaa-0000-4000-8000-000000000001', '  Video scripts  ') ->> 'name', 'Video scripts', 'Creation trims category names');
select is(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') ->> 'revision', '0', 'A new category starts at revision zero');
select is(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids', '[]'::jsonb, 'A new category has no assignments');
select is(public.create_project_category('caaaaaaa-0000-4000-8000-000000000001', 'A retried name') ->> 'name', 'Video scripts', 'Retrying creation never renames the existing id');
select is(jsonb_array_length(public.list_project_categories()), 1, 'Retrying creation never duplicates a category');
select throws_ok($$ select public.create_project_category(null, 'Name') $$, '22023', 'Category id required', 'Creation requires an id');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000010', ' ') $$, '22023', null, 'Blank names are refused');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000010', repeat('x', 161)) $$, '22023', null, 'Overlong names are refused');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000010', E'Name\nAnother') $$, '22023', null, 'Control characters in names are refused');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000002', 'VIDEO SCRIPTS') $$, '23505', 'A category with that name already exists. Choose a different name.', 'Active names are unique ignoring case');
select is(public.create_project_category('caaaaaaa-0000-4000-8000-000000000003', 'Cafe' || chr(769)) ->> 'name', 'Café', 'Names are normalized to NFC');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000010', 'CAFÉ') $$, '23505', null, 'Canonical Unicode spellings cannot create duplicate names');
select is(public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Video scripts') ->> 'revision', '0', 'Renaming to the current name is a no-op');
select is(public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Scripts') ->> 'revision', '1', 'A rename increments category revision');
select throws_ok($$ select public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Café') $$, '23505', null, 'Renaming to another active name is refused');

select is(public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', true) ->> 'revision', '2', 'Adding a project increments category revision');
select is(public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', true) ->> 'revision', '2', 'Retrying an inclusion is a no-op');
select is(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids', '["aaaaaaaa-0000-4000-8000-000000000001"]'::jsonb, 'The category row lists readable project ids');
select is(public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', false) ->> 'revision', '3', 'Removing a project increments category revision');
select ok((select removed_at is not null from public.project_category_memberships where category_id = 'caaaaaaa-0000-4000-8000-000000000001'), 'Removal retains the association as recoverable metadata');
select is(public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', false) ->> 'revision', '3', 'Retrying a removal is a no-op');
select is(public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', true) ->> 'revision', '4', 'Adding again restores the retained association');
select is((select count(*)::int from public.project_category_memberships), 1, 'Restoration does not duplicate the relationship');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', true) $$, '42501', 'Project unavailable', 'An unreadable project cannot be assigned');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', false) $$, '42501', 'Project unavailable', 'An unreadable project cannot be removed through the API either');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', true) $$, '42501', 'Project unavailable', 'A pending invitation grants no assignment authority');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', null) $$, '22023', null, 'Assignment inclusion must be explicit');
select lives_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000003', true) $$, 'Viewers can privately categorize readable projects');
select lives_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000004', true) $$, 'Commenters can privately categorize readable projects');
select lives_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000005', true) $$, 'Archived projects can be privately categorized');
select is((select revision from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 7::bigint, 'Categorizing leaves the owned project revision unchanged');
select results_eq($$ select revision from public.projects where owner_id = '22222222-2222-4222-8222-222222222222' order by id $$, $$ values (13::bigint), (14::bigint), (15::bigint) $$, 'Categorizing shared and archived projects leaves their content revisions unchanged');

-- Bob sees neither Alice's labels nor her personal organization of his projects.
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is(public.list_project_categories(), '[]'::jsonb, 'Another account cannot list Alice categories');
select is((select count(*)::int from public.project_categories), 0, 'Category table RLS hides another account');
select is((select count(*)::int from public.project_category_memberships), 0, 'Assignment table RLS hides another account even for projects it owns');
select throws_ok($$ select public.create_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Name') $$, '42501', 'Category unavailable', 'A foreign category id cannot be claimed');
select throws_ok($$ select public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Name') $$, '42501', 'Category unavailable', 'A foreign category cannot be renamed');
select throws_ok($$ select public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000001', true) $$, '42501', 'Category unavailable', 'A foreign category cannot be archived');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', true) $$, '42501', 'Category unavailable', 'Project ownership does not authorize another person category');
select is(public.create_project_category('cbbbbbbb-0000-4000-8000-000000000001', 'Scripts') ->> 'name', 'Scripts', 'Different accounts may use the same category name');
select is(public.create_project_category('cbbbbbbb-0000-4000-8000-000000000002', repeat('😀', 100)) ->> 'name', repeat('😀', 100), 'The name bound counts Unicode code points rather than UTF-16 units');
select is(public.create_project_category('cbbbbbbb-0000-4000-8000-000000000003', chr(160) || 'Video scripts') ->> 'name', chr(160) || 'Video scripts', 'API responses preserve non-ASCII space prefixes accepted by the database');

-- Revoke access while retaining Alice's private metadata; every reader hides it.
reset role;
delete from public.project_members where project_id = 'bbbbbbbb-0000-4000-8000-000000000003';
insert into public.project_category_memberships (category_id, project_id) values
  ('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select ok(not (pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids' ? 'bbbbbbbb-0000-4000-8000-000000000003'), 'List responses hide revoked project ids');
select ok(not (pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids' ? 'bbbbbbbb-0000-4000-8000-000000000002'), 'List responses hide pending invitation ids even if an association exists');
select is((select count(*)::int from public.project_category_memberships where project_id in ('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000003')), 0, 'Direct assignment reads also hide revoked and pending projects');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000003', true) $$, '42501', 'Project unavailable', 'Revoked access cannot be used for a new assignment write');

select is(public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000001', true) ->> 'revision', '8', 'Archiving increments only the category revision');
select is(public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000001', true) ->> 'revision', '8', 'Retrying archive is a no-op');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'archived_at' <> 'null'::jsonb, 'Archived categories remain listed for restoration');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001', 'Archiving retains readable assignments');
select throws_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', false) $$, '55000', 'Category is archived', 'An archived category retains its assignments until restored');
select is(public.create_project_category('caaaaaaa-0000-4000-8000-000000000002', 'Scripts') ->> 'name', 'Scripts', 'An archived name may be reused');
select throws_ok($$ select public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000001', false) $$, '23505', 'A category with that name already exists. Rename this category before restoring it.', 'Restoring a colliding active name is refused clearly');
select is(public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Old scripts') ->> 'name', 'Old scripts', 'An archived category can be renamed before restoring');
select is(public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000001', false) -> 'archived_at', 'null'::jsonb, 'A renamed category can be restored');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001', 'Restore recovers the same project assignments');

-- Atomic checkbox saves replace active assignments, leaving archived ones alone.
select lives_ok($$ select public.set_project_category_membership('caaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', true) $$, 'A project may appear in multiple categories');
select lives_ok($$ select public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000003', true) $$, 'A second assigned category is archived');
select is(jsonb_array_length(public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array['caaaaaaa-0000-4000-8000-000000000002', 'caaaaaaa-0000-4000-8000-000000000002']::uuid[])), 3, 'Atomic assignment deduplicates ids and returns all caller categories');
select ok(not (pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001'), 'Atomic assignment removes omitted active categories');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000002') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001', 'Atomic assignment adds selected categories');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000003') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001', 'Atomic assignment preserves archived categories');
select set_config('test.category_snapshot', public.list_project_categories()::text, true);
select lives_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array['caaaaaaa-0000-4000-8000-000000000002']::uuid[]) $$, 'Retrying an atomic assignment succeeds');
select is(public.list_project_categories()::text, current_setting('test.category_snapshot'), 'Retrying keeps all category revisions and timestamps stable');
select throws_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array['caaaaaaa-0000-4000-8000-000000000001', 'cbbbbbbb-0000-4000-8000-000000000001']::uuid[]) $$, '42501', 'Category unavailable', 'An atomic save refuses all foreign category ids');
select is(public.list_project_categories()::text, current_setting('test.category_snapshot'), 'A refused atomic save changes nothing');
select throws_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array['caaaaaaa-0000-4000-8000-000000000003']::uuid[]) $$, '42501', 'Category unavailable', 'An archived category cannot be supplied as an active checkbox choice');
select throws_ok($$ select public.set_project_categories('bbbbbbbb-0000-4000-8000-000000000001', '{}'::uuid[]) $$, '42501', 'Project unavailable', 'An unreadable project cannot be changed by atomic assignment');
select throws_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', null) $$, '22023', null, 'Atomic assignment requires an explicit array');
select throws_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array[null]::uuid[]) $$, '22023', null, 'Atomic assignment refuses null ids');
select throws_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', array_fill('caaaaaaa-0000-4000-8000-000000000002'::uuid, array[129])) $$, '22023', null, 'Atomic assignment bounds its input count');
select lives_ok($$ select public.set_project_categories('bbbbbbbb-0000-4000-8000-000000000004', array['caaaaaaa-0000-4000-8000-000000000002']::uuid[]) $$, 'Commenter access is sufficient for atomic private assignment');
select lives_ok($$ select public.set_project_categories('bbbbbbbb-0000-4000-8000-000000000005', array['caaaaaaa-0000-4000-8000-000000000002']::uuid[]) $$, 'An archived readable project can use atomic assignment');
select lives_ok($$ select public.set_project_categories('aaaaaaaa-0000-4000-8000-000000000001', '{}'::uuid[]) $$, 'An empty choice removes every active assignment');
select ok(not (pg_temp.category('caaaaaaa-0000-4000-8000-000000000002') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001'), 'No active assignment remains for the cleared project');
select ok(pg_temp.category('caaaaaaa-0000-4000-8000-000000000003') -> 'project_ids' ? 'aaaaaaaa-0000-4000-8000-000000000001', 'Clearing active choices still preserves archived assignments');

-- The OAuth session has the same private organizing rights and no delete path.
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"44444444-4444-4444-8444-444444444444"}';
select lives_ok($$ select public.rename_project_category('caaaaaaa-0000-4000-8000-000000000002', 'Agent-organized scripts') $$, 'Connected agents can rename their user categories');
select lives_ok($$ select public.set_project_category_archived('caaaaaaa-0000-4000-8000-000000000002', true) $$, 'Connected agents archive categories recoverably');
select throws_ok($$ delete from public.project_categories where id = 'caaaaaaa-0000-4000-8000-000000000002' $$, '42501', null, 'Connected agents cannot physically delete categories');
select throws_ok($$ delete from public.project_category_memberships where category_id = 'caaaaaaa-0000-4000-8000-000000000002' $$, '42501', null, 'Connected agents cannot physically delete assignments');
select throws_ok($$ update public.project_categories set owner_id = '22222222-2222-4222-8222-222222222222' where id = 'caaaaaaa-0000-4000-8000-000000000002' $$, '42501', null, 'Clients cannot transfer private category ownership directly');
select is((select revision from public.projects where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 7::bigint, 'All category operations leave project content revisions untouched');

-- Totals include archived categories; active limits apply to restore too.
reset role;
insert into public.project_categories (id, owner_id, name)
select ('cccccccc-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '33333333-3333-4333-8333-333333333333', 'Category ' || i from generate_series(1, 128) as s(i);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select throws_ok($$ select public.create_project_category('cccccccc-0000-4000-8000-000000000129', 'Too many active') $$, 'PT429', 'You have reached the limit of 128 active categories. Archive one to make room.', 'Active category count is bounded');
select is(jsonb_array_length(public.list_project_categories()), 128, 'A refused create leaves no extra category');
select lives_ok($$ select public.set_project_category_archived('cccccccc-0000-4000-8000-000000000001', true) $$, 'Archiving frees active category capacity');
select lives_ok($$ select public.create_project_category('cccccccc-0000-4000-8000-000000000129', 'Replacement active') $$, 'A category can use the freed capacity');
select throws_ok($$ select public.set_project_category_archived('cccccccc-0000-4000-8000-000000000001', false) $$, 'PT429', 'You have reached the limit of 128 active categories. Archive one to make room.', 'Restore cannot exceed active category capacity');
select ok(pg_temp.category('cccccccc-0000-4000-8000-000000000001') -> 'archived_at' <> 'null'::jsonb, 'A refused restore preserves the archive');
reset role;
insert into public.project_categories (id, owner_id, name, archived_at)
select ('cccccccc-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '33333333-3333-4333-8333-333333333333', 'Archived ' || i, now() from generate_series(130, 1000) as s(i);
set local role authenticated;
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select lives_ok($$ select public.set_project_category_archived('cccccccc-0000-4000-8000-000000000002', true) $$, 'A full account may still archive categories');
select throws_ok($$ select public.create_project_category('cccccccc-0000-4000-8000-000000001001', 'Too many total') $$, 'PT429', 'You have reached the limit of 1000 categories, including archived categories.', 'Total category count includes archives');
select is(jsonb_array_length(public.list_project_categories()), 1000, 'A refused total-limit create leaves all existing categories intact');

-- Included associations are bounded too; removed associations free capacity.
reset role;
insert into auth.users (id, email) values ('44444444-4444-4444-8444-444444444444', 'categories-membership-limit@example.com');
insert into public.projects (id, owner_id, title)
select ('dddddddd-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '44444444-4444-4444-8444-444444444444', 'Project ' || i from generate_series(1, 10001) as s(i);
insert into public.project_categories (id, owner_id, name) values
  ('cddddddd-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'Full'),
  ('cddddddd-0000-4000-8000-000000000002', '44444444-4444-4444-8444-444444444444', 'Available');
insert into public.project_category_memberships (category_id, project_id)
select 'cddddddd-0000-4000-8000-000000000001', ('dddddddd-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1, 10000) as s(i);
set local role authenticated;
set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select throws_ok($$ select public.set_project_category_membership('cddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000010001', true) $$, 'PT429', 'A category can contain at most 10000 projects. Remove a project before adding another.', 'New inclusion cannot exceed the association cap');
select is(public.set_project_category_membership('cddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', true) ->> 'revision', '0', 'Existing included projects can still be retried at the cap');
select throws_ok($$ select public.set_project_categories('dddddddd-0000-4000-8000-000000010001', array['cddddddd-0000-4000-8000-000000000002', 'cddddddd-0000-4000-8000-000000000001']::uuid[]) $$, 'PT429', null, 'Atomic assignment checks the association cap before changing any category');
select is(pg_temp.category('cddddddd-0000-4000-8000-000000000002') -> 'project_ids', '[]'::jsonb, 'A cap failure does not partially assign another category');
select lives_ok($$ select public.set_project_category_membership('cddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', false) $$, 'Removing an association frees its category capacity');
select lives_ok($$ select public.set_project_categories('dddddddd-0000-4000-8000-000000010001', array['cddddddd-0000-4000-8000-000000000001']::uuid[]) $$, 'The freed capacity is usable through atomic assignment');
select is((select count(*)::int from public.project_category_memberships where removed_at is null and category_id = 'cddddddd-0000-4000-8000-000000000001'), 10000, 'Included associations stay within the cap');
select is((select count(*)::int from public.project_category_memberships where category_id = 'cddddddd-0000-4000-8000-000000000001'), 10001, 'Removed metadata remains recoverable without counting as included');

reset role;
insert into private.limit_counters (user_id, name, window_start, uses)
values ('11111111-1111-4111-8111-111111111111', 'category_changes_per_minute', date_bin(interval '1 minute', now(), timestamptz '2000-01-01 00:00:00+00'), 300)
on conflict (user_id, name) do update set window_start = excluded.window_start, uses = excluded.uses;
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select throws_ok($$ select public.rename_project_category('caaaaaaa-0000-4000-8000-000000000001', 'Rate-limited rename') $$, 'PT429', null, 'Category writes enforce the shared per-account rate limit');
select is(pg_temp.category('caaaaaaa-0000-4000-8000-000000000001') ->> 'name', 'Old scripts', 'A rate refusal leaves metadata intact and readable');
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select lives_ok($$ select public.rename_project_category('cbbbbbbb-0000-4000-8000-000000000001', 'Bob scripts') $$, 'One account rate limit never blocks another account');

select * from finish();
rollback;
