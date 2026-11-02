# Project categories

Design and implementation of flat, personal organization of projects.

## Behavior

- Home shows category cards such as **Video scripts**, with project counts,
  plus **All projects** and **Uncategorized**. With no categories yet, the
  existing project grid remains available beside **New category**.
- Opening a category shows one filtered project grid. Its selection is in
  the URL so reload and browser Back preserve the view. Invitations remain
  independent; archived projects have their own subsection in the filter.
- A project may belong to several categories. **Categories…** on its menu
  changes those choices; **Add projects** inside a category selects readable
  projects without downloading their files.
- Categories are personal. Owners, editors, commenters and viewers can
  organize the projects they can read, including archived projects. These
  choices do not change another person's home page or project access.
- Creating and importing projects remain global actions outside a specific
  category. New projects start Uncategorized and can then be added to categories.
- Categories can be created, renamed, archived and restored. Archiving keeps
  the assignments and every project. An assignment to an archived category
  does not exclude a project from Uncategorized. Restoring brings those
  assignments back.
- The chat panel can browse the same categories; management remains on the
  full site, following the existing project-menu policy.
- Changes require a connection. The last successful account-scoped category
  snapshot is cached separately for offline browsing. Counts and project
  cards use the projects available in the current library, including the
  projects on this device when offline. Storage failure does not undo a
  successful server change.

## Data and access

Two new tables hold categories and their project associations. Category ids
are stable, client-chosen UUIDs. Names are trimmed and normalized, at most
160 characters, and unique among the account's active categories ignoring
case. Limits allow 128 active categories, 1,000 including archived ones, and
10,000 included project assignments in each category.

Only the owning account can read a category or change it. Association reads
also check current project access, so pending invitations and revoked access
expose no project ids or counts. Writes use the repository's existing private
checked function and public invoker wrapper pattern, with explicit grants,
RLS and pgTAP coverage. No category operation raises a project content
revision, changes its timestamps, moves its files or grants membership.

`list_project_categories` returns categories, including archived ones, with
their readable `project_ids`. Separate RPCs create, rename, archive/restore
and change membership. `set_project_categories` replaces a project's active
category assignments in one transaction after validating the whole request.
Archived assignments remain. Repeating an unchanged mutation does not raise
the category revision. There is no permanent category deletion API.

The browser keeps this metadata outside the legacy project IndexedDB rows.
Those rows are validated strictly by already-open older clients; organization
does not require changing their storage contract or file sync ledger. Each
category RPC binds its session to the intended account with the SDK's
[request header modifier](https://supabase.com/docs/reference/javascript/using-modifiers-setheader),
so a queued request cannot use a later account's session. Tokens stay in memory. Cache keys
include both the backend and account, and account deletion removes the cache.

Agents receive matching category tools. Existing project read/save responses
and portable project exports retain their current contracts; personal
organization is separate from project contents.

## Future shared groups

These categories do not create organizations or inherited permissions. A
later shared-group feature needs explicit membership, invitations and rules
for each project owner's authority. A personal category may contain projects
its owner can only view, so sharing it must never grant access to those
projects automatically. Stable category ids and separate associations leave
room for that design without changing project files.

## Verification

1. Generate the migration from the declared schema with the pinned CLI.
   Run pgTAP on a throwaway local stack for account isolation, role access,
   pending/revoked visibility, archive/restore, atomic changes, stable retries,
   limits and unchanged project revisions.
2. Validate RPC responses, cached data, account switching, stale async work,
   connection errors and unavailable browser storage with focused tests.
3. Exercise category browsing, assignment, rename, archive/restore, Back and
   reload, offline browsing, phone layouts, keyboard controls and accessibility
   in Chromium and Firefox. Preserve the no-category home, invitations,
   existing project actions and chat-panel restrictions.
4. Run build, typecheck, lint, unit and Edge Function tests, card freshness and
   the first-paint bundle checks. Wait for CI and automatic deployment, then
   verify the hosted category flow without touching existing user projects.

## Implementation checks

The implementation passed 949 database tests on a clean throwaway stack,
including 114 category cases, with no schema regeneration drift or advisor
warnings. The application passed 1,428 unit tests and 100 relevant browser
journeys across Chromium and Firefox, including the 24 category journeys.
All 188 MCP tests passed. Production builds, typecheck, lint, card freshness
and first-paint bundle budgets passed. Hosted verification follows the
automatic deployment gate.
