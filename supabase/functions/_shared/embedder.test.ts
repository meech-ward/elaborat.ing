import { expect } from "jsr:@std/expect@1.0.17"
import { describe, it as test } from "jsr:@std/testing@1.0.16/bdd"
import { lazyEmbedder, type ModelSession } from "./embedder.ts"

/** Sessions whose runs answer in turn: a vector, or an error to throw. */
function sessions(...answers: (number[] | Error)[]) {
  const made: ModelSession[] = []
  const create = (): ModelSession => {
    const session: ModelSession = {
      run: () => {
        const answer = answers.shift()
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
      },
    }
    made.push(session)
    return session
  }
  return { made, create }
}

describe("lazyEmbedder", () => {
  test("makes no session until the first call, then keeps it", async () => {
    const { made, create } = sessions([1, 0], [0, 1])
    const embed = lazyEmbedder(create)
    expect(made.length).toBe(0)
    expect(await embed("first")).toEqual([1, 0])
    expect(await embed("second")).toEqual([0, 1])
    expect(made.length).toBe(1)
  })

  test("a failed load reaches the caller, and the next call loads the model again", async () => {
    const { made, create } = sessions(new Error("Failed to load model because protobuf parsing failed."), [1, 0])
    const embed = lazyEmbedder(create)
    await expect(embed("first")).rejects.toThrow("protobuf parsing failed")
    expect(await embed("second")).toEqual([1, 0])
    expect(made.length).toBe(2)
  })
})
