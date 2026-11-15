/*
 * Bounded adaptation of lz-string 1.5.0's base64 decompressor.
 * Source: https://github.com/pieroxy/lz-string/blob/1.5.0/libs/lz-string.js
 * Copyright (c) 2013 Pieroxy. MIT License.
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

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='

export class DrawingDecompressionLimitError extends Error {}

/** Caps are checked before concatenating dictionary entries or output strings. */
export function decompressDrawingBase64(input: string, maxCharacters: number): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new Error('Invalid decompression limit.')
  const compact = input.replace(/\s+/g, '')
  if (compact.length > maxCharacters) throw new DrawingDecompressionLimitError('The compressed drawing exceeds the limit.')
  if (!compact || !/^[A-Za-z0-9+/]+={0,3}$/.test(compact)) throw new Error('The compressed drawing is invalid.')
  let index = 1, position = 32, value = alphabet.indexOf(compact[0])
  const bits = (count: number): number => {
    let result = 0
    for (let power = 1, bit = 0; bit < count; bit++, power *= 2) {
      if (index > compact.length) throw new Error('The compressed drawing is incomplete.')
      if (value & position) result += power
      position >>= 1
      if (position === 0) {
        position = 32
        value = index < compact.length ? alphabet.indexOf(compact[index]) : 0
        index++
      }
    }
    return result
  }
  const first = bits(2)
  if (first === 2) return ''
  if (first !== 0 && first !== 1) throw new Error('The compressed drawing is invalid.')
  let previous = String.fromCharCode(bits(first === 0 ? 8 : 16))
  const dictionary: Array<string | undefined> = [undefined, undefined, undefined, previous]
  const output = [previous]
  let outputCharacters = 1, dictionaryCharacters = 1, dictionarySize = 4, enlargeIn = 4, codeBits = 3
  const addDictionary = (prefix: string, suffix: string) => {
    const length = prefix.length + suffix.length
    // A second budget includes strings retained by the dictionary, not only
    // the final decompressed document. No large concatenation precedes it.
    if (length > maxCharacters || dictionaryCharacters + length > maxCharacters * 2 + 16) throw new DrawingDecompressionLimitError('The decompressed drawing exceeds the limit.')
    dictionaryCharacters += length
    dictionary[dictionarySize++] = prefix + suffix
  }
  while (outputCharacters <= maxCharacters) {
    let code = bits(codeBits)
    if (code === 2) return output.join('')
    if (code === 0 || code === 1) {
      addDictionary('', String.fromCharCode(bits(code === 0 ? 8 : 16)))
      code = dictionarySize - 1
      enlargeIn--
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** codeBits; codeBits++ }
    let entry = dictionary[code]
    if (entry === undefined) {
      if (code !== dictionarySize) throw new Error('The compressed drawing is invalid.')
      if (previous.length + 1 > maxCharacters - outputCharacters) throw new DrawingDecompressionLimitError('The decompressed drawing exceeds the limit.')
      entry = previous + previous.charAt(0)
    }
    if (entry.length > maxCharacters - outputCharacters) throw new DrawingDecompressionLimitError('The decompressed drawing exceeds the limit.')
    outputCharacters += entry.length
    output.push(entry)
    addDictionary(previous, entry.charAt(0))
    enlargeIn--
    previous = entry
    if (enlargeIn === 0) { enlargeIn = 2 ** codeBits; codeBits++ }
    // The input and output caps make this unreachable for valid documents.
    if (codeBits > 24) throw new DrawingDecompressionLimitError('The compressed drawing exceeds the code budget.')
  }
  throw new DrawingDecompressionLimitError('The decompressed drawing exceeds the limit.')
}
