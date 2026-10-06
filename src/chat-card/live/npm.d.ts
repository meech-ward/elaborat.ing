// The live view draws with the MCP server's own renderers
// (supabase/functions/mcp-server/tools), which import their packages as
// Deno does, by `npm:<package>@<version>`. scripts/build-chat-card.ts
// resolves each to the app's own copy, and stops when package.json pins
// another version; these give TypeScript the same answer.
declare module "npm:roughjs@4.6.6" {
  export { default } from "roughjs"
}
declare module "npm:roughjs@4.6.6/bin/generator.js" {
  export * from "roughjs/bin/generator.js"
}
declare module "npm:lz-string@1.5.0" {
  export { default } from "lz-string"
}
declare module "npm:unified@11.0.5" {
  export * from "unified"
}
declare module "npm:remark-parse@11.0.0" {
  export { default } from "remark-parse"
}
declare module "npm:remark-frontmatter@5.0.0" {
  export { default } from "remark-frontmatter"
}
declare module "npm:remark-gfm@4.0.1" {
  export { default } from "remark-gfm"
}
declare module "npm:remark-rehype@11.1.2" {
  export { default } from "remark-rehype"
}
declare module "npm:rehype-sanitize@6.0.0" {
  export * from "rehype-sanitize"
  export { default } from "rehype-sanitize"
}
declare module "npm:rehype-stringify@10.0.1" {
  export { default } from "rehype-stringify"
}
