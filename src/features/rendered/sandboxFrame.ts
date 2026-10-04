/**
 * The note frame's page on a sandbox domain (docs/architecture.md, Component
 * isolation): the build's VITE_SANDBOX_ORIGIN and the folder of this build's
 * frame files (vite-plugins/preview-frame.ts).
 */
import { embedded } from "@/features/embed/mode";

/**
 * The sandbox domain a note frame loads its page from, or null for the
 * `srcdoc` frame. In a chat's panel (/embed) notes start in the `srcdoc`
 * frame, as the chat card's do: the sandbox domain lets only the app's own
 * site frame its page, so there it would only fail after a wait.
 */
export const SANDBOX_ORIGIN: string | null = embedded ? null : (import.meta.env.VITE_SANDBOX_ORIGIN ?? null);

/** The page's address, or null when `origin` is not an http(s) origin (scheme, host and port only). */
export function sandboxFrameUrl(origin: string | null | undefined, folder: string): string | null {
  if (!origin) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin.replace(/\/$/, "")) return null;
  return new URL(folder, `${url.origin}/`).href;
}
