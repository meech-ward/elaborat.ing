import { afterAll, expect, test } from "bun:test";
import { compile } from "@mdx-js/mdx";
import { COMPONENT_CATALOG } from "../document/componentCatalog";
import { createD2CompilePort, disposeSharedD2 } from "../structured/compiler";
import { D2_TEMPLATES } from "./d2Completions";

// Resolve only the default/choice/tabstop forms our starter snippets use.
// Monaco placeholder navigation itself still needs a browser test.
const defaults = (snippet: string) =>
  snippet
    .replace(
      /\$\{\d+\|([^}]+)\|\}/g,
      (_match, values: string) => values.split(",")[0],
    )
    .replace(/\$\{\d+:([^}]+)\}/g, "$1")
    .replace(/\$\d+/g, "");

test("every catalog starter and concrete template compiles as MDX", async () => {
  for (const component of COMPONENT_CATALOG) {
    for (const source of [defaults(component.snippet), component.template]) {
      const result = await compile(source);
      expect(String(result)).toContain("function");
    }
  }
});

test.if(process.env.SOURCE_D2_LIVE === "1")(
  "all three D2 starters compile with the real pinned compiler",
  async () => {
    for (const template of D2_TEMPLATES) {
      const diagram = await createD2CompilePort()({
        source: defaults(template.snippet),
      });
      expect(diagram.shapes?.length, template.label).toBeGreaterThanOrEqual(2);
      expect(
        diagram.connections?.length,
        template.label,
      ).toBeGreaterThanOrEqual(1);
    }
  },
  60000,
);

afterAll(disposeSharedD2);
