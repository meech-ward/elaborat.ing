/** The embed's own chunk: its chrome, sign-in and messages. main.tsx starts loading it with the first route. */
export const loadEmbedRoot = () => import("./EmbedRoot")
