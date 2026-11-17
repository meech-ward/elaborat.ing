SET local check_function_bodies = off;

CREATE TABLE "public"."note_review_decisions" (
  "id"           bigint                   GENERATED ALWAYS AS IDENTITY NOT NULL,
  "project_id"   uuid                     NOT NULL,
  "review_id"    uuid                     NOT NULL,
  "mutation_id"  uuid                     NOT NULL,
  "actor_id"     uuid,
  "action"       text                     NOT NULL,
  "request_hash" bytea                    NOT NULL,
  "selected"     jsonb                    NOT NULL DEFAULT '[]'::jsonb,
  "result"       jsonb                    NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "note_review_decisions_action_check" CHECK ((action = ANY (ARRAY['save'::text, 'accept'::text, 'reject'::text, 'finish'::text]))),
  CONSTRAINT "note_review_decisions_pkey" PRIMARY KEY (id),
  CONSTRAINT "note_review_decisions_project_id_mutation_id_key" UNIQUE (project_id, mutation_id)
);

ALTER TABLE "public"."note_review_decisions"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."note_review_decisions" FROM "anon";

CREATE TABLE "public"."note_reviews" (
  "id"              uuid                     NOT NULL,
  "project_id"      uuid                     NOT NULL,
  "file_id"         uuid                     NOT NULL,
  "path"            text                     COLLATE pg_catalog."C" NOT NULL,
  "base_version"    bigint                   NOT NULL,
  "version"         bigint                   NOT NULL DEFAULT 1,
  "status"          text                     NOT NULL DEFAULT 'open'::text,
  "payload"         jsonb                    NOT NULL,
  "original_bundle" jsonb                    NOT NULL,
  "created_by"      uuid,
  "updated_by"      uuid,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "closed_at"       timestamp with time zone,
  CONSTRAINT "note_reviews_base_version_check" CHECK ((base_version > 0)),
  CONSTRAINT "note_reviews_check" CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
  CONSTRAINT "note_reviews_id_project_id_key" UNIQUE (id, project_id),
  CONSTRAINT "note_reviews_original_bundle_check" CHECK (((jsonb_typeof(original_bundle) = 'object'::text) AND (octet_length((original_bundle)::text) <= 4194304))),
  CONSTRAINT "note_reviews_payload_check" CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 4194304))),
  CONSTRAINT "note_reviews_pkey" PRIMARY KEY (id),
  CONSTRAINT "note_reviews_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text]))),
  CONSTRAINT "note_reviews_version_check" CHECK ((version > 0)),
  CONSTRAINT "note_reviews_path_check" CHECK (private.is_valid_path(path))
);

ALTER TABLE "public"."note_reviews"
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "public"."note_reviews" FROM "anon";

CREATE OR REPLACE FUNCTION private.decide_note_review (
  project_id       uuid,
  review_id        uuid,
  expected_version bigint,
  mutation_id      uuid,
  decision         text,
  suggestion_id    text   DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare
  uid uuid := private.require_user(); p public.projects; review public.note_reviews; file public.project_files;
  request_hash bytea; result jsonb; selected jsonb; remaining jsonb := '[]'; next_payload jsonb; item jsonb;
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
$function$;

CREATE OR REPLACE FUNCTION private.finish_note_review (
  project_id       uuid,
  review_id        uuid,
  expected_version bigint,
  mutation_id      uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.get_note_review (
  project_id uuid,
  file_id    uuid
)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
declare review public.note_reviews;
begin
  perform private.require_user();
  if private.project_role(get_note_review.project_id) is null then raise exception 'Project unavailable' using errcode = '42501'; end if;
  select * into review from public.note_reviews r where r.project_id = get_note_review.project_id and r.file_id = get_note_review.file_id
    order by (r.status = 'open') desc, r.created_at desc, r.id desc limit 1;
  return jsonb_build_object('review', case when review.id is null then null else to_jsonb(review) end);
end;
$function$;

CREATE OR REPLACE FUNCTION private.note_review_apply (
  source      text,
  suggestions jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  item jsonb;
  offsets integer[] := '{}';
  mapped integer[];
  previous_to integer := -1;
  from_offset integer;
  to_offset integer;
  position_index integer := 1;
  previous_character integer := 0;
  segments text[] := '{}';
  ids text[] := '{}';
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
  source := array_to_string(segments || substring(source from previous_character + 1), '');
  if octet_length(source) > 2097152 then raise exception 'Proposed review source is larger than 2 MiB' using errcode = '22023'; end if;
  return source;
end;
$function$;

CREATE OR REPLACE FUNCTION private.note_review_compact_result (
  result jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select jsonb_set(result #- '{review,original_bundle}', '{review,payload}', (result #> '{review,payload}') - 'provenance')
$function$;

CREATE OR REPLACE FUNCTION private.note_review_integer (
  value jsonb
)
  RETURNS integer
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if jsonb_typeof(value) is distinct from 'number' or (value #>> '{}') !~ '^(0|[1-9][0-9]{0,8})$'
    or (value #>> '{}')::bigint > 4194304 then raise exception 'A review offset is malformed' using errcode = '22023'; end if;
  return (value #>> '{}')::integer;
end;
$function$;

CREATE OR REPLACE FUNCTION private.note_review_keys (
  value    jsonb,
  required text[],
  optional text[] DEFAULT '{}'::text[]
)
  RETURNS void
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.note_review_offsets (
  source  text,
  offsets integer[]
)
  RETURNS integer[]
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  mapped integer[] := '{}';
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
$function$;

CREATE OR REPLACE FUNCTION private.note_review_payload_source (
  payload jsonb
)
  RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
declare
  provenance jsonb;
  annotation jsonb;
  anchor jsonb;
  suggestion jsonb;
  reference jsonb;
  ids text[] := '{}';
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
      references_seen := '{}';
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
$function$;

CREATE OR REPLACE FUNCTION private.note_review_replay (
  project_id   uuid,
  mutation_id  uuid,
  request_hash bytea
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION private.note_review_string (
  value    jsonb,
  maximum  integer,
  nonempty boolean DEFAULT false
)
  RETURNS void
  LANGUAGE plpgsql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
begin
  if jsonb_typeof(value) is distinct from 'string' or private.note_review_utf16_length(value #>> '{}') > maximum
    or (nonempty and (value #>> '{}') = '') then raise exception 'A review string is malformed or too long' using errcode = '22023'; end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.note_review_utf16_length (
  source text
)
  RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  SET search_path TO ''
  AS $function$
  select coalesce(sum(case when piece = '' then 0 when octet_length(piece) = 4 then 2 else 1 end), 0)::integer
  from regexp_split_to_table(source, '') as p(piece)
$function$;

CREATE OR REPLACE FUNCTION private.save_note_review (
  project_id       uuid,
  file_id          uuid,
  review_id        uuid,
  expected_version bigint,
  base_version     bigint,
  mutation_id      uuid,
  payload          jsonb
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
  AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.decide_note_review (
  project_id       uuid,
  review_id        uuid,
  expected_version bigint,
  mutation_id      uuid,
  decision         text,
  suggestion_id    text   DEFAULT NULL::text
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.decide_note_review(project_id,review_id,expected_version,mutation_id,decision,suggestion_id) $function$;

REVOKE ALL ON FUNCTION "public"."decide_note_review"(uuid, uuid, bigint, uuid, text, text) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.finish_note_review (
  project_id       uuid,
  review_id        uuid,
  expected_version bigint,
  mutation_id      uuid
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.finish_note_review(project_id,review_id,expected_version,mutation_id) $function$;

REVOKE ALL ON FUNCTION "public"."finish_note_review"(uuid, uuid, bigint, uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.get_note_review (
  project_id uuid,
  file_id    uuid
)
  RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path TO ''
  AS $function$ select private.get_note_review(project_id, file_id) $function$;

REVOKE ALL ON FUNCTION "public"."get_note_review"(uuid, uuid) FROM PUBLIC, "anon", "service_role";

CREATE OR REPLACE FUNCTION public.save_note_review (
  project_id       uuid,
  file_id          uuid,
  review_id        uuid,
  expected_version bigint,
  base_version     bigint,
  mutation_id      uuid,
  payload          jsonb
)
  RETURNS jsonb
  LANGUAGE sql
  SET search_path TO ''
  AS $function$ select private.save_note_review(project_id,file_id,review_id,expected_version,base_version,mutation_id,payload) $function$;

REVOKE ALL ON FUNCTION "public"."save_note_review"(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) FROM PUBLIC, "anon", "service_role";

ALTER TABLE "public"."note_review_decisions"
  ADD CONSTRAINT "note_review_decisions_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."note_review_decisions"
  ADD CONSTRAINT "note_review_decisions_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."note_reviews"
  ADD CONSTRAINT "note_reviews_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE "public"."note_review_decisions"
  ADD CONSTRAINT "note_review_decisions_review_id_project_id_fkey" FOREIGN KEY (review_id, project_id) REFERENCES public.note_reviews(id, project_id) ON DELETE CASCADE;

ALTER TABLE "public"."note_reviews"
  ADD CONSTRAINT "note_reviews_project_id_fkey" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE "public"."note_reviews"
  ADD CONSTRAINT "note_reviews_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX note_review_decisions_actor_idx ON public.note_review_decisions USING btree (actor_id);

CREATE INDEX note_review_decisions_review_idx ON public.note_review_decisions USING btree (review_id, project_id, id);

CREATE INDEX note_reviews_created_by_idx ON public.note_reviews USING btree (created_by);

CREATE INDEX note_reviews_file_history_idx ON public.note_reviews USING btree (project_id, file_id, created_at DESC, id);

CREATE UNIQUE INDEX note_reviews_one_open_file_idx ON public.note_reviews USING btree (project_id, file_id)
  WHERE (status = 'open'::text);

CREATE INDEX note_reviews_updated_by_idx ON public.note_reviews USING btree (updated_by);

CREATE POLICY "Members can read their projects' note review decisions" ON "public"."note_review_decisions"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

CREATE POLICY "Members can read their projects' note reviews" ON "public"."note_reviews"
  FOR SELECT
  TO "authenticated"
  USING ((project_id IN ( SELECT private.readable_project_ids() AS readable_project_ids)));

REVOKE ALL ON FUNCTION "private"."decide_note_review"(uuid, uuid, bigint, uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."decide_note_review"(uuid, uuid, bigint, uuid, text, text) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."finish_note_review"(uuid, uuid, bigint, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."finish_note_review"(uuid, uuid, bigint, uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."get_note_review"(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."get_note_review"(uuid, uuid) TO "authenticated", "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_apply"(text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_apply"(text, jsonb) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_compact_result"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_compact_result"(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_integer"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_integer"(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_keys"(jsonb, text[], text[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_keys"(jsonb, text[], text[]) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_offsets"(text, integer[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_offsets"(text, integer[]) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_payload_source"(jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_payload_source"(jsonb) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_replay"(uuid, uuid, bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_replay"(uuid, uuid, bytea) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_string"(jsonb, integer, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_string"(jsonb, integer, boolean) TO "postgres";

REVOKE ALL ON FUNCTION "private"."note_review_utf16_length"(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."note_review_utf16_length"(text) TO "postgres";

REVOKE ALL ON FUNCTION "private"."save_note_review"(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "private"."save_note_review"(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."decide_note_review"(uuid, uuid, bigint, uuid, text, text) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."finish_note_review"(uuid, uuid, bigint, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."get_note_review"(uuid, uuid) TO "authenticated", "postgres";

GRANT EXECUTE ON FUNCTION "public"."save_note_review"(uuid, uuid, uuid, bigint, bigint, uuid, jsonb) TO "authenticated", "postgres";

REVOKE ALL ON TABLE "public"."note_review_decisions" FROM "authenticated";

GRANT SELECT ON TABLE "public"."note_review_decisions" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."note_review_decisions" TO "postgres";

REVOKE ALL ON TABLE "public"."note_review_decisions" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."note_review_decisions" TO "service_role";

REVOKE ALL ON TABLE "public"."note_reviews" FROM "authenticated";

GRANT SELECT ON TABLE "public"."note_reviews" TO "authenticated";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."note_reviews" TO "postgres";

REVOKE ALL ON TABLE "public"."note_reviews" FROM "service_role";

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."note_reviews" TO "service_role";
