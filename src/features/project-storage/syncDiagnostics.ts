/** Only user-facing validation explanations belong in durable sync state. */
export const MAX_SYNC_ERROR_DETAIL = 500

export type SyncStopReason = "access-lost" | "deleted" | "archived" | "limit" | "invalid"

// PostgREST, Storage and the image function can also return internal exception
// messages. Keep these bounded, whole-message patterns deliberately narrow:
// arbitrary suffixes, URLs, credentials and traces never become browser data.
// Related variants share a pattern so new validator wording fails closed.
const actionableDetails = [
  /^Choose (?:a PNG, JPEG, WebP, GIF or SVG image|a valid SVG image|an image (?:no larger than 5 MiB|with at most 8 million pixels)|an SVG with at most 8 million pixels)\.$/,
  /^Choose an image(?: up to 5 MiB)?$/,
  /^This image could not be (?:decoded|read)(?:\. Choose another file\.)?$/,
  /^A preview could not be made for this (?:SVG|image)\.$/,
  /^The image (?:dimensions are inconsistent|preview exceeds its size limit)\.?$/,
  /^The file(?:'s)? contents do not match its image type\.$/,
  /^The (?:PNG|JPEG|WebP|GIF) image is (?:incomplete|invalid)\.$/,
  /^The WebP padding is invalid\.$/,
  /^The animation (?:is invalid|frame (?:is too large|count is invalid))\.$/,
  /^An animation frame extends beyond the image canvas\.$/,
  /^Animation exceeds (?:120 frames or (?:24 million decoded frame pixels|is invalid)|24 million decoded frame pixels)\.$/,
  /^SVG (?:must use UTF-8|needs positive dimensions or a viewBox|IDs must be unique|(?:document types and external resources|scripts and external resources) are not supported|links must point inside the image|resources must stay inside the image|reference chains are too long|references cannot form a cycle|geometry is too large or complex)\.$/,
  /^The SVG (?:is not valid XML|filter(?: region)? is invalid|filter (?:region|resolution) is too large|has an invalid resource reference|contains unsupported content)\.$/,
  /^This SVG (?:is too complex|filter is too complex|filter (?:kernel|resolution) is too large|has too many (?:filter effects|repeated shapes)|contains too much text|repeats too (?:much (?:text|geometry)|many filter effects))\.$/,
  /^Unsupported SVG namespace\.$/,
  /^SVG (?:text is limited to 4,000 characters per text node and 8,000 in total|repeated text is limited to 8,000 characters)\.$/,
  /^This SVG contains an unsupported element\. Use vector shapes without scripts or embedded content\.$/,
  /^The image (?:bytes are missing from this device\. Your note has not been saved to the server|object does not belong to this project)\.$/,
  /^The uploaded image does not match the local image\.$/,
  /^A downloaded image (?:does not match its saved digest|preview does not match its saved size or type)\.$/,
  /^The image (?:could not be saved|upload did not finish)\. Your draft is still on this device\. Try again\.$/,
  /^The image thumbnail service is temporarily unavailable\.$/,
  /^(?:A project can hold at most (?:4096 files and 4096 folders|64 MiB of files)|The project owner has reached the 256 MiB image limit, including image history and pending uploads)$/,
  /^(?:Invalid image metadata|This image id was already used for another upload|The project service refused the request|The server returned an unrecognized save conflict)\.?$/,
  /^(?:Project id and mutation id are required|Changes must be a list of 1 to 4096 items|Each change must be an object|base_version must be a positive whole number|A move can carry text or an image reference, not both|asset needs an image id|This mutation id was already used for a different save)$/,
  /^(?:A file path is invalid|A save can change each path only once|A file change needs a base version|A file change needs text content|Image files need an explicit image operation|The save contains an unknown operation)\.$/,
]

/** Return only a known explanation, never arbitrary remote output or user data. */
export function safeSyncErrorDetail(detail: string | null | undefined): string | null {
  if (!detail || detail.length > MAX_SYNC_ERROR_DETAIL || /[\u0000-\u001f\u007f-\u009f]/.test(detail)) return null
  if (actionableDetails.some(pattern => pattern.test(detail))) return detail
  // These database errors echo a path or operation supplied by the caller.
  // Preserve the explanation while dropping that untrusted value entirely.
  if (detail.startsWith("Invalid path: ")) return "A file path is invalid."
  if (detail.startsWith("A save can change each path only once: ")) return "A save can change each path only once."
  if (/^(?:delete|move) needs base_version: /.test(detail)) return "A file change needs a base version."
  if (/^(?:put needs string content|move content must be a string): /.test(detail)) return "A file change needs text content."
  if (detail.startsWith("Image files need an explicit image operation: ")) return "Image files need an explicit image operation."
  if (detail.startsWith("Unknown change op: ")) return "The save contains an unknown operation."
  if (/^SVG element .+ is not supported\. Use vector shapes without scripts or embedded content\.$/.test(detail))
    return "This SVG contains an unsupported element. Use vector shapes without scripts or embedded content."
  return null
}

/** The same stopped-sync wording on the first failure and after a reload. */
export function stoppedSyncMessage(reason: SyncStopReason, detail?: string | null): string {
  switch (reason) {
    case "access-lost":
      return "You can no longer change this project. Your work stays on this device."
    case "deleted":
      return "This project was deleted by its owner."
    case "archived":
      return "This project is archived. Unarchive it to sync your changes."
    case "limit":
      return safeSyncErrorDetail(detail) ?? "This project is over its limits."
    case "invalid": {
      const safe = safeSyncErrorDetail(detail)
      return `The server refused these changes${safe ? `: ${safe}` : "."}`
    }
  }
}
