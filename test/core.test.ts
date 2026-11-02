import { describe, expect, it, vi } from "vitest"
import { createOdinVoice } from "../src/core.ts"
import type { VoiceConfig } from "../src/config.ts"
import type { Category } from "../src/events.ts"

// === Fixtures =================================================================

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
  available: string[]
  env: Record<string, string>
  initialTime: number
}> = {}) {
  const config = overrides.config ?? baseConfig
  const available = overrides.available ?? ["paplay"]
  const env = overrides.env ?? {}
  const t = { v: overrides.initialTime ?? 1_000_000 }
  const logCalls: string[] = []
  const playersCalls: string[] = []

  const core = createOdinVoice({
    config,
    env,
    now: () => t.v,
    detectPlayers: () => {
      playersCalls.push(available.join(","))
      return available
    },
    log: (msg) => {
      logCalls.push(msg)
    },
  })

  return { core, logCalls, playersCalls, t, config, available, env }
}

function expectSilence(reason: string, ret: ReturnType<ReturnType<typeof createOdinVoice>["onEvent"]>) {
  expect(ret).toEqual({ kind: "silence", reason })
}

// === Tests ====================================================================

describe("createOdinVoice — decisión", () => {
  it("E1: camino feliz -> play con clip de la categoria y player seleccionado", () => {
    const { core } = makeCore({ available: ["paplay"] })
    const ret = core.onEvent("session.idle")
    expect(ret.kind).toBe("play")
    if (ret.kind === "play") {
      expect(ret.clip).toBe("finished.mp3")
      expect(ret.player).toBe("paplay")
      expect(ret.volume).toBe(80)
    }
  })

  it("E2: categoria disabled -> silence/disabled", () => {
    const config: VoiceConfig = {
      ...baseConfig,
      categories: {
        ...baseConfig.categories,
        finished: { ...baseConfig.categories.finished, enabled: false },
      },
    }
    const { core } = makeCore({ config })
    const ret = core.onEvent("session.idle")
    expectSilence("disabled", ret)
  })

  it("E3: cooldown activo -> silence/cooldown", () => {
    const { core, t } = makeCore()
    expect(core.onEvent("session.idle").kind).toBe("play")
    t.v += 1000 // dentro de cooldown 8000
    const ret = core.onEvent("session.idle")
    expectSilence("cooldown", ret)
  })

  it("E4: sin players -> silence/no-player sin error", () => {
    const { core } = makeCore({ available: [] })
    const ret = core.onEvent("session.idle")
    expectSilence("no-player", ret)
  })

  it("E5: ODIN_VOICE_MUTE=1 -> silence/muted", () => {
    const { core } = makeCore({ env: { ODIN_VOICE_MUTE: "1" } })
    const ret = core.onEvent("session.idle")
    expectSilence("muted", ret)
  })

  it("E6: evento desconocido -> silence/unknown-event", () => {
    const { core } = makeCore()
    const ret = core.onEvent("session.deleted")
    expectSilence("unknown-event", ret)
  })

  it("E7: play retorna decision con player y clip exactos", () => {
    const { core } = makeCore({ available: ["mpv"] })
    const ret = core.onEvent("session.error")
    expect(ret.kind).toBe("play")
    if (ret.kind === "play") {
      expect(ret.clip).toBe("error.mp3")
      expect(ret.player).toBe("mpv")
      expect(ret.volume).toBe(80)
    }
  })

  it("E-extra: 4 categorias mapeadas respectivamente", () => {
    const { core, t } = makeCore({ available: ["paplay"] })
    const events: Array<[string, Category, string]> = [
      ["session.idle", "finished", "finished.mp3"],
      ["session.error", "error", "error.mp3"],
      ["permission.asked", "permission", "permission.mp3"],
      ["question.asked", "question", "question.mp3"],
    ]
    for (const [ev, , expectedClip] of events) {
      t.v += 10000
      const ret = core.onEvent(ev)
      expect(ret.kind).toBe("play")
      if (ret.kind === "play") {
        expect(ret.clip).toBe(expectedClip)
      }
    }
  })
})
