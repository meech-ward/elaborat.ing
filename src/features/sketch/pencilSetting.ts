/**
 * Whether this viewer wants the pencil sound a drawing makes as it is
 * sketched in (pencil.ts): on unless they muted it, in the chat card or on
 * the app's canvas, which remember it in their storage where the host allows
 * that, and otherwise for as long as the page is open.
 */
const KEY = "elaborat.ing:pencil-sound"

let muted: boolean | null = null

export function pencilSoundOn(): boolean {
  if (muted === null) {
    try {
      muted = window.localStorage.getItem(KEY) === "off"
    } catch {
      muted = false
    }
  }
  return !muted
}

export function setPencilSound(on: boolean) {
  muted = !on
  try {
    if (on) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, "off")
  } catch {
    // Not kept: the host gives the page no storage.
  }
}
