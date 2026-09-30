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

## Develop

Requires [Bun](https://bun.sh) 1.4.

```bash
bun install --frozen-lockfile
cp .env.example .env.local   # then fill in your Supabase project's public values
bun run dev
```

Contributors and coding agents: start with [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Every build lists the licenses of the third-party code it ships in
`third-party-notices.txt`, which the app serves at `/third-party-notices.txt`.
That covers the npm packages in the bundle and code adapted from other
projects, whose license stays in a `/*! ... */` comment in the adapted file.
Font licenses are served at `/font-licenses/`, indexed in
[NATIVE-FONTS.md](public/font-licenses/NATIVE-FONTS.md).
