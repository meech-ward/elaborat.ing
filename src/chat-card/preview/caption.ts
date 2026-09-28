/** The longest caption a component preview shows; longer props are cut. */
export const MAX_CAPTION = 160

/**
 * A component as a note would write it, with the props it was drawn with:
 * `<Metric label="Agents" value={128} />`. Props that JSON cannot write
 * (functions, undefined) are left out, and a long caption is cut short.
 */
export function componentCaption(name: string, props: Record<string, unknown>): string {
  const parts = Object.entries(props).flatMap(([key, value]) => {
    if (typeof value === "string") return [`${key}=${JSON.stringify(value)}`]
    if (value === true) return [key]
    const json = value === undefined || typeof value === "function" ? undefined : JSON.stringify(value)
    return json === undefined ? [] : [`${key}={${json}}`]
  })
  const text = `<${[name, ...parts].join(" ")} />`
  return text.length > MAX_CAPTION ? `${text.slice(0, MAX_CAPTION - 6)}... />` : text
}
