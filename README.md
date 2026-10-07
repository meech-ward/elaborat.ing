# elaborat.ing

Documents and diagrams for people who like Markdown, and the AI agents they
work with.

- Write notes in MDX (Markdown plus components), with a code editor, an
  editable rendered view, or both side by side.
- Draw on native Excalidraw canvases, and write diagrams as D2 code.
- Connect Claude, ChatGPT or any MCP client to your account, and work on the
  same documents together.
- Run your own copy on a free Supabase project ([self-host guide](docs/self-host.md)),
  or use the hosted one at https://elaborat.ing.

**Status:** early and being built in public. You can try it at
https://elaborat.ing, without an account (your work stays in that browser) or
with one. Expect rough edges. The [roadmap](docs/roadmap.md) shows what is
being built and in what order.

## Connect an agent

Add elaborat.ing as a custom connector (MCP server) in Claude, ChatGPT or any
MCP client:

```
https://elaborat.ing/mcp
```

Sign in when asked and allow access. The agent can then list, read, write and
organize your projects' files, search them, and show a file in the chat.

## Install as a plugin

The [plugin](plugins/elaborating/) adds the same server, plus short skills for
writing MDX notes, D2 diagrams and drawings, and for working through the
comments people leave on your files.

In Codex:

```
codex plugin marketplace add meech-ward/elaborat.ing
codex plugin add elaborating@elaborating
```

In Claude Code:

```
/plugin marketplace add meech-ward/elaborat.ing
/plugin install elaborating@elaborating
```

## Docs

- [Product](docs/product.md): what it does and who it is for
- [Architecture](docs/architecture.md): how it fits together, and the decisions behind it
- [Roadmap](docs/roadmap.md)
- [Self-host guide](docs/self-host.md): from a new free Supabase project to a running copy
- [Platform notes](docs/platform-notes.md): Supabase and Cloudflare details we rely on
- [Golden prompts](docs/golden-prompts.md): prompts for checking that agents use the tools when they should
- [Submitting the plugin](docs/submission.md): listing it in the plugin directory ChatGPT and Codex share

## Develop

Requires [Bun](https://bun.sh) 1.4.

```bash
bun install --frozen-lockfile
cp .env.example .env.local   # then fill in your Supabase project's public values
bun run dev
```

Contributors and coding agents: start with [AGENTS.md](AGENTS.md).

### The assistant on your ChatGPT plan

A local run can have an assistant that writes notes, drawings and diagrams in
the open project on your own ChatGPT plan (Plus or Pro). The dev server keeps
your ChatGPT tokens in `~/.config/elaborating/chatgpt.json` (or under
`$XDG_CONFIG_HOME`), never in the browser.

```bash
VITE_CHATGPT_PLAN=1 bun run dev
```

Open http://127.0.0.1:5173 (not localhost: ChatGPT sends you back to
127.0.0.1), open a project, choose the assistant button beside the comments,
and Continue with ChatGPT. Its changes show in the file as unsaved edits for
you to save or discard.

From a fresh clone, `bun run try:chatgpt` does all of that in one step: it
installs, writes `.env.local` with the hosted project's public values if you
have none, starts the dev server and opens it in your browser.

## License

[MIT](LICENSE)

Every build lists the licenses of the third-party code it ships in
`third-party-notices.txt`, which the app serves at `/third-party-notices.txt`.
That covers the npm packages in the bundle and code adapted from other
projects, whose license stays in a `/*! ... */` comment in the adapted file.
Font licenses are served at `/font-licenses/`, indexed in
[NATIVE-FONTS.md](public/font-licenses/NATIVE-FONTS.md).
