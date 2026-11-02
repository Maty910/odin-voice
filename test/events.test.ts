import { describe, expect, it } from "vitest"
import { mapEventToCategory } from "../src/events.ts"

describe("mapEventToCategory", () => {
  it("A1: session.idle -> finished", () => {
    expect(mapEventToCategory("session.idle")).toBe("finished")
  })

  it("A2: session.error / permission.asked / question.asked -> error / permission / question", () => {
    expect(mapEventToCategory("session.error")).toBe("error")
    expect(mapEventToCategory("permission.asked")).toBe("permission")
    expect(mapEventToCategory("question.asked")).toBe("question")
  })

  it("A3: evento desconocido / vacio / prefijo parcial -> null", () => {
    expect(mapEventToCategory("session.created")).toBe(null)
    expect(mapEventToCategory("")).toBe(null)
    expect(mapEventToCategory("session")).toBe(null)
  })
})
