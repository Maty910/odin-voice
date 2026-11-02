import { describe, expect, it } from "vitest"
import { createCooldown } from "../src/cooldown.ts"
import type { Category } from "../src/events.ts"

class FakeClock {
  public t: number
  constructor(initial: number = 1_000_000) {
    this.t = initial
  }
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

function makeCooldown(initial: number = 1_000_000) {
  const clock = new FakeClock(initial)
  return {
    clock,
    cooldown: createCooldown({
      now: () => clock.now(),
      cooldowns: {
        finished: 8000,
        error: 8000,
        question: 8000,
        permission: 8000,
      },
    }),
  }
}

describe("createCooldown", () => {
  it("C1: primera vez, allow para todas las categorias", () => {
    const { cooldown } = makeCooldown()
    const cats: Category[] = ["finished", "error", "question", "permission"]
    for (const cat of cats) {
      expect(cooldown.check(cat)).toBe("allow")
    }
  })

  it("C2: misma categoria dentro de ventana -> deny (R10)", () => {
    const { clock, cooldown } = makeCooldown()
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(1000) // dentro de 8000ms
    expect(cooldown.check("finished")).toBe("deny")
    clock.advance(6000) // total 7000ms, sigue dentro
    expect(cooldown.check("finished")).toBe("deny")
  })

  it("C3: otra categoria dentro de ventana -> allow (R12)", () => {
    const { clock, cooldown } = makeCooldown()
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(1000)
    expect(cooldown.check("error")).toBe("allow")
    expect(cooldown.check("question")).toBe("allow")
    expect(cooldown.check("permission")).toBe("allow")
  })

  it("C4: ventana expirada -> allow (R11)", () => {
    const { clock, cooldown } = makeCooldown()
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(7999)
    expect(cooldown.check("finished")).toBe("deny")
    clock.advance(1)
    expect(cooldown.check("finished")).toBe("allow")
  })

  it("C5: borde exacto t-t0 == cooldown -> allow (R11)", () => {
    const { clock, cooldown } = makeCooldown()
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(8000)
    expect(cooldown.check("finished")).toBe("allow")
  })

  it("C6: cooldown 0 -> siempre allow (R13)", () => {
    const clock = new FakeClock(1_000_000)
    const cooldown = createCooldown({
      now: () => clock.now(),
      cooldowns: {
        finished: 0,
        error: 8000,
        question: 8000,
        permission: 8000,
      },
    })
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(1)
    expect(cooldown.check("finished")).toBe("allow")
    clock.advance(1)
    expect(cooldown.check("finished")).toBe("allow")
  })

  it("C7: cooldowns distintos por categoria -> independencia real", () => {
    const clock = new FakeClock(1_000_000)
    const cooldown = createCooldown({
      now: () => clock.now(),
      cooldowns: {
        finished: 5000,
        error: 12000,
        question: 3000,
        permission: 8000,
      },
    })
    expect(cooldown.check("finished")).toBe("allow")
    expect(cooldown.check("error")).toBe("allow")
    expect(cooldown.check("question")).toBe("allow")
    expect(cooldown.check("permission")).toBe("allow")

    // A los 4000ms: finished (5000) y question (3000) ya pasaron; error (12000) y permission (8000) no
    clock.advance(4000)
    expect(cooldown.check("finished")).toBe("deny") // elapsed 4000 < 5000
    expect(cooldown.check("error")).toBe("deny") // elapsed 4000 < 12000
    expect(cooldown.check("question")).toBe("allow") // elapsed 4000 >= 3000
    expect(cooldown.check("permission")).toBe("deny") // elapsed 4000 < 8000

    // A los 9000ms total: finished (5000) y permission (8000) ya pasaron; error (12000) no; question (3000) no
    clock.advance(5000)
    expect(cooldown.check("finished")).toBe("allow") // elapsed 9000 >= 5000
    expect(cooldown.check("error")).toBe("deny") // elapsed 9000 < 12000
    expect(cooldown.check("question")).toBe("allow") // elapsed 9000 >= 3000
    expect(cooldown.check("permission")).toBe("allow") // elapsed 9000 >= 8000
  })
})
