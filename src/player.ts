// R15: orden fijo. NO reordenar según el resultado del entorno.
export const PLAYER_ORDER = ["paplay", "pw-play", "ffplay", "mpv", "aplay"] as const

export type PlayerName = (typeof PLAYER_ORDER)[number]

export function selectPlayer(available: readonly string[]): PlayerName | null {
  for (const candidate of PLAYER_ORDER) {
    if (available.includes(candidate)) return candidate
  }
  return null
}

// R18: volumen aparece en players que lo soportan. Formato del flag libre (no congelado).
// aplay (ALSA) no soporta volumen por línea de comando.
export function supportsVolume(player: PlayerName): boolean {
  return player !== "aplay"
}

export function buildCommand(
  player: PlayerName,
  clipPath: string,
  volume: number
): string[] {
  const v = Math.max(0, Math.min(100, Math.floor(volume)))
  switch (player) {
    case "paplay":
      // PulseAudio: --volume 0..65536
      return ["paplay", "--volume", String(Math.round((v / 100) * 65536)), clipPath]
    case "pw-play":
      // PipeWire: --volume 0.0..1.0
      return ["pw-play", "--volume", (v / 100).toFixed(2), clipPath]
    case "ffplay":
      // FFmpeg: -volume 0..100
      return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(v), clipPath]
    case "mpv":
      // mpv: --volume 0..130
      return ["mpv", "--no-terminal", "--volume", String(v), clipPath]
    case "aplay":
      // ALSA: no admite volumen por CLI
      return ["aplay", clipPath]
  }
}
