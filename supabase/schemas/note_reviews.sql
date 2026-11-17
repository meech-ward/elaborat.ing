-- Shared note reviews are separate from accepted source. File identities and
-- the original import survive moves, deletions and completion of a review.
create table public.note_reviews (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  file_id uuid not null,
  path text collate "C" not null check (private.is_valid_path(path)),
  base_version bigint not null check (base_version > 0),
  version bigint not null default 1 check (version > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 4194304),
  original_bundle jsonb not null check (jsonb_typeof(original_bundle) = 'object' and octet_length(original_bundle::text) <= 4194304),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, project_id),
  check ((status = 'closed') = (closed_at is not null))
);
create unique index note_reviews_one_open_file_idx on public.note_reviews(project_id, file_id) where status = 'open';
create index note_reviews_file_history_idx on public.note_reviews(project_id, file_id, created_at desc, id);
create index note_reviews_created_by_idx on public.note_reviews(created_by);
create index note_reviews_updated_by_idx on public.note_reviews(updated_by);
alter table public.note_reviews enable row level security;
revoke all on public.note_reviews from anon, authenticated;
grant select on public.note_reviews to authenticated;
create policy "Members can read their projects' note reviews" on public.note_reviews for select to authenticated
  using (project_id in (select private.readable_project_ids()));

-- Append-only decisions also provide idempotency receipts. The receipt omits
-- immutable import markup; replay hydrates it from the retained review row.
create table public.note_review_decisions (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  review_id uuid not null,
  mutation_id uuid not null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in ('save', 'accept', 'reject', 'finish')),
  request_hash bytea not null,
  selected jsonb not null default '[]'::jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (review_id, project_id) references public.note_reviews(id, project_id) on delete cascade,
  unique (project_id, mutation_id)
);
create index note_review_decisions_review_idx on public.note_review_decisions(review_id, project_id, id);
create index note_review_decisions_actor_idx on public.note_review_decisions(actor_id);
alter table public.note_review_decisions enable row level security;
revoke all on public.note_review_decisions from anon, authenticated;
grant select on public.note_review_decisions to authenticated;
create policy "Members can read their projects' note review decisions" on public.note_review_decisions for select to authenticated
  using (project_id in (select private.readable_project_ids()));

-- PostgreSQL indexes Unicode codepoints, whereas editor offsets count UTF-16
-- code units. Map all sorted boundaries in one scan and reject split pairs.
create function private.note_review_offsets(source text, offsets integer[])
returns integer[] language plpgsql immutable set search_path = '' as $$
declare
  mapped integer[] := '{}'::integer[];
  unit_position integer := 0;
  character_position integer := 0;
  position_index integer := 1;
  piece text;
begin
  while position_index <= cardinality(offsets) and offsets[position_index] = 0 loop
    mapped := mapped || 0; position_index := position_index + 1;
  end loop;
  if position_index > cardinality(offsets) then return mapped; end if;
  for piece in select regexp_split_to_table(source, '') loop
    if piece = '' then continue; end if;
    character_position := character_position + 1;
    unit_position := unit_position + case when octet_length(piece) = 4 then 2 else 1 end;
    while position_index <= cardinality(offsets) and offsets[position_index] <= unit_position loop
      if offsets[position_index] <> unit_position then
        raise exception 'A review range splits a Unicode character or is out of order' using errcode = '22023';
      end if;
      mapped := mapped || character_position; position_index := position_index + 1;
    end loop;
    exit when position_index > cardinality(offsets);
  end loop;
  if position_index <= cardinality(offsets) then raise exception 'A review range is outside its source' using errcode = '22023'; end if;
  return mapped;
end;
$$;
revoke all on function private.note_review_offsets(text, integer[]) from public, anon, authenticated;

create function private.note_review_utf16_length(source text)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(sum(case when piece = '' then 0 when octet_length(piece) = 4 then 2 else 1 end), 0)::integer
  from regexp_split_to_table(source, '') as p(piece)
$$;
revoke all on function private.note_review_utf16_length(text) from public, anon, authenticated;

create function private.note_review_keys(value jsonb, required text[], optional text[] default '{}')
returns void language plpgsql immutable set search_path = '' as $$
declare field text;
begin
  if jsonb_typeof(value) is distinct from 'object' then raise exception 'A review object is malformed' using errcode = '22023'; end if;
  foreach field in array required loop
    if not value ? field then raise exception 'A review object is missing %', field using errcode = '22023'; end if;
  end loop;
  for field in select jsonb_object_keys(value) loop
    if not field = any(required || optional) then raise exception 'Unknown review field: %', left(field, 100) using errcode = '22023'; end if;
  end loop;
end;
$$;
revoke all on function private.note_review_keys(jsonb, text[], text[]) from public, anon, authenticated;

create function private.note_review_string(value jsonb, maximum integer, nonempty boolean default false)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(value) is distinct from 'string' or private.note_review_utf16_length(value #>> '{}') > maximum
    or (nonempty and (value #>> '{}') = '') then raise exception 'A review string is malformed or too long' using errcode = '22023'; end if;
end;
$$;
revoke all on function private.note_review_string(jsonb, integer, boolean) from public, anon, authenticated;

create function private.note_review_integer(value jsonb)
returns integer language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(value) is distinct from 'number' or (value #>> '{}') !~ '^(0|[1-9][0-9]{0,8})$'
    or (value #>> '{}')::bigint > 4194304 then raise exception 'A review offset is malformed' using errcode = '22023'; end if;
  return (value #>> '{}')::integer;
end;
$$;
revoke all on function private.note_review_integer(jsonb) from public, anon, authenticated;

create function private.note_review_apply(source text, suggestions jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  offsets integer[] := '{}'::integer[];
  mapped integer[];
  previous_to integer := -1;
  from_offset integer;
  to_offset integer;
  position_index integer := 1;
  previous_character integer := 0;
  segments text[] := '{}'::text[];
  ids text[] := '{}'::text[];
begin
  if source is null or octet_length(source) > 2097152 or jsonb_typeof(suggestions) is distinct from 'array'
    or jsonb_array_length(suggestions) > 256 then raise exception 'Review source or suggestion count is too large' using errcode = '22023'; end if;
  for item in select jsonb_array_elements(suggestions) loop
    perform private.note_review_keys(item, array['id','from','to','expected','insert'], array['sourceIds','edited']);
    perform private.note_review_string(item -> 'id', 256, true);
    if item ->> 'id' = any(ids) then raise exception 'Review suggestion IDs must be unique' using errcode = '22023'; end if;
    ids := ids || (item ->> 'id');
    from_offset := private.note_review_integer(item -> 'from'); to_offset := private.note_review_integer(item -> 'to');
    if from_offset <= previous_to or to_offset < from_offset then raise exception 'Review suggestions must be ordered and separate' using errcode = '22023'; end if;
    previous_to := to_offset;
    perform private.note_review_string(item -> 'expected', 2097152); perform private.note_review_string(item -> 'insert', 2097152);
    if item ->> 'expected' = item ->> 'insert' then raise exception 'A review suggestion must change text' using errcode = '22023'; end if;
    if item ? 'edited' and item -> 'edited' <> 'true'::jsonb then raise exception 'Invalid review edited flag' using errcode = '22023'; end if;
    offsets := offsets || from_offset || to_offset;
  end loop;
  mapped := private.note_review_offsets(source, offsets);
  for item in select jsonb_array_elements(suggestions) loop
    if substring(source from mapped[position_index] + 1 for mapped[position_index + 1] - mapped[position_index]) <> item ->> 'expected' then
      raise exception 'A review suggestion does not match its original text' using errcode = '22023';
    end if;
    segments := segments || substring(source from previous_character + 1 for mapped[position_index] - previous_character) || (item ->> 'insert');
    previous_character := mapped[position_index + 1]; position_index := position_index + 2;
  end loop;
  select string_agg(part.value, '' order by part.ordinality) into source
    from unnest(segments || substring(source from previous_character + 1)) with ordinality part(value, ordinality);
  if octet_length(source) > 2097152 then raise exception 'Proposed review source is larger than 2 MiB' using errcode = '22023'; end if;
  return source;
end;
$$;
revoke all on function private.note_review_apply(text, jsonb) from public, anon, authenticated;

-- Validate the complete wire contract, including retained import provenance.
create function private.note_review_payload_source(payload jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  provenance jsonb;
  annotation jsonb;
  anchor jsonb;
  suggestion jsonb;
  reference jsonb;
  ids text[] := '{}'::text[];
  references_seen text[];
  field text;
  snapshot text;
  mapped integer[];
begin
  if octet_length(payload::text) > 4194304 then raise exception 'A review is larger than 4 MiB' using errcode = '22023'; end if;
  perform private.note_review_keys(payload, array['base','suggestions'], array['provenance']);
  if jsonb_typeof(payload -> 'base') is distinct from 'string' then raise exception 'A review needs its exact original source' using errcode = '22023'; end if;
  if payload ? 'provenance' then
    provenance := payload -> 'provenance';
    perform private.note_review_keys(provenance, array['label','annotations'], array['sourceSha256','base','proposed']);
    perform private.note_review_string(provenance -> 'label', 1024, true);
    if provenance ? 'sourceSha256' and (jsonb_typeof(provenance -> 'sourceSha256') <> 'string' or provenance ->> 'sourceSha256' !~ '^[a-fA-F0-9]{64}$') then
      raise exception 'Invalid imported source checksum' using errcode = '22023';
    end if;
    foreach field in array array['base','proposed'] loop
      if provenance ? field and (jsonb_typeof(provenance -> field) <> 'string' or octet_length(provenance ->> field) > 2097152) then
        raise exception 'Invalid imported source snapshot' using errcode = '22023';
      end if;
    end loop;
    if jsonb_typeof(provenance -> 'annotations') is distinct from 'array' or jsonb_array_length(provenance -> 'annotations') > 2048 then
      raise exception 'Invalid imported annotation count' using errcode = '22023';
    end if;
    for annotation in select jsonb_array_elements(provenance -> 'annotations') loop
      perform private.note_review_keys(annotation, array['id','kind'], array['sourceId','author','date','text','locator','rawXml','anchor']);
      perform private.note_review_string(annotation -> 'id', 256, true); perform private.note_review_string(annotation -> 'kind', 64, true);
      if annotation ->> 'id' = any(ids) then raise exception 'Imported annotation IDs must be unique' using errcode = '22023'; end if;
      ids := ids || (annotation ->> 'id');
      if annotation ? 'sourceId' then perform private.note_review_string(annotation -> 'sourceId', 256, true); end if;
      foreach field in array array['author','date','text','locator','rawXml'] loop
        if annotation ? field then perform private.note_review_string(annotation -> field,
          case field when 'text' then 65536 when 'locator' then 2048 when 'rawXml' then 131072 else 512 end); end if;
      end loop;
      if annotation ? 'anchor' then
        anchor := annotation -> 'anchor'; perform private.note_review_keys(anchor, array['projection','from','to'], array['quote']);
        if anchor ->> 'projection' not in ('base','proposed','docx-original','docx-accepted','docx-review') or jsonb_typeof(anchor -> 'projection') <> 'string'
          or private.note_review_integer(anchor -> 'to') < private.note_review_integer(anchor -> 'from') then raise exception 'Invalid imported annotation anchor' using errcode = '22023'; end if;
        if anchor ? 'quote' then perform private.note_review_string(anchor -> 'quote', 16384); end if;
        if anchor ->> 'projection' in ('base','proposed') then
          snapshot := provenance ->> (anchor ->> 'projection');
          if snapshot is null then raise exception 'An imported annotation needs its source snapshot' using errcode = '22023'; end if;
          mapped := private.note_review_offsets(snapshot, array[private.note_review_integer(anchor -> 'from'), private.note_review_integer(anchor -> 'to')]);
          if anchor ? 'quote' and substring(snapshot from mapped[1] + 1 for mapped[2] - mapped[1]) <> anchor ->> 'quote' then
            raise exception 'An imported annotation does not match its source snapshot' using errcode = '22023'; end if;
        end if;
      end if;
    end loop;
  end if;
  for suggestion in select jsonb_array_elements(payload -> 'suggestions') loop
    if suggestion ? 'sourceIds' then
      if jsonb_typeof(suggestion -> 'sourceIds') <> 'array' or jsonb_array_length(suggestion -> 'sourceIds') > 2048 then raise exception 'Invalid imported source references' using errcode = '22023'; end if;
      references_seen := '{}'::text[];
      for reference in select jsonb_array_elements(suggestion -> 'sourceIds') loop
        perform private.note_review_string(reference, 256, true);
        field := reference #>> '{}';
        if not field = any(ids) or field = any(references_seen) then raise exception 'Unknown or repeated imported source reference' using errcode = '22023'; end if;
        references_seen := references_seen || field;
      end loop;
    end if;
  end loop;
  return private.note_review_apply(payload ->> 'base', payload -> 'suggestions');
end;
$$;
revoke all on function private.note_review_payload_source(jsonb) from public, anon, authenticated;

create function private.note_review_compact_result(result jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_set(result #- '{review,original_bundle}', '{review,payload}', (result #> '{review,payload}') - 'provenance')
$$;
revoke all on function private.note_review_compact_result(jsonb) from public, anon, authenticated;

create function private.note_review_replay(project_id uuid, mutation_id uuid, request_hash bytea)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare receipt public.note_review_decisions; original jsonb; result jsonb;
begin
  select * into receipt from public.note_review_decisions d where d.project_id = note_review_replay.project_id and d.mutation_id = note_review_replay.mutation_id;
  if receipt.id is null then return null; end if;
  if receipt.actor_id is distinct from private.require_user() or receipt.request_hash <> note_review_replay.request_hash then
    raise exception 'This mutation id was already used for a different review operation' using errcode = '22023'; end if;
  select r.original_bundle into original from public.note_reviews r where r.id = receipt.review_id;
  result := jsonb_set(receipt.result, '{review,original_bundle}', original);
  if original ? 'provenance' then result := jsonb_set(result, '{review,payload,provenance}', original -> 'provenance'); end if;
  return result;
end;
$$;
revoke all on function private.note_review_replay(uuid, uuid, bytea) from public, anon, authenticated;

create function private.get_note_review(project_id uuid, file_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare review public.note_reviews;
begin
  perform private.require_user();
  if private.project_role(get_note_review.project_id) is null then raise exception 'Project unavailable' using errcode = '42501'; end if;
  select * into review from public.note_reviews r where r.project_id = get_note_review.project_id and r.file_id = get_note_review.file_id
    order by (r.status = 'open') desc, r.created_at desc, r.id desc limit 1;
  return jsonb_build_object('review', case when review.id is null then null else to_jsonb(review) end);
end;
$$;
revoke all on function private.get_note_review(uuid, uuid) from public, anon;
grant execute on function private.get_note_review(uuid, uuid) to authenticated;
create function public.get_note_review(project_id uuid, file_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$ select private.get_note_review(project_id, file_id) $$;
revoke all on function public.get_note_review(uuid, uuid) from public, anon;
grant execute on function public.get_note_review(uuid, uuid) to authenticated;

create function private.save_note_review(project_id uuid, file_id uuid, review_id uuid, expected_version bigint, base_version bigint, mutation_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_user(); p public.projects; review public.note_reviews; file public.project_files;
  request_hash bytea; result jsonb;
begin
  perform private.check_limit('saves_per_minute');
  if file_id is null or review_id is null or mutation_id is null or base_version is null then raise exception 'Review identifiers and saved version are required' using errcode = '22023'; end if;
  p := private.lock_project_for_edit(project_id, true);
  request_hash := sha256(convert_to(jsonb_build_array('save',project_id,file_id,review_id,expected_version,base_version,payload)::text, 'UTF8'));
  result := private.note_review_replay(project_id, mutation_id, request_hash); if result is not null then return result; end if;
  if p.archived_at is not null then raise exception 'Project is archived' using errcode = '55000'; end if;
  perform private.note_review_payload_source(payload);
  select * into file from public.project_files f where f.project_id = p.id and f.id = save_note_review.file_id;
  if file.id is null or file.kind <> 'text' or file.path !~* '\.mdx?$' or file.version <> base_version or file.content <> payload ->> 'base' then
    raise exception 'The saved note changed or disappeared. Keep the review for recovery.' using errcode = '40001'; end if;
  select * into review from public.note_reviews r where r.id = review_id;
  if review.id is not null and (review.project_id <> p.id or review.file_id <> file.id) then
    raise exception 'Review unavailable' using errcode = '42501'; end if;
  if expected_version is null then
    if review.id is not null or exists(select 1 from public.note_reviews r where r.project_id = p.id and r.file_id = file.id and r.status = 'open') then
      raise exception 'A shared review already exists. Reload it before saving.' using errcode = '40001'; end if;
    insert into public.note_reviews(id,project_id,file_id,path,base_version,payload,original_bundle,created_by,updated_by)
      values(review_id,p.id,file.id,file.path,file.version,payload,payload,uid,uid) returning * into review;
  else
    if review.id is null or review.project_id <> p.id or review.file_id <> file.id then raise exception 'Review unavailable' using errcode = '42501'; end if;
    if review.status <> 'open' then raise exception 'This review is closed' using errcode = '55000'; end if;
    if review.version <> expected_version or review.base_version <> file.version or review.path <> file.path or review.payload ->> 'base' <> file.content then
      raise exception 'This shared review changed. Reload it before saving.' using errcode = '40001'; end if;
    if payload -> 'provenance' is distinct from review.payload -> 'provenance' then raise exception 'Original review provenance cannot change' using errcode = '22023'; end if;
    update public.note_reviews r set payload = save_note_review.payload, version = r.version + 1, updated_by = uid, updated_at = now()
      where r.id = review.id returning * into review;
  end if;
  update public.projects set revision = revision + 1, updated_at = now() where id = p.id;
  result := jsonb_build_object('review', to_jsonb(review));
  insert into public.note_review_decisions(project_id,review_id,mutation_id,actor_id,action,request_hash,result)
    values(p.id,review.id,mutation_id,uid,'save',request_hash,private.note_review_compact_result(result));
  return result;
end;
$$;
revoke all on function private.save_note_review(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) from public, anon;
grant execute on function private.save_note_review(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) to authenticated;
create function public.save_note_review(project_id uuid, file_id uuid, review_id uuid, expected_version bigint, base_version bigint, mutation_id uuid, payload jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.save_note_review(project_id,file_id,review_id,expected_version,base_version,mutation_id,payload) $$;
revoke all on function public.save_note_review(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) from public, anon;
grant execute on function public.save_note_review(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) to authenticated;

create function private.decide_note_review(project_id uuid, review_id uuid, expected_version bigint, mutation_id uuid, decision text, suggestion_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := private.require_user(); p public.projects; review public.note_reviews; file public.project_files;
  request_hash bytea; result jsonb; selected jsonb; remaining jsonb := '[]'::jsonb; next_payload jsonb; item jsonb;
  next_source text; shift integer; saved jsonb; file_result jsonb := null;
begin
  if review_id is null or mutation_id is null or expected_version is null or decision is null or decision not in ('accept','reject') then raise exception 'Invalid review decision' using errcode = '22023'; end if;
  p := private.lock_project_for_edit(project_id, true);
  request_hash := sha256(convert_to(jsonb_build_array('decide',project_id,review_id,expected_version,decision,suggestion_id)::text,'UTF8'));
  result := private.note_review_replay(project_id,mutation_id,request_hash); if result is not null then return result; end if;
  if p.archived_at is not null then raise exception 'Project is archived' using errcode = '55000'; end if;
  select * into review from public.note_reviews r where r.id = review_id and r.project_id = p.id;
  if review.id is null then raise exception 'Review unavailable' using errcode = '42501'; end if;
  if review.status <> 'open' then raise exception 'This review is closed' using errcode = '55000'; end if;
  if review.version <> expected_version then raise exception 'This shared review changed. Reload it before deciding.' using errcode = '40001'; end if;
  select coalesce(jsonb_agg(s.value order by s.ordinality),'[]') into selected from jsonb_array_elements(review.payload -> 'suggestions') with ordinality s
    where suggestion_id is null or s.value ->> 'id' = suggestion_id;
  if jsonb_array_length(selected) = 0 then raise exception 'This suggestion is no longer pending' using errcode = '22023'; end if;
  next_source := review.payload ->> 'base';
  if decision = 'accept' then
    select * into file from public.project_files f where f.id = review.file_id and f.project_id = p.id;
    if file.id is null or file.kind <> 'text' or file.path <> review.path or file.version <> review.base_version or file.content <> next_source then
      raise exception 'The saved note changed or moved. Keep the review for recovery.' using errcode = '40001'; end if;
    next_source := private.note_review_apply(next_source,selected);
  else perform private.check_limit('saves_per_minute'); end if;
  for item in select jsonb_array_elements(review.payload -> 'suggestions') loop
    if exists(select 1 from jsonb_array_elements(selected) s where s ->> 'id' = item ->> 'id') then continue; end if;
    if decision = 'accept' then
      select coalesce(sum(private.note_review_utf16_length(s ->> 'insert') - ((s ->> 'to')::integer - (s ->> 'from')::integer)),0)::integer into shift
        from jsonb_array_elements(selected) s where (s ->> 'to')::integer <= (item ->> 'from')::integer;
      item := item || jsonb_build_object('from',(item ->> 'from')::integer + shift,'to',(item ->> 'to')::integer + shift);
    end if;
    remaining := remaining || jsonb_build_array(item);
  end loop;
  next_payload := review.payload || jsonb_build_object('base',next_source,'suggestions',remaining);
  perform private.note_review_payload_source(next_payload);
  if decision = 'accept' then
    saved := private.save_files(p.id,mutation_id,jsonb_build_array(jsonb_build_object('op','put','path',file.path,'base_version',file.version,'content',next_source)));
    if saved ->> 'status' <> 'saved' then raise exception 'The saved note changed before acceptance' using errcode = '40001'; end if;
    file.version := (saved #>> '{changes,0,version}')::bigint;
    file_result := jsonb_build_object('id',file.id,'path',file.path,'version',file.version,'content',next_source);
  else update public.projects set revision = revision + 1, updated_at = now() where id = p.id; end if;
  update public.note_reviews r set payload = next_payload, base_version = case when decision = 'accept' then file.version else r.base_version end,
    version = r.version + 1, updated_by = uid, updated_at = now() where r.id = review.id returning * into review;
  result := jsonb_build_object('review',to_jsonb(review),'file',file_result);
  insert into public.note_review_decisions(project_id,review_id,mutation_id,actor_id,action,request_hash,selected,result)
    values(p.id,review.id,mutation_id,uid,decision,request_hash,selected,private.note_review_compact_result(result));
  return result;
end;
$$;
revoke all on function private.decide_note_review(uuid, uuid, bigint, uuid, text, text) from public, anon;
grant execute on function private.decide_note_review(uuid, uuid, bigint, uuid, text, text) to authenticated;
create function public.decide_note_review(project_id uuid, review_id uuid, expected_version bigint, mutation_id uuid, decision text, suggestion_id text default null)
returns jsonb language sql security invoker set search_path = '' as $$ select private.decide_note_review(project_id,review_id,expected_version,mutation_id,decision,suggestion_id) $$;
revoke all on function public.decide_note_review(uuid, uuid, bigint, uuid, text, text) from public, anon;
grant execute on function public.decide_note_review(uuid, uuid, bigint, uuid, text, text) to authenticated;

create function private.finish_note_review(project_id uuid, review_id uuid, expected_version bigint, mutation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := private.require_user(); p public.projects; review public.note_reviews; request_hash bytea; result jsonb;
begin
  perform private.check_limit('saves_per_minute');
  if review_id is null or expected_version is null or mutation_id is null then raise exception 'Review identifiers and version are required' using errcode = '22023'; end if;
  p := private.lock_project_for_edit(project_id,true);
  request_hash := sha256(convert_to(jsonb_build_array('finish',project_id,review_id,expected_version)::text,'UTF8'));
  result := private.note_review_replay(project_id,mutation_id,request_hash); if result is not null then return result; end if;
  if p.archived_at is not null then raise exception 'Project is archived' using errcode = '55000'; end if;
  select * into review from public.note_reviews r where r.id = review_id and r.project_id = p.id;
  if review.id is null then raise exception 'Review unavailable' using errcode = '42501'; end if;
  if review.status <> 'open' then raise exception 'This review is closed' using errcode = '55000'; end if;
  if review.version <> expected_version then raise exception 'This shared review changed. Reload it before finishing.' using errcode = '40001'; end if;
  if jsonb_array_length(review.payload -> 'suggestions') <> 0 then raise exception 'Accept or reject the remaining suggestions first' using errcode = '22023'; end if;
  update public.note_reviews r set status = 'closed', closed_at = now(), version = r.version + 1, updated_by = uid, updated_at = now() where r.id = review.id returning * into review;
  update public.projects set revision = revision + 1, updated_at = now() where id = p.id;
  result := jsonb_build_object('review',to_jsonb(review));
  insert into public.note_review_decisions(project_id,review_id,mutation_id,actor_id,action,request_hash,result)
    values(p.id,review.id,mutation_id,uid,'finish',request_hash,private.note_review_compact_result(result));
  return result;
end;
$$;
revoke all on function private.finish_note_review(uuid, uuid, bigint, uuid) from public, anon;
grant execute on function private.finish_note_review(uuid, uuid, bigint, uuid) to authenticated;
create function public.finish_note_review(project_id uuid, review_id uuid, expected_version bigint, mutation_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$ select private.finish_note_review(project_id,review_id,expected_version,mutation_id) $$;
revoke all on function public.finish_note_review(uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.finish_note_review(uuid, uuid, bigint, uuid) to authenticated;
