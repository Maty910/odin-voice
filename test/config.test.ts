import { describe, expect, it, vi } from "vitest"
import { DEFAULTS, parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  it("B1: sin archivo -> defaults completos (R3)", () => {
    const log = vi.fn()
    const cfg = parseConfig(null, log)
    expect(cfg.volume).toBe(80)
    expect(Object.keys(cfg.categories).sort()).toEqual(["error", "finished", "permission", "question"])
    for (const cat of Object.values(cfg.categories)) {
      expect(cat.enabled).toBe(true)
      expect(cat.cooldownMs).toBe(8000)
      expect(cat.clip).toMatch(/\.mp3$/)
    }
    expect(cfg.categories.finished.clip).toBe("finished.mp3")
    expect(cfg.categories.error.clip).toBe("error.mp3")
    expect(cfg.categories.question.clip).toBe("question.mp3")
    expect(cfg.categories.permission.clip).toBe("permission.mp3")
  })

  it("B2: override parcial -> merge profundo por categoria (R4)", () => {
    const log = vi.fn()
    const raw = JSON.stringify({
      volume: 50,
      categories: {
        error: { enabled: false, cooldownMs: 1000, phrase: "Fallo." },
      },
    })
    const cfg = parseConfig(raw, log)
    expect(cfg.volume).toBe(50)
    expect(cfg.categories.error.enabled).toBe(false)
    expect(cfg.categories.error.cooldownMs).toBe(1000)
    expect(cfg.categories.error.phrase).toBe("Fallo.")
    expect(cfg.categories.error.clip).toBe("error.mp3")
    expect(cfg.categories.finished.enabled).toBe(true)
    expect(cfg.categories.finished.cooldownMs).toBe(8000)
  })

  it("B3: JSON malformado -> defaults, no lanza, log llamado (R5)", () => {
    const log = vi.fn()
    let cfg: ReturnType<typeof parseConfig> | undefined
    expect(() => {
      cfg = parseConfig("{ esto no es json valido", log)
    }).not.toThrow()
    expect(cfg).toEqual(DEFAULTS)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("B4: claves desconocidas a nivel raiz y por categoria se ignoran (R6)", () => {
    const log = vi.fn()
    const raw = JSON.stringify({
      volume: 90,
      mystery_key: "spam",
      categories: {
        finished: {
          enabled: true,
          phrase: "Listo.",
          clip: "finished.mp3",
          cooldownMs: 8000,
          extra_unknown: 123,
          debug: "trace",
        },
        error: { enabled: true, phrase: "Hubo un error.", clip: "error.mp3", cooldownMs: 8000 },
        not_a_real_category: { enabled: false, phrase: "basura" },
      },
    })
    const cfg = parseConfig(raw, log)
    // Solo 4 categorías canónicas, ninguna extraña
    expect(Object.keys(cfg.categories).sort()).toEqual(["error", "finished", "permission", "question"])
    // volume aplicado
    expect(cfg.volume).toBe(90)
    // finished toma campos conocidos; unknown extra no contamina el output
    expect(cfg.categories.finished.phrase).toBe("Listo.")
    expect(cfg.categories.finished.cooldownMs).toBe(8000)
    // permission/question quedan en defaults (no tienen override)
    expect(cfg.categories.permission.enabled).toBe(true)
    expect(cfg.categories.question.cooldownMs).toBe(8000)
    // log no fue llamado (no fue error)
    expect(log).toHaveBeenCalledTimes(0)
  })

  it("A3: normaliza el shape singular a un pool de una entrada", () => {
    const cfg = parseConfig(JSON.stringify({
      categories: {
        finished: { clip: "finished-legacy.mp3", phrase: "[pause] Legacy." },
      },
    }), vi.fn())

    expect(cfg.categories.finished.clips).toEqual([
      { clip: "finished-legacy.mp3", phrase: "[pause] Legacy." },
    ])
  })

  it("A3: conserva pool con tags y frases exactas, ignorando campos extra", () => {
    const cfg = parseConfig(JSON.stringify({
      categories: {
        finished: {
          clips: [
            { clip: "finished-1.mp3", phrase: "[pause] It is done.", ignored: true },
            { clip: "finished-themis-1.mp3", phrase: "[exhales] Themis.", agent: "themis", scope: "ignored" },
          ],
        },
      },
    }), vi.fn())

    expect(cfg.categories.finished.clips).toEqual([
      { clip: "finished-1.mp3", phrase: "[pause] It is done." },
      { clip: "finished-themis-1.mp3", phrase: "[exhales] Themis.", agent: "themis", scope: "ignored" },
    ])
  })
})
