import { describe, expect, it } from "vitest"
import { PLAYER_ORDER, buildCommand, selectPlayer, supportsVolume } from "../src/player.ts"

describe("selectPlayer", () => {
  it("D1: [paplay, mpv] -> paplay", () => {
    expect(selectPlayer(["paplay", "mpv"])).toBe("paplay")
  })

  it("D2: [mpv, aplay] -> mpv", () => {
    expect(selectPlayer(["mpv", "aplay"])).toBe("mpv")
  })

  it("D3: [aplay] -> aplay", () => {
    expect(selectPlayer(["aplay"])).toBe("aplay")
  })

  it("D4: [] -> null (R17)", () => {
    expect(selectPlayer([])).toBe(null)
  })

  it("D5: [vlc] -> null (R16, binarios fuera de lista no califican)", () => {
    expect(selectPlayer(["vlc"])).toBe(null)
    expect(selectPlayer(["vlc", "clementine"])).toBe(null)
  })

  it("D-extra: orden fijo respeta PLAYER_ORDER aun con orden invertido en input", () => {
    // Disponible: aplay, mpv, paplay. Orden fijo favorece paplay.
    expect(selectPlayer(["aplay", "mpv", "paplay"])).toBe("paplay")
    expect(selectPlayer(["mpv", "pw-play"])).toBe("pw-play")
  })

  it("D-extra: PLAYER_ORDER es la lista canónica esperada", () => {
    expect(PLAYER_ORDER).toEqual(["paplay", "pw-play", "ffplay", "mpv", "aplay"])
  })
})

describe("buildCommand", () => {
  it("D6: argv contiene binario y clipPath; volumen presente cuando player lo soporta", () => {
    for (const player of ["paplay", "pw-play", "ffplay", "mpv"] as const) {
      const argv = buildCommand(player, "/tmp/foo.mp3", 60)
      expect(argv[0]).toBe(player)
      expect(argv).toContain("/tmp/foo.mp3")
      // volumen presente: hay un token numérico (sin assert del flag específico)
      const hasNumeric = argv.some((tok) => /^-?\d+(\.\d+)?$/.test(tok))
      expect(hasNumeric).toBe(true)
    }
  })

  it("D6: aplay no incluye flag de volumen (R18)", () => {
    const argv = buildCommand("aplay", "/tmp/foo.mp3", 60)
    expect(argv[0]).toBe("aplay")
    expect(argv).toContain("/tmp/foo.mp3")
    // ningún token numérico de volumen
    const hasNumeric = argv.some((tok) => /^-?\d+(\.\d+)?$/.test(tok))
    expect(hasNumeric).toBe(false)
  })

  it("D6: supportsVolume refleja la matriz de capacidades", () => {
    expect(supportsVolume("paplay")).toBe(true)
    expect(supportsVolume("pw-play")).toBe(true)
    expect(supportsVolume("ffplay")).toBe(true)
    expect(supportsVolume("mpv")).toBe(true)
    expect(supportsVolume("aplay")).toBe(false)
  })

  it("D6: volumen se clampea a [0,100] sin lanzar", () => {
    expect(() => buildCommand("paplay", "/x.mp3", -5)).not.toThrow()
    expect(() => buildCommand("paplay", "/x.mp3", 9999)).not.toThrow()
    const argv = buildCommand("paplay", "/x.mp3", 9999)
    // localizamos el token numérico de volumen sin asumir el orden del flag
    // (R18: formato/flag libre, NO congelado)
    const numericToken = argv.find((tok) => /^-?\d+(\.\d+)?$/.test(tok))
    expect(numericToken).toBeDefined()
    // 65536 es la escala nativa de PulseAudio, no del flag genérico (R18: formato/flag libre)
    expect(Number(numericToken)).toBeLessThanOrEqual(65536)
  })
})
