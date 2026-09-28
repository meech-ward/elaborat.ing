/**
 * The Format action: Prettier's Markdown formatting. Prettier loads the
 * first time a note is formatted, not with the editor.
 */
export async function formatMarkdown(text: string): Promise<string> {
  const [{ format }, markdown] = await Promise.all([import("prettier/standalone"), import("prettier/plugins/markdown")])
  try {
    return await format(text, { parser: "markdown", plugins: [markdown], proseWrap: "preserve" })
  } catch (error) {
    throw new Error(`Format failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
