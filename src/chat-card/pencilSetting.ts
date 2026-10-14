/**
 * Whether this viewer wants the pencil sound a live drawing makes
 * (live/pencil.ts): on unless they muted it in the card, which the card
 * remembers in its storage where the host allows that, and otherwise for as
 * long as the card is open.
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
    // Not kept: the host gives the card no storage.
  }
}
