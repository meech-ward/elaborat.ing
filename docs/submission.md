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
| Reviewer sign-in and the video link | The portal's Review details form, never the ZIP |

The test cases are the prompts marked **Submit** in
[golden prompts](golden-prompts.md); change both together. There is one
screenshot per starter prompt (`assets/screenshots/`, exactly 706 px wide and
400 to 860 px tall) of the chat card answering it. If you change a starter
prompt, replace its screenshot, or remove `screenshots`, which are optional.

**Self-hosting?** Point `mcp.json` at your own `<site>/mcp`, and the four
links in `plugin.json` (`websiteURL`, `supportURL`, `privacyPolicyURL`,
`termsOfServiceURL`) at your own pages. The links must be HTTPS and must
identify the same publisher as the submission.

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
account, and record the five positive and three negative test cases, on the
web and on a phone. Upload it where a reviewer can open it without signing
in (an unlisted video works), and keep the link for step 6.

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
4. Domain verification: the portal shows a token. Put it in
   `wrangler.jsonc`:

   ```jsonc
   "vars": { "OPENAI_APPS_CHALLENGE": "<the token>" }
   ```

   and deploy. `<site>/.well-known/openai-apps-challenge` then answers with
   the token as plain text. Press verify.
5. Complete the sign-in as the reviewer account, and wait for the tool scan.
   Fix anything under **Issues**. If the portal asks why a tool has its
   hints, the reasons are in [architecture](architecture.md) (every tool
   states its three hints). The card loads its editor, component previews and
   fonts from your site, which is the only other origin it uses.

## 6. Review details and submit

1. In **Metadata & Skills**, open **Review information**, then **Review
   details**. Check the imported test cases and release notes.
2. Enter the reviewer account: the sign-in URL (`<site>/sign-in`), its email
   and password, and short instructions: "Sign in with the email and
   password. The Welcome project has the sample note welcome.mdx, with a
   drawing, a diagram and one open comment."
3. Enter the video link, and save the details.
4. **Submit for review** and complete the attestations. The decision comes by
   email; after approval you choose when to publish.

Changes to the MCP server's tools are picked up by a daily scan (or
**Rescan**) without a new ZIP. Changes to the listing, the skills or
`mcp.json` need a new version and a new ZIP.
