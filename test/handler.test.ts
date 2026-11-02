import { describe, expect, it } from "vitest"
import { createOdinVoiceHandler } from "../src/core.ts"
import type { ClipEntry, VoiceConfig } from "../src/config.ts"

function category(clips: ClipEntry[], cooldownMs: number = 0) {
  return {
    enabled: true,
    cooldownMs,
    clip: clips[0]?.clip ?? "missing.mp3",
    phrase: clips[0]?.phrase ?? "",
    clips,
  }
}

function config(finished: ClipEntry[], cooldownMs: number = 0): VoiceConfig {
  return {
    volume: 80,
    categories: {
      finished: category(finished, cooldownMs),
      error: category([{ clip: "error-1.mp3", phrase: "Error." }]),
      question: category([{ clip: "question-1.mp3", phrase: "Question." }]),
      permission: category([{ clip: "permission-1.mp3", phrase: "Permission." }]),
    },
  }
}

function playedClip(decision: ReturnType<ReturnType<typeof createOdinVoiceHandler>["onEvent"]>): string {
  expect(decision.kind).toBe("play")
  if (decision.kind !== "play") throw new Error("expected play")
  return decision.clip
}

function makeHandler(options: {
  configs?: VoiceConfig[]
  existsSync?: (clip: string) => boolean
  random?: () => number
  time?: number
} = {}) {
  const configs = options.configs ?? [config([{ clip: "finished-1.mp3", phrase: "It is done." }])]
  let configIndex = 0
  const clock = { value: options.time ?? 1_000 }
  const handler = createOdinVoiceHandler({
    readConfig: () => configs[Math.min(configIndex++, configs.length - 1)]!,
    env: {},
    now: () => clock.value,
    random: options.random ?? (() => 0),
    existsSync: options.existsSync ?? (() => true),
    detectPlayers: () => ["paplay"],
    log: () => {},
  })
  return { handler, clock, reads: () => configIndex }
}

describe("createOdinVoiceHandler — persistent state and contextual pools", () => {
  it("A2: reads config again for each event while preserving handler state", () => {
    const { handler, reads } = makeHandler({
      configs: [
        config([{ clip: "finished-old.mp3", phrase: "Old." }]),
        { ...config([{ clip: "finished-new.mp3", phrase: "[pause] New." }]), volume: 60 },
      ],
    })

    expect(playedClip(handler.onEvent("session.idle", { subagent: false }))).toBe("finished-old.mp3")
    expect(playedClip(handler.onEvent("session.idle", { subagent: false }))).toBe("finished-new.mp3")
    expect(reads()).toBe(2)
  })

  it("A4: injects RNG and avoids the immediately previous clip when alternatives exist", () => {
    const { handler } = makeHandler({
      random: () => 0,
      configs: [config([
        { clip: "finished-1.mp3", phrase: "One." },
        { clip: "finished-2.mp3", phrase: "Two." },
      ])],
    })

    expect(playedClip(handler.onEvent("session.idle", { subagent: false }))).toBe("finished-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", { subagent: false }))).toBe("finished-2.mp3")
  })

  it("A5: filters missing clips and returns no-clip when no candidate exists", () => {
    const available = makeHandler({
      configs: [config([
        { clip: "missing.mp3", phrase: "Missing." },
        { clip: "available.mp3", phrase: "Available." },
      ])],
      existsSync: (clip) => clip === "available.mp3",
    })
    expect(playedClip(available.handler.onEvent("session.idle", { subagent: false }))).toBe("available.mp3")

    const unavailable = makeHandler({
      configs: [config([{ clip: "missing.mp3", phrase: "Missing." }])],
      existsSync: () => false,
    })
    expect(unavailable.handler.onEvent("session.idle", { subagent: false })).toEqual({
      kind: "silence",
      reason: "no-clip",
    })
  })

  it("A10: selects an agent pool case-insensitively and falls back to an untagged entry", () => {
    const { handler } = makeHandler({
      configs: [config([
        { clip: "finished-1.mp3", phrase: "Generic." },
        { clip: "finished-themis-1.mp3", phrase: "Themis.", agent: "themis" },
      ])],
    })

    expect(playedClip(handler.onEvent("session.idle", {
      agent: "ThEmIs",
      subagent: true,
      topSessionID: "top-1",
    }))).toBe("finished-themis-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", {
      agent: "iris",
      subagent: true,
      topSessionID: "top-1",
    }))).toBe("finished-1.mp3")
  })

  it("A11: marks a subagent milestone, consumes flow once, and isolates session marks", () => {
    const { handler } = makeHandler({
      configs: [config([
        { clip: "finished-1.mp3", phrase: "Turn." },
        { clip: "finished-flow-1.mp3", phrase: "Flow.", scope: "flow" },
        { clip: "finished-themis-1.mp3", phrase: "Themis.", agent: "themis" },
      ])],
    })

    expect(playedClip(handler.onEvent("session.idle", {
      agent: "themis", subagent: true, topSessionID: "A",
    }))).toBe("finished-themis-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", {
      subagent: false, topSessionID: "A",
    }))).toBe("finished-flow-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", {
      subagent: false, topSessionID: "A",
    }))).toBe("finished-1.mp3")

    expect(playedClip(handler.onEvent("session.idle", {
      agent: "themis", subagent: true, topSessionID: "B",
    }))).toBe("finished-themis-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", {
      subagent: false, topSessionID: "A",
    }))).toBe("finished-1.mp3")
    expect(playedClip(handler.onEvent("session.idle", {
      subagent: false, topSessionID: "B",
    }))).toBe("finished-flow-1.mp3")
  })

  it("A12: context neither splits category cooldown nor last-clip state", () => {
    const cooldown = makeHandler({
      configs: [config([
        { clip: "finished-1.mp3", phrase: "Turn." },
        { clip: "finished-themis-1.mp3", phrase: "Themis.", agent: "themis" },
      ], 8_000)],
    })
    expect(playedClip(cooldown.handler.onEvent("session.idle", {
      subagent: false, topSessionID: "top-1",
    }))).toBe("finished-1.mp3")
    cooldown.clock.value += 1
    expect(cooldown.handler.onEvent("session.idle", {
      agent: "themis", subagent: true, topSessionID: "top-1",
    })).toEqual({ kind: "silence", reason: "cooldown" })

    const antiRepeat = makeHandler({
      configs: [config([
        { clip: "finished-1.mp3", phrase: "Turn one." },
        { clip: "finished-2.mp3", phrase: "Turn two." },
      ])],
      random: () => 0,
    })
    expect(playedClip(antiRepeat.handler.onEvent("session.idle", {
      subagent: false, topSessionID: "top-2",
    }))).toBe("finished-1.mp3")
    expect(playedClip(antiRepeat.handler.onEvent("session.idle", {
      agent: "unknown", subagent: true, topSessionID: "top-2",
    }))).toBe("finished-2.mp3")
  })
})
