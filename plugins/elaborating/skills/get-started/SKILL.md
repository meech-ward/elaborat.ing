---
name: get-started
description: Get started with elaborat.ing after installing the plugin. Checks the connection, finds the user's projects and says what the plugin can do. Use right after install, or when the user asks how to start with elaborat.ing.
---

# Get started with elaborat.ing

The user's instructions win over this skill when they differ.

1. Call `whoami` to check the connection. If it fails, the user needs to sign in:
   they connect the elaborat.ing server and sign in with their elaborat.ing
   account when asked. They can create an account at https://elaborat.ing.
2. Call `list_projects`.
   - If they have projects, name a few and ask what they want to work on.
   - If they have none, offer to make a first project. Only on a yes:
     `create_project`, then save `diagrams/overview.d2` (a small D2 diagram)
     and `notes/welcome.mdx` (a heading, a short paragraph, a `<Callout>` and
     `<Diagram src="diagrams/overview.d2" />`) together with `save_files`, then
     `show_file` the note. A new diagram is drawn the first time it opens in
     the app, so give the user the note's link too.
3. In three short lines, say what they can ask for:
   - Write or edit notes in MDX, with drawings, D2 diagrams and charts.
   - Search everything in their projects.
   - Work through the comments people leave on their files, with a reply on
     each thread.

Keep it brief. Don't create or change anything until the user says yes.
