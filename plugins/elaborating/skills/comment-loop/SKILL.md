---
name: comment-loop
description: Work through the open comments people left on notes, drawings and diagrams in an elaborat.ing project. Makes each requested change and replies in the thread; the person resolves it. Use when the user asks to address, answer or work through comments, review feedback or requested changes in elaborat.ing.
---

# Work through comments

The user's instructions win over this skill when they differ, for example when
they ask you to resolve threads or to handle only some of them.

1. Find the project with `list_projects`. Ask when more than one could be meant.
2. Call `list_comments` with the `project_id` and no `path`. It returns how many
   open and resolved threads each file has. Work on the files with open threads.
3. For each file, call `list_comments` with its `path` for its open threads, and
   `read_file` for its content and `version`.
   - `anchor` says what a thread is about: quoted text and its line, a note's
     heading, a drawing element, or the whole file.
   - `attached: false` means that text or element is gone. Judge from
     `original_quote`, and ask the user when the intent is unclear.
   - A thread whose last comment is your own earlier reply (`via_agent`) is
     waiting on the person. Skip it unless they replied after you.
4. Make the change each comment asks for, and nothing else. Save with
   `write_file` and the `base_version` you read. A save returns the file's new
   version: use it for your next save of that file. If the result is a
   conflict, read the file again, merge your change in and save again.
   - Diagram comments sit on the `.excalidraw` canvas; change the diagram by
     editing its `.d2` source.
5. Reply in each thread with `reply_comment`: one or two plain sentences on what
   you changed. If a request is unclear, or you think it is wrong, ask or say
   so in the reply instead of changing the file.
6. Leave the threads open. The person resolves each one after checking your
   change. Use `resolve_comment` only when the user asks you to.
7. End with a short summary: what changed in each file, and which threads are
   waiting for the person. Offer to show a changed file with `show_file`.
