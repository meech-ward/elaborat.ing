begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email) values('66666666-6666-4666-8666-666666666666','image-history@example.com');
insert into public.projects(id,owner_id,title) values('aaaaaaaa-0000-4000-8000-000000000006','66666666-6666-4666-8666-666666666666','Image history');
insert into storage.buckets(id,name,public) values('project-images','project-images',false) on conflict do nothing;
insert into public.image_assets(id,project_id,object_key,sha256,media_type,byte_length,width,height,created_by,preview_key,preview_type,preview_byte_length,state)
select ('bbbbbbbb-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'aaaaaaaa-0000-4000-8000-000000000006',
 'aaaaaaaa-0000-4000-8000-000000000006/bbbbbbbb-0000-4000-8000-'||lpad(n::text,12,'0')||'/original',repeat(n::text,64),'image/png',128,2,3,
 '66666666-6666-4666-8666-666666666666','aaaaaaaa-0000-4000-8000-000000000006/bbbbbbbb-0000-4000-8000-'||lpad(n::text,12,'0')||'/preview','image/png',64,'ready' from generate_series(1,2)n;
insert into storage.objects(bucket_id,name)
 select 'project-images',k.object_key from public.image_assets a cross join lateral(values(a.object_key),(a.preview_key))k(object_key) where a.project_id='aaaaaaaa-0000-4000-8000-000000000006';
set local role authenticated;
set local request.jwt.claims to '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}';
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000001','[{"op":"asset","path":"a.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001"},{"op":"put","path":"note.md","content":"![Photo](a.png)"}]') $$,'Image and note share a saved revision');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000002','[{"op":"asset","path":"a.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000002","base_version":1}]') $$,'Replacing an image creates a new immutable version');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000006','a.png',1)->>'id','bbbbbbbb-0000-4000-8000-000000000001','Old note revision retains the first image at the same path');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000006','a.png',2)->>'id','bbbbbbbb-0000-4000-8000-000000000002','New revision resolves replacement bytes');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000003','[{"op":"move","path":"a.png","to":"b.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000001","base_version":2},{"op":"put","path":"note.md","content":"![Photo](b.png)","base_version":1}]') $$,'Revert can restore historical bytes while moving and updating a note atomically');
select is((select asset_id::text from public.project_files where project_id='aaaaaaaa-0000-4000-8000-000000000006' and path='b.png'),'bbbbbbbb-0000-4000-8000-000000000001','Move and restore use the chosen historical asset');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000006','a.png',2)->>'id','bbbbbbbb-0000-4000-8000-000000000002','Restore preserves replacement history');
select is((public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000004','[{"op":"move","path":"b.png","to":"c.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000002","base_version":3},{"op":"put","path":"note.md","content":"stale","base_version":1}]')->>'status'),'conflict','A stale referring note prevents the entire image restore');
select is((select asset_id::text from public.project_files where project_id='aaaaaaaa-0000-4000-8000-000000000006' and path='b.png'),'bbbbbbbb-0000-4000-8000-000000000001','Conflict leaves current image and path intact');
select throws_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000005','[{"op":"move","path":"b.png","to":"c.png","asset_id":"bbbbbbbb-0000-4000-8000-000000000099","base_version":3}]') $$,'42501',null,'Move refuses missing or foreign image references');
select throws_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000005','[{"op":"move","path":"b.png","to":"c.png","content":"overwrite","asset_id":"bbbbbbbb-0000-4000-8000-000000000001","base_version":3}]') $$,'22023',null,'Image moves never accept accidental text payloads');
select lives_ok($$ select public.save_files('aaaaaaaa-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000006','[{"op":"delete","path":"b.png","base_version":3}]') $$,'Logical image deletion remains version checked');
select is(public.read_image_at_revision('aaaaaaaa-0000-4000-8000-000000000006','a.png',1)->>'id','bbbbbbbb-0000-4000-8000-000000000001','Logical deletion preserves original image history');
select is((select count(*)::integer from storage.objects where bucket_id='project-images'),4,'Logical deletion keeps all immutable original and preview bytes');
select * from finish();
rollback;
