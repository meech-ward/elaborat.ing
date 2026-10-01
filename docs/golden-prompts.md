# Golden prompts

Prompts for checking that an agent uses elaborat.ing's tools when it should,
and leaves them alone when it should not. Run them in a chat with
elaborat.ing connected (a custom connector in Claude, developer mode in
ChatGPT) whenever a tool's name, description, annotations or the server's
instructions change, and note which tools each prompt called. A prompt that
calls the wrong tool, or none, is a regression.

The test cases for a directory submission come from here: the five prompts
marked **Submit** under Direct and Indirect, and the three marked **Submit**
under Negative. They are copied into the plugin's manifest
(`plugins/elaborating/plugin.json`, `review.test_cases`); change both
together ([submitting the plugin](submission.md)).

**Setup:** an account whose project was started from the welcome project
(`welcome.mdx`, which embeds the drawing `sketch.excalidraw` and the diagram
`flow.d2`), with one open comment on `welcome.mdx`. Sign in with a password;
the reviewer's account needs no codes or links.

## Direct: the prompt names elaborat.ing

| Prompt | Expected |
| --- | --- |
| **Submit.** Show me the welcome note from my elaborat.ing project. | `list_projects`, then `show_file` on `welcome.mdx`. The card shows the note with its drawing and diagram, and Open in elaborat.ing. |
| **Submit.** In elaborat.ing, add a note called `meeting.mdx` to my welcome project with three action items from today's standup, then show it. | `write_file` with a new `.mdx` (no `base_version`), then `show_file`. |
| **Submit.** Draw a simple drawing in elaborat.ing of three boxes, Browser, Worker and Database, joined by arrows, and show it to me. | `write_file` with a new `.excalidraw` scene, then `show_file`, which draws it. |
| What's in my elaborat.ing projects? | `list_projects`, then `list_files` for one or more. No card. |
| Edit the welcome note in elaborat.ing: change the first heading to "Hello". | `read_file`, then `write_file` with the `base_version` it read. |
| Add a D2 diagram of a sign-up flow to my elaborat.ing project. | `write_file` with a new `.d2` file. Shown with `show_file`, the card says to open it in elaborat.ing to draw it, since the app lays diagrams out. |
| Preview a component in elaborat.ing that shows a number with a label. | `preview_component` with a draft `source`. Nothing is saved. |
| Which elaborat.ing account am I connected with? | `whoami`: the account's id, name and email. |
| Watch this project for review comments. | `list_projects`, then, where the host supports MCP Events, a subscription to `comment.created` for that project (`events/subscribe`, not a tool). Each event is a thread the person asked an agent about; the agent reads it with `list_comments` and `read_file` before acting. Where the host cannot subscribe, the agent says so and offers to check now with `list_comments` and `ask_agent`. |

## Indirect: the prompt fits elaborat.ing without naming it

| Prompt | Expected |
| --- | --- |
| **Submit.** Leave a comment on the "Drawings and diagrams" heading of my welcome note: "Add a caption here." | `add_comment` on that heading of `welcome.mdx`. |
| **Submit.** Find my notes that mention D2. | `search` with a query about D2. Passages from `welcome.mdx`. |
| Work through the comments on my welcome note. | `list_comments` with the path, then `read_file`, `write_file` for each change, and `reply_comment` or `resolve_comment` on each thread. |
| Rename my welcome project to "Scratchpad". | `list_projects`, then `rename_project`. |
| Archive the project I'm not using any more. | `list_projects`, then `archive_project` after the person confirms which one. |

## Negative: elaborat.ing's tools should not run

| Prompt | Expected |
| --- | --- |
| **Submit.** What's the weather in Paris tomorrow? | No elaborat.ing tool. |
| **Submit.** Rewrite this paragraph so it's shorter: "Our team met on Tuesday to talk about the launch, and we agreed on most things." | No elaborat.ing tool: nothing asks to save or show a file. |
| **Submit.** Permanently delete all my elaborat.ing projects. | No tool deletes a project for good, so none is called for it. The agent says a project is deleted in the app, and may offer to archive instead, which it does only after the person confirms. |
| Send my welcome note to my team by email. | No elaborat.ing tool sends email. The agent may offer `share_project`, which invites another account, only if asked. |
| Make a slide deck about our launch. | No elaborat.ing tool, unless the person asks for it as a note in elaborat.ing. |
