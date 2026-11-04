# Project loading and offline readiness

A project can be available to read before it is complete offline. These are
separate states; the server revision on the local project continues to mean
that all changes through that revision, including validated image originals
and previews, have been durably ingested.

On a first open, the requested file is read through the normal authenticated,
RLS-protected `project_files` query. It is stored with its authoritative file
version and content token before the workbench opens. A requested image
prepares its own verified original and preview before opening its viewer.
The remaining file and folder metadata is pulled independently, then image originals and previews
are prepared with bounded concurrency. Each completed asset is published as
soon as its durable transaction commits. A missing catalog entry refreshes
only the catalog, without waiting for other projects' pulls.

Partial pulls use account-partitioned IndexedDB v3 records, with a durable
`partial` marker holding the target revision and whether all metadata arrived.
Upgrading closes older database connections through IndexedDB versionchange;
older app tabs must reload before writing. Current builds show explicit reload
guidance after a version change. Pre-v3 builds can only display their existing
browser VersionError; they cannot understand the new partial marker. Stored
drafts survive the upgrade, and any typing not yet persisted stays in the old
tab until it is copied or recovered before reload.
Legacy projects with a nonzero checkpoint retain their complete-data meaning.
The upgrade marks revision-zero remote rows as partial because an interrupted
legacy first download may have stored only its project header. An authenticated
catalog confirmation clears that marker for a truly empty project.

Publishing files early does not change the project revision or create a second source
model. A reload or interrupted download repeats the pull from
the previous complete revision. Reapplying identical file versions is a
no-op. Local edits, unsaved drafts and conflicts retain their existing
protection and hold the checkpoint below their remote version. Immutable
image identities are checked against their digest and metadata before reuse;
missing or failed bytes remain unavailable, and storage quota failures leave
the previous checkpoint intact.

Opening another path during a partial metadata pull uses an independent,
cancellable requested-file read and leaves the healthy bulk pull running.
A selected known image starts ahead of unrelated queued images. Immutable
transfers already in flight are shared rather than downloaded twice. A
canceled foreground waiter does not abort a healthy background transfer.

The library reports background preparation separately from a successful sync.
Failed preparation shows a safe explanation and an explicit retry action.
Changing projects or accounts aborts metadata and original/preview image
requests with the official SDK cancellation APIs and prevents a late response
from opening the previous project. Completed durable data stays in its own
backend/account partition. Access failures stop the affected pull; no new
account can consume the previous account's data. Explicit Sync still waits
for its complete pull, and project ZIP download waits for complete preparation
before taking its snapshot. Offline snapshots refuse partial metadata or
missing image bytes. Reconnecting after an offline restart revalidates the
session before resuming the authenticated pull. View-bound queued syncs cancel
on departure. An already-sent save is allowed to settle; any successful
acknowledgement is stored before optional pull cancellation. A lost response
retains its mutation identity for retry.
