/**
 * The rendered view sends a note's image pixels for the image keys its parser
 * reads, and keeps those keys by the projection's runtimeKey: typing prose
 * parses nothing (RenderedEditor, the images effect). That is right only if
 * an edit that keeps the runtimeKey keeps the keys. Every image syntax (an
 * image, an image reference and its definition, an HTML or JSX image, an
 * image in a heading, a list, a quote or a table) is an island or a block the
 * projection keeps aside, whose source the runtimeKey hashes. This checks it
 * edit by edit: one character typed or deleted at each place of each note.
 */
import { describe, expect, test } from "bun:test";
import { projectFluidSource } from "./fluidProjection";
import { parseImageReferences } from "../images/references";

const NOTES: Array<{ name: string; format: "md" | "mdx"; text: string }> = [
  {
    name: "images in prose, a heading, a quote, a list and a table",
    format: "md",
    text: "# Title ![h](h.png)\n\nBefore ![a](a.png) after, and a [link](k.png) [too] (z.png).\n\n> Quoted ![q](q.png) here.\n\n- item ![l](l.png)\n- two\n\n| a | b |\n| --- | --- |\n| ![t](t.png) | x |\n\nTail.\n",
  },
  {
    name: "an image alone, as a figure, and an image reference with its definition",
    format: "md",
    text: "Intro.\n\n![Figure](f.png)\n\nUse ![ref][r] here, and [a link][r] too.\n\n[r]: r.png\n\nTail.\n",
  },
  {
    name: "HTML images, and frontmatter",
    format: "md",
    text: "---\ntitle: Pictures\n---\n\nInline <img src=\"i.png\" alt=\"i\"> here.\n\n<img src=\"b.png\" alt=\"b\">\n\nTail.\n",
  },
  {
    name: "MDX: JSX images, an image in a component, an export and a comment",
    format: "mdx",
    text: "export const size = 2\n\nProse ![m](m.png) more.\n\n<img src=\"j.png\" alt=\"j\" />\n\n<Callout>In ![c](c.png) here.</Callout>\n\n{/* ![no](n.png) */}\n\nTail.\n",
  },
];

const keys = async (text: string, format: "md" | "mdx") =>
  [...new Set((await parseImageReferences(text, format, "notes/root.mdx")).map((reference) => reference.key))].sort();

describe("an edit that keeps a note's runtimeKey keeps its image keys", () => {
  for (const note of NOTES) {
    test(note.name, async () => {
      const base = await projectFluidSource(note.text, note.format);
      const baseKeys = await keys(note.text, note.format);
      expect(baseKeys.length).toBeGreaterThan(0);
      let kept = 0, changed = 0;
      for (let at = 0; at <= note.text.length; at++) {
        for (const edit of ["x", "!", "]", ")", "\n", ""]) {
          const text = edit === "" ? note.text.slice(0, at) + note.text.slice(at + 1) : note.text.slice(0, at) + edit + note.text.slice(at);
          if (text === note.text) continue;
          let runtimeKey: string;
          try {
            runtimeKey = (await projectFluidSource(text, note.format)).runtimeKey;
          } catch {
            continue;
          }
          if (runtimeKey !== base.runtimeKey) {
            changed++;
            continue;
          }
          kept++;
          expect({ text, keys: await keys(text, note.format) }).toEqual({ text, keys: baseKeys });
        }
      }
      // Both kinds of edit happened: prose edits, and edits to the images.
      expect(kept).toBeGreaterThan(50);
      expect(changed).toBeGreaterThan(10);
    }, 120_000);
  }
});
