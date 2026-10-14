/*!
 * The way each pencil stroke varies (a random pitch, louder for shapes than
 * for text and lines, a quick attack and a fade, a random start in the
 * sound) follows excalidraw-mcp's src/pencil-audio.ts
 * (https://github.com/excalidraw/excalidraw-mcp). The sound itself is made
 * here from noise; none of that project's audio is used.
 *
 * MIT License, as excalidraw-mcp's package.json declares (the repository
 * has no license file or copyright line).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * A quiet pencil-on-paper sound for each element as the live view draws it
 * in (mount.ts): noise with the paper's grain, through a band-pass filter,
 * shaped like a stroke. Web Audio only, made in the page: nothing is
 * fetched. Where the browser keeps audio held back (no click in the chat
 * yet, or the host does not let frames play sound), it stays silent.
 */

export type Pencil = {
  /** One stroke for an element of `type` that draws in over about `ms`. */
  stroke(type: string, ms: number): void
  /** On or off. Turned on from a click, it asks the browser to let audio play. */
  set(on: boolean): void
  close(): void
}

/**
 * The loudest a stroke gets: quiet, under whatever else is playing. The
 * filtered noise is about 30 dB under full scale at this gain, peaking near 16.
 */
const VOLUME = 0.2

type AudioContextClass = typeof AudioContext

/** Noise with the paper's grain: the lead catches now and then, so the scratch comes in little bursts. */
function paperNoise(context: AudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 1.5), context.sampleRate)
  const data = buffer.getChannelData(0)
  let grain = 1
  for (let at = 0; at < data.length; at++) {
    if (at % 96 === 0) grain = 0.3 + Math.random() * 0.7
    data[at] = (Math.random() * 2 - 1) * grain
  }
  return buffer
}

export function pencil(on: boolean): Pencil {
  let context: AudioContext | null = null
  let noise: AudioBuffer | null = null
  let failed = false

  /** The audio context, made the first time; null where there is none. */
  const audio = (): AudioContext | null => {
    if (context || failed) return context
    try {
      const Context = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext) as AudioContextClass | undefined
      if (!Context) throw new Error("no Web Audio")
      context = new Context()
      noise = paperNoise(context)
    } catch {
      failed = true
      context = null
    }
    return context
  }
  const wake = (running: AudioContext) => {
    if (running.state === "suspended") running.resume().catch(() => {})
  }

  // Made now, so it is running by the first stroke where the browser allows it.
  if (on) {
    const running = audio()
    if (running) wake(running)
  }

  return {
    stroke(type, ms) {
      if (!on) return
      const running = audio()
      if (!running || !noise) return
      // Held back: ask again, and stay silent until the browser lets it play.
      if (running.state !== "running") return wake(running)
      try {
        const now = running.currentTime
        const line = type === "arrow" || type === "line" || type === "freedraw"
        const length = Math.min(0.6, Math.max(0.15, ms / 1000)) * (0.85 + Math.random() * 0.3)
        const peak = VOLUME * (line ? 0.6 : type === "text" ? 0.75 : 1) * (0.8 + Math.random() * 0.4)
        const source = running.createBufferSource()
        source.buffer = noise
        source.playbackRate.value = 0.85 + Math.random() * 0.35
        const filter = running.createBiquadFilter()
        filter.type = "bandpass"
        filter.frequency.value = (line ? 3200 : 2600) + Math.random() * 1400
        filter.Q.value = 0.8 + Math.random() * 0.6
        const gain = running.createGain()
        gain.gain.setValueAtTime(0, now)
        gain.gain.linearRampToValueAtTime(peak, now + 0.03)
        gain.gain.setValueAtTime(peak, now + length * 0.6)
        gain.gain.linearRampToValueAtTime(0, now + length)
        source.connect(filter).connect(gain).connect(running.destination)
        // Enough of the noise for the stroke at the fastest rate, from anywhere in it.
        const take = (length + 0.05) * 1.25
        source.start(now, Math.random() * Math.max(0, noise.duration - take), take)
        source.onended = () => {
          source.disconnect()
          filter.disconnect()
          gain.disconnect()
        }
      } catch {
        // No sound this time.
      }
    },
    set(next) {
      on = next
      if (!on) return
      const running = audio()
      if (running) wake(running)
    },
    close() {
      context?.close().catch(() => {})
      context = null
      failed = true
    },
  }
}
