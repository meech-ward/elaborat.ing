# Product

elaborat.ing is a documents-and-diagrams workspace for people who like Markdown,
and for the AI agents they work with. It is open source (MIT). This page
describes what it is being built to do; see the [roadmap](roadmap.md) for
what exists so far. When it launches, anyone will be able to run their own copy
on a free Supabase project, or sign up on the hosted instance at
https://elaborat.ing.

## Who it is for

Developer first, friendly for everyone.

- **Code surfaces are developer-grade and never dumbed down.** Source editing
  uses Monaco. D2 diagram code and MDX components get full editor support.
  Limiting these is frustrating, so we don't.
- **Everything else works for non-developers.** The rendered document, drawings,
  sharing and comments must be usable by someone who has never seen Markdown.
  A developer should be able to share a project with a coworker who isn't one,
  or ask them for one.

## What it does

- **Notes** in Markdown and MDX, with a source view (Monaco) and an editable
  rendered view. Rendered edits are precise source edits, never a second
  document model.
- **Custom MDX components** that anyone, or any agent, can write inside a
  project, with docs and an agent skill for building them. They run isolated
  (see [architecture](architecture.md#component-isolation)).
- **Drawings** as native Excalidraw canvases, embeddable in notes, exportable
  to PNG and SVG.
- **Diagrams** written in D2 code, laid out automatically into an editable
  native canvas. Manual canvas edits survive regeneration.
- **Projects** that hold files and folders. Each user has their own projects,
  invisible to everyone else unless shared.
- **Offline drafts.** Edits live in the browser until saved. Saves are
  revision-checked, and conflicts are recovered visibly, never overwritten.
- **Search** across every project a user can read, keyword and semantic
  (hybrid search).
- **Agents over MCP.** A user connects Claude, ChatGPT or any MCP client to
  their account with OAuth. The agent then works on their documents and
  diagrams as them, in the same back-and-forth a person would have with a
  collaborator.

## Agents

- **Access is the user's own.** An agent acts as the signed-in user, limited by
  the same database rules.
- **Agents can do everything except permanently delete.** Agents archive and
  unarchive. Only a person, signed in to the app, can permanently delete.
  This is enforced in the database, not only by leaving out a tool.
- **Risky tools ask first.** Sharing and archiving are marked destructive with
  the standard MCP annotation, so clients confirm with the user.
- **Agents can show, not just tell.** Inside Claude or ChatGPT (MCP Apps), an
  agent can display a read-only rendered document with its drawings, or a
  single drawing, with a link to open it in the app. It can also show a
  rendered preview of a component it is drafting, before saving it.
- **Users can see and revoke connected agents.**

## Sharing and comments

- **The project is the unit of sharing.** References between notes, drawings
  and diagrams live inside a project.
- **Roles:** viewer (the default), commenter, editor, plus the owner.
- **Editing is one person at a time.** Two editors cannot silently overwrite
  each other: the second save gets a conflict and recovery. Before sharing as
  editor, the app warns that real-time co-editing is not supported.
  Real-time co-editing is a possible future feature, and nothing should block it.
- **Invites by email**, including people without an account yet.
- **Comments** on a whole document, a section (heading), a text selection, or a
  drawing element. Comments stay attached as the document changes, and show as
  detached, with their original quote, if their text is gone.

## Accounts

- **Sign-in:** email and password, magic link, one-time code, passkeys, GitHub,
  Google, and phone codes. "Sign in with ChatGPT" gets added if OpenAI opens it
  to all apps. There is no "Sign in with Claude" for other apps. Connecting an
  agent is separate from signing in, and works with any sign-in method.
- **Hosted limits are generous and exist only to stop abuse.** Nobody should
  notice them in normal use.

## Self-hosting

"Self-hosting" here means running your own copy on your own Supabase Cloud
project: create a free project, apply this repo's Supabase configuration, and
deploy the static frontend anywhere. The hosted instance is the same code with
a custom domain. Self-hosted Supabase (running Supabase itself in Docker) isn't
a target yet.
