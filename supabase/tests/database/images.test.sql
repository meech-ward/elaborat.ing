begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select table_privs_are('public', 'image_assets', 'authenticated', array[]::text[], 'Reservations are not exposed to clients');
select table_privs_are('public', 'image_assets', 'anon', array[]::text[], 'Anonymous users cannot inspect images');
select table_privs_are('private', 'image_object_deletions', 'authenticated', array[]::text[], 'Cleanup queue is private');
insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'image-owner@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'image-editor@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'image-viewer@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'image-pending@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'image-outsider@example.com');
insert into public.projects(id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Images'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555', 'Other images');
insert into public.project_members(project_id, user_id, role, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'editor', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'viewer', now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'editor', null);
insert into storage.buckets(id, name, public) values ('project-images', 'project-images', false) on conflict do nothing;

set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', repeat('a',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'Owner reserves original and preview bytes');
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001',true)->>'status','pending','Live interrupted upload keeps its existing identity');
select lives_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', repeat('a',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'Retry uses the same reservation');
select throws_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', repeat('b',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, '22023', null, 'Reservation id cannot change bytes');
select throws_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', '[{"op":"asset","path":"photo.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001"}]') $$, '42501', null, 'Unvalidated reservation cannot be saved');
select throws_ok($$ select public.complete_image_asset('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', repeat('a',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, '42501', null, 'Browser cannot mark bytes ready');
select throws_ok($$ insert into storage.objects(bucket_id,name) values ('project-images','invented') $$, '42501', null, 'Browser cannot upload objects directly');

reset role;
select throws_ok($$ select public.complete_image_asset('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', repeat('a',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, '55000', null, 'Trusted completion refuses missing bytes');
insert into storage.objects(bucket_id,name) values
  ('project-images','aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001/original'),
  ('project-images','aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001/preview');
select lives_ok($$ select public.complete_image_asset('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', repeat('a',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'Trusted completion marks uploaded originals and previews ready');
set local role authenticated;
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 0, 'Ready drafts are not published to other members');
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001'),null::jsonb,'Import retries reveal no other person''s staged image');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001')->>'id','bbbbbbbb-0000-4000-8000-000000000001','Uploader can recover a ready asset after a lost reply');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', '[{"op":"asset","path":"photo.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001"},{"op":"put","path":"note.md","content":"![Photo](photo.png)"}]') $$, 'Image and referring note commit in one batch');
select is((select public.read_project('aaaaaaaa-0000-4000-8000-000000000001') -> 'files' -> 1 ->> 'kind'), 'image', 'Project snapshots identify image files');
select is((select public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000001','photo.png',1) ->> 'id'), 'bbbbbbbb-0000-4000-8000-000000000001', 'Saved revision resolves its image');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', '[{"op":"asset","path":"photo.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001"},{"op":"put","path":"note.md","content":"![Photo](photo.png)"}]') $$, 'Save retry returns the original receipt');
select throws_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', '[{"op":"put","path":"photo.png","content":"","base_version":1}]') $$, '22023', null, 'Old text-only clients cannot overwrite images');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', '[{"op":"move","path":"photo.png","to":"archive/photo.png","base_version":1}]') $$, 'Move preserves immutable image bytes');
select is((select public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000001','photo.png',1) ->> 'id'), 'bbbbbbbb-0000-4000-8000-000000000001', 'Moving today preserves historical path lookup');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000001','photo.png',2), null::jsonb, 'Old path is absent in the newer revision');
select is((select public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000001','archive/photo.png',2) ->> 'id'), 'bbbbbbbb-0000-4000-8000-000000000001', 'New path resolves in the newer revision');
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 2, 'Owner downloads both immutable objects');

set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 2, 'Accepted editor reads images uploaded by someone else');
select lives_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', repeat('b',64), 'image/jpeg', 128, 2, 3, 'image/png', 64) $$, 'Accepted editor reserves images');
set local request.jwt.claims to '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 2, 'Accepted viewer reads images');
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001',true)->'asset'->>'id','bbbbbbbb-0000-4000-8000-000000000001','Members can recover a committed image originally uploaded by someone else');
select throws_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000003', repeat('c',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, '42501', null, 'Viewer cannot reserve images');
set local request.jwt.claims to '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 0, 'Pending invitation grants no image reads');
select throws_ok($$ select public.check_image_upload('aaaaaaaa-0000-4000-8000-000000000001') $$, '42501', null, 'Pending invitation grants no uploads');
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 0, 'Another project owner cannot read these images');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000001','photo.png',1), null::jsonb, 'Historical images respect project access');
select throws_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003', '[{"op":"asset","path":"stolen.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001"}]') $$, '42501', null, 'Assets cannot be committed to a foreign project');

set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.share_project('aaaaaaaa-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', null) $$, 'Owner revokes editor');
set local request.jwt.claims to '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 0, 'Revoked editor loses image access');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.archive_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Owner archives image project');
select is((select count(*)::integer from storage.objects where bucket_id='project-images'), 2, 'Archived project images remain readable');
select throws_ok($$ select public.check_image_upload('aaaaaaaa-0000-4000-8000-000000000001') $$, '55000', null, 'Archived projects refuse uploads');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","client_id":"image-agent"}';
select is_empty($$ update storage.objects set name='overwrite' where bucket_id='project-images' returning name $$, 'OAuth clients cannot overwrite stored objects');
select throws_ok($$ delete from storage.objects where bucket_id='project-images' returning name $$, '42501', null, 'OAuth clients cannot physically delete stored objects');
select throws_ok($$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$, '42501', null, 'OAuth clients cannot permanently delete projects with images');
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select lives_ok($$ select public.delete_project('aaaaaaaa-0000-4000-8000-000000000001') $$, 'Person can permanently delete the project');
reset role;
select is((select count(*)::integer from private.image_object_deletions), 4, 'Original and preview keys survive cascades in the durable cleanup queue');
select is((select count(*)::integer from public.image_assets), 0, 'Project deletion removes image metadata');
select is((select jsonb_array_length(public.claim_image_cleanup())), 4, 'Trusted cleanup claims queued objects');
select is((select jsonb_array_length(public.claim_image_cleanup())), 0, 'Concurrent cleanup does not claim an active batch twice');
select lives_ok($$ select public.finish_image_cleanup(array(select object_key from private.image_object_deletions)) $$, 'Storage confirmation finishes cleanup');
select is((select count(*)::integer from private.image_object_deletions), 0, 'Cleanup receipts are removed after success');

-- Retained history and staging charge the owner, including derived previews.
insert into public.image_assets(id, project_id, object_key, sha256, media_type, byte_length, width, height,
  created_by, preview_key, preview_type, preview_byte_length, state, committed_at)
select ('dddddddd-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000002/dddddddd-0000-4000-8000-' || lpad(n::text,12,'0') || '/original',
  repeat('d',64), 'image/png', 5242880, 2, 3, '55555555-5555-4555-8555-555555555555',
  'aaaaaaaa-0000-4000-8000-000000000002/dddddddd-0000-4000-8000-' || lpad(n::text,12,'0') || '/preview',
  'image/png', 32768, 'committed', now() from generate_series(1,50) n;
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select throws_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000009', repeat('e',64), 'image/png', 5242880, 2, 3, 'image/png', 32768) $$, '54000', null, 'Quota counts retained originals and previews');
reset role;
insert into public.projects(id, owner_id, title) values ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Transfer images');
insert into public.project_members(project_id,user_id,role,accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000003','55555555-5555-4555-8555-555555555555','viewer',now());
insert into public.image_assets(id, project_id, object_key, sha256, media_type, byte_length, width, height,
  created_by, preview_key, preview_type, preview_byte_length, state, committed_at)
values ('bbbbbbbb-0000-4000-8000-000000000010','aaaaaaaa-0000-4000-8000-000000000003',
  'aaaaaaaa-0000-4000-8000-000000000003/bbbbbbbb-0000-4000-8000-000000000010/original',repeat('e',64),'image/png',5242880,2,3,
  '22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000003/bbbbbbbb-0000-4000-8000-000000000010/preview','image/png',32768,'committed',now());
set local role authenticated;
set local request.jwt.claims to '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
select throws_ok($$ select public.transfer_project('aaaaaaaa-0000-4000-8000-000000000003','55555555-5555-4555-8555-555555555555') $$, '54000', null, 'Ownership transfer checks the recipient image quota atomically');
reset role;
select is((select owner_id::text from public.projects where id='aaaaaaaa-0000-4000-8000-000000000003'),'11111111-1111-4111-8111-111111111111','Failed transfer leaves the owner unchanged');
select is((select count(*)::integer from public.project_members where project_id='aaaaaaaa-0000-4000-8000-000000000003' and user_id='55555555-5555-4555-8555-555555555555'),1,'Failed transfer preserves accepted membership');
delete from auth.users where id='22222222-2222-4222-8222-222222222222';
select is((select count(*)::integer from public.image_assets where id='bbbbbbbb-0000-4000-8000-000000000010'),1,'Deleting the uploader preserves another owner''s project assets');
select is((select created_by from public.image_assets where id='bbbbbbbb-0000-4000-8000-000000000010'),null::uuid,'Uploader attribution is cleared after account deletion');
-- Expired staging is collected without touching historical or active assets.
insert into public.image_assets(id,project_id,object_key,sha256,media_type,byte_length,width,height,created_by,preview_key,preview_type,preview_byte_length,expires_at)
values ('bbbbbbbb-0000-4000-8000-000000000011','aaaaaaaa-0000-4000-8000-000000000003',
 'aaaaaaaa-0000-4000-8000-000000000003/bbbbbbbb-0000-4000-8000-000000000011/original',repeat('e',64),'image/png',128,2,3,
 '11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000003/bbbbbbbb-0000-4000-8000-000000000011/preview','image/png',64,now()-interval '3 hours');
select is(jsonb_array_length(public.claim_image_cleanup()),2,'Expired staging produces durable cleanup for both keys');
select is((select count(*)::integer from public.image_assets where state='committed'),51,'Staging cleanup keeps every historical committed asset');
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select lives_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000004', repeat('d',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'Reserve a disconnected upload');
reset role;
update public.image_assets set expires_at = now() - interval '3 hours' where id = 'bbbbbbbb-0000-4000-8000-000000000004';
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000004',true)->>'status','expired','Upload status distinguishes expired staging from a live retry');
select throws_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000004', repeat('d',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'PT410', null, 'Expired staging asks for a fresh identity rather than claiming lost access');
reset role;
select public.claim_image_cleanup();
set local role authenticated;
set local request.jwt.claims to '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}';
select is(public.read_image_upload('aaaaaaaa-0000-4000-8000-000000000002','bbbbbbbb-0000-4000-8000-000000000004',true)->>'status','missing','Collected staging cannot be mistaken for a committed save');
select throws_ok($$ select public.reserve_image_asset('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000004', repeat('d',64), 'image/png', 128, 2, 3, 'image/png', 64) $$, 'PT410', null, 'Cleanup keys cannot be reused while a worker might delete them');
reset role;
select * from finish();
rollback;
