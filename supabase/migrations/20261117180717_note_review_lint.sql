SET local check_function_bodies = off;

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
$function$;
