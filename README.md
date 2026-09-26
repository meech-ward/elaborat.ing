# elaborat.ing

Documents and diagrams for people who like Markdown, and the AI agents they
work with.

- Write notes in Markdown and MDX, with a code editor and an editable rendered view.
- Draw on native Excalidraw canvases, and write diagrams as D2 code.
- Connect Claude, ChatGPT or any MCP client to your account, and work on the
  same documents together.
- Run your own copy on a free Supabase project, or use the hosted one at
  https://elaborat.ing, once it launches.

**Status:** early and being built in public. Nothing here is ready to use yet.
The [roadmap](docs/roadmap.md) shows what is being built and in what order.

## Docs

- [Product](docs/product.md): what it does and who it is for
- [Architecture](docs/architecture.md): how it fits together, and the decisions behind it
- [Roadmap](docs/roadmap.md)
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
