-- Written by hand: data, not schema. The migration before this one makes
-- drawings searchable, but the trigger queues a file only when it is saved or
-- renamed, so drawings saved before now are queued for the `embed` function
-- here, once, with the message the trigger sends.
select pgmq.send('file_passages', jsonb_build_object('fileId', id))
from public.project_files
where path ~* '\.excalidraw(\.md)?$';
