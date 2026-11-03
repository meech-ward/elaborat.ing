# Submitting the plugin to the ChatGPT directory

How to list the [plugin](../plugins/elaborating/) in the plugin directory that
ChatGPT and Codex share. It works the same for elaborat.ing and for a
self-hosted copy. OpenAI's own guide is
[Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission).

## What goes where

| What | Where it lives |
| --- | --- |
| Listing: name, descriptions, capabilities, links, icons, brand colours, starter prompts, screenshots | `plugins/elaborating/plugin.json`, `extensions.com.openai.interface` |
| Five positive and three negative test cases, release notes | `plugin.json`, `extensions.com.openai.review` and `publication` (imported with the ZIP) |
| The MCP server | `plugins/elaborating/mcp.json` |
| The domain token | `vars.OPENAI_APPS_CHALLENGE` in `wrangler.jsonc` |
| Reviewer sign-in and private instructions | The portal's secure Review details form, never the ZIP |
| Reviewer-accessible video link | Optional in the ZIP at `extensions.com.openai.review.demo_recording_url`, or entered in Review details; required for MCP review |

The test cases are the prompts marked **Submit** in
[golden prompts](golden-prompts.md); change both together. There is one
screenshot per starter prompt (`assets/screenshots/`, exactly 706 px wide and
400 to 860 px tall) of the chat card answering it. If you change a starter
prompt, replace its screenshot, or remove `screenshots`, which are optional.

**Self-hosting?** Point `mcp.json` at your own `<site>/mcp`, and the four
links in `plugin.json` (`websiteURL`, `supportURL`, `privacyPolicyURL`,
`termsOfServiceURL`) at your own pages. The links must be HTTPS and must
identify the same publisher as the submission: the support, privacy and terms
pages name the publisher and its contact address (`PUBLISHER` and
`CONTACT_EMAIL` in `src/features/legal/LegalPage.tsx`, with `developerName`
and `author` in `plugin.json` to match), so change them to yours.

## 1. Verify the publisher

On [platform.openai.com](https://platform.openai.com), choose the organization
that will own the plugin and complete individual or business verification in
its settings. The directory shows the verified name, whatever
`developerName` says. Only an organization owner, or a member with Apps
Management Write, can submit. Verification can take a few days, so start here.

## 2. Make the reviewer account

Reviewers sign in with an email and a password only: no passkey, no emailed
link or code, nothing on a private network. Make an account just for them:

1. In a private window, open your site signed out and press **Start
   writing**. The local project opens with the welcome note (`welcome.mdx`,
   with the drawing `sketch.excalidraw` and the diagram `flow.d2`).
2. Change something small in `welcome.mdx` and save (Ctrl+S, or Cmd+S on a
   Mac). An unchanged welcome project stays on the device when you sign up; a
   changed one moves into the account.
3. Go to `<site>/sign-up` in the same window. Sign up with a mailbox you
   control and a password, and confirm by entering the emailed code on that
   page (the emailed link works too, if it opens in the same window). The
   project moves into the account as "Local project". Rename it "Welcome",
   since the test cases call it the welcome project.
4. In `welcome.mdx`, select the line "A note can show the drawings and
   diagrams in its project.", press **Comment**, write "Add a caption under
   the drawing.", turn on **Ask an agent**, and post it. Leave it open: the
   first starter prompt works through it.
5. Sign out, then sign in again with only the email and password, to check
   that nothing else is asked for.

Keep the account and its sample project as they are for later reviews.

## 3. Record the video

Connect your MCP URL in ChatGPT's developer mode, signed in as the reviewer
account. Run the five positive and three negative test cases, and record the
actual prompts, results and plugin functionality. Upload the recording where
a reviewer can open it without signing in (an unlisted video works), verify
playback, and keep the link for step 6. OpenAI's
[submission guide](https://developers.openai.com/plugins/deploy/submission#configure-onboarding-review-and-publication)
allows the URL in `review.demo_recording_url` in the ZIP or in an editable
portal field; the recording is required for MCP review.

Separately, test ChatGPT on desktop and mobile, including the UI, as required
by the [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines#testing).

## 4. Package

```bash
bun run package:plugin
```

It writes `dist-plugin/elaborating-<version>.zip` and lists what is in it.
It refuses when the folder has something the portal rejects: app references
(`apps`, `.app.json`), lifecycle hooks, `test_credentials` or
`reviewer_instructions`, hidden files, or a listing path to a missing file.
Every upload needs a new `version` in `plugin.json`.

## 5. Upload and connect

1. Open [Plugins](https://platform.openai.com/plugins), choose **Upload new
   or existing plugin**, pick your verified developer identity, and upload
   the ZIP.
2. **Metadata & Skills** runs checks on the listing and scans the skills
   (up to two hours). Fix anything under **Issues**, bump the version,
   package again and upload the new ZIP.
3. **MCPs**: select the server and **Connect**. The URL is your
   `<site>/mcp`, with OAuth.
4. Domain verification: the portal shows a token. Add it to `vars` in
   `wrangler.jsonc`, next to `MCP_UPSTREAM`:

   ```jsonc
   "OPENAI_APPS_CHALLENGE": "<the token>"
   ```

   and deploy. `<site>/.well-known/openai-apps-challenge` then answers with
   the token as plain text. Press verify.
5. Complete the sign-in as the reviewer account, and wait for the tool scan.
   Fix anything under **Issues**. If the portal asks why a tool has its
   hints, the reasons are in [architecture](architecture.md) (every tool
   states its three hints). The card loads its editor, component previews,
   fonts and diagram engine (D2, about 6 MB the first time a chat shows a
   diagram it draws) from your site, which is the only other origin it uses.
   The Projects panel (`open_panel`) frames your site, which needs a frame
   domain justification; to submit without it, set the `EMBED_VIEW_ENABLED`
   function secret to `false` first.

## 6. Review details and submit

1. In **Metadata & Skills**, open **Review information**, then **Review
   details**. Check the imported test cases and release notes.
2. Enter the reviewer account: the sign-in URL (`<site>/sign-in`), its email
   and password, and short instructions: "Sign in with the email and
   password. The Welcome project has the sample note welcome.mdx, with a
   drawing, a diagram and one open comment."
3. Check the imported video link, or enter it if the ZIP omits
   `review.demo_recording_url`, and save the details.
4. **Submit for review** and complete the attestations. The decision comes by
   email; after approval you choose when to publish.

Changes to the MCP server's tools are picked up by a daily scan (or
**Rescan**) without a new ZIP. Changes to the listing, the skills or
`mcp.json` need a new version and a new ZIP.

## Verification recorded on 2026-11-03

All 41 MCP tool names have successful protocol coverage across the dedicated
reviewer Inspector connection and controlled personal-account fixtures.
`panel_pass` and `panel_origins` were manual protocol checks. Genuine Inspector
cards and App bridge calls were observed; a separate personal Claude
connection also rendered a `show_file` card for a temporary synthetic note.
The five positive and three negative review cases passed in one ChatGPT
desktop chat scoped to a temporary reviewer project, with CSP enforcement
for custom apps enabled. P1's original wording,
"Show me the welcome note from my elaborat.ing project.", **Failed** its first attempt:
ChatGPT returned MDX source without the expected file card. The clarified
wording, "Show me the welcome note from my elaborat.ing
project as a file card in this chat.", **Passed**. A separate explicit
`show_file` diagnostic rendered the real note, Excalidraw drawing and D2
diagram with CSP enforcement for custom apps enabled; that records UI
rendering separately from the natural-prompt case.

| Case | Result and evidence |
| --- | --- |
| P1: show the welcome note as a file card | Passed: `welcome.mdx` v1 card, correct heading and callout, drawing and diagram containers, and Open link. |
| P2: create and show the supplied action items | Passed: `meeting.mdx` v3 card and backend content contained the three supplied checkbox items without invented facts. |
| P3: draw Browser, Worker and Database | Passed: v4 drawing card and backend scene contained three rectangles and two arrows bound to the boxes. |
| P4: add a comment to the welcome heading | Passed: UI and backend confirmed the exact open comment anchored to the heading. |
| P5: find notes mentioning D2 | Passed: visible MCP activity reported "Searched for d2 references" and returned one `welcome.mdx` match in the selected project. |
| N1: weather in Paris | Passed: weather response; expanded visible activity showed forecast commentary and no elaborat.ing tool entry. |
| N2: shorten the supplied paragraph | Passed: shortened text with no elaborat.ing entry in visible activity. |
| N3: permanently delete all projects | Passed: refused permanent deletion; expanded visible activity contained scope and capability text with no elaborat.ing tool entry. |

Negative-case tool evidence is the activity visible in ChatGPT. At the end
of the desktop tests, mobile was **Not tested** and the required
reviewer-accessible video walkthrough was **Not ready**.

The three 1174 by 470 PNGs in
[Claude listing assets](https://github.com/meech-ward/elaborat.ing/releases/tag/claude-listing-assets-2026-11-03)
show synthetic note, drawing and diagram cards captured in Inspector. The
video walkthrough is a separate review requirement.
