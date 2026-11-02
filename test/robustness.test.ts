import { describe, expect, it, vi } from "vitest"
import { createOdinVoice, safeOnEvent } from "../src/core.ts"
import type { VoiceConfig } from "../src/config.ts"
import type { OdinVoice } from "../src/core.ts"

const baseConfig: VoiceConfig = {
  volume: 80,
  categories: {
    finished: { enabled: true, phrase: "Listo.", clip: "finished.mp3", cooldownMs: 8000 },
    error: { enabled: true, phrase: "Hubo un error.", clip: "error.mp3", cooldownMs: 8000 },
    question: { enabled: true, phrase: "Tengo una pregunta.", clip: "question.mp3", cooldownMs: 8000 },
    permission: { enabled: true, phrase: "Necesito tu permiso.", clip: "permission.mp3", cooldownMs: 8000 },
  },
}

function makeCore(overrides: Partial<{
  config: VoiceConfig
  available: string[] | (() => string[])
  env: Record<string, string>
  log: (msg: string) => void
}> = {}) {
  const config = overrides.config ?? baseConfig
  const available = overrides.available ?? ["paplay"]
  const env = overrides.env ?? {}
  const log = overrides.log ?? vi.fn()

  const core = createOdinVoice({
    config,
    env,
    now: () => 1_000_000,
    detectPlayers: typeof available === "function" ? available : () => available,
    log,
  })

  return { core, log }
}

describe("robustness — safeOnEvent (R19/R20/R22)", () => {
  it("F1: detectPlayers que lanza -> tratado como sin players, no propaga (R19)", () => {
    const log = vi.fn()
    const { core } = makeCore({
      available: () => {
        throw new Error("detect boom")
      },
      log,
    })
    let ret: ReturnType<typeof safeOnEvent> | undefined
    expect(() => {
      ret = safeOnEvent(core, "session.idle", log)
    }).not.toThrow()
    expect(ret).toBeDefined()
    expect(ret!.kind).toBe("silence")
    expect(ret!.kind === "silence" && ret!.reason).toBe("no-player")
    expect(log).toHaveBeenCalled()
  })

  it("F3: detector que retorna lista vacia -> silence/no-player, no propaga", () => {
    const log = vi.fn()
    const { core } = makeCore({ available: [], log })
    let ret: ReturnType<typeof safeOnEvent> | undefined
    expect(() => {
      ret = safeOnEvent(core, "session.idle", log)
    }).not.toThrow()
    expect(ret).toBeDefined()
    expect(ret!.kind).toBe("silence")
    expect(ret!.kind === "silence" && ret!.reason).toBe("no-player")
  })

  it("F4: handler retorna sincrónicamente (R20: no espera al hijo)", () => {
    const { core } = makeCore()
    const ret = core.onEvent("session.idle")
    // R20 se cubre por retorno sincrónico, no por medición temporal (R14).
    // Si el handler fuese async, ret sería una Promise; verificamos que no lo es.
    expect(ret).not.toBeInstanceOf(Promise)
    expect(ret.kind).toBe("play")
  })

  it("F5: handler con TODO roto -> no propaga, jamás rechaza (R22)", () => {
    const log = vi.fn()
    const core: OdinVoice = createOdinVoice({
      config: baseConfig,
      env: {},
      now: () => {
        throw new Error("clock boom")
      },
      detectPlayers: () => {
        throw new Error("detect boom")
      },
      log,
    })
    let threw = false
    let ret: ReturnType<typeof safeOnEvent> | undefined
    try {
      ret = safeOnEvent(core, "session.idle", log)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(ret).toBeDefined()
    expect(ret!.kind).toBe("silence")
    expect(log).toHaveBeenCalled()
  })
})
