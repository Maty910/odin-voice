import type { Category } from "./events.ts"

export interface ClipEntry {
  clip: string
  phrase: string
  agent?: string
  scope?: string
}

export interface CategoryConfig {
  enabled: boolean
  phrase: string
  clip: string
  cooldownMs: number
  clips?: ClipEntry[]
}

export interface VoiceConfig {
  volume: number
  categories: Record<Category, CategoryConfig>
}

export type Log = (message: string) => void

// Las frases viven SOLO en config.json: los defaults llevan phrase "".
export const DEFAULTS: VoiceConfig = {
  volume: 80,
  categories: {
    finished: {
      enabled: true,
      phrase: "",
      clip: "finished.mp3",
      cooldownMs: 8000,
      clips: [{ clip: "finished.mp3", phrase: "" }],
    },
    error: {
      enabled: true,
      phrase: "",
      clip: "error.mp3",
      cooldownMs: 8000,
      clips: [{ clip: "error.mp3", phrase: "" }],
    },
    question: {
      enabled: true,
      phrase: "",
      clip: "question.mp3",
      cooldownMs: 8000,
      clips: [{ clip: "question.mp3", phrase: "" }],
    },
    permission: {
      enabled: true,
      phrase: "",
      clip: "permission.mp3",
      cooldownMs: 8000,
      clips: [{ clip: "permission.mp3", phrase: "" }],
    },
  },
}

function cloneCategory(category: CategoryConfig): CategoryConfig {
  return {
    ...category,
    clips: category.clips?.map((entry) => ({ ...entry })),
  }
}

function cloneDefaults(): VoiceConfig {
  return {
    volume: DEFAULTS.volume,
    categories: {
      finished: cloneCategory(DEFAULTS.categories.finished),
      error: cloneCategory(DEFAULTS.categories.error),
      question: cloneCategory(DEFAULTS.categories.question),
      permission: cloneCategory(DEFAULTS.categories.permission),
    },
  }
}

const CATEGORIES: Category[] = ["finished", "error", "question", "permission"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseClipEntry(value: unknown): ClipEntry | null {
  if (!isRecord(value) || typeof value.clip !== "string" || value.clip.length === 0 || typeof value.phrase !== "string") {
    return null
  }

  const entry: ClipEntry = { clip: value.clip, phrase: value.phrase }
  if (typeof value.agent === "string") entry.agent = value.agent
  if (typeof value.scope === "string") entry.scope = value.scope
  return entry
}

function legacyPool(category: CategoryConfig): ClipEntry[] {
  return [{ clip: category.clip, phrase: category.phrase }]
}

export function parseConfig(raw: string | null, log: Log): VoiceConfig {
  const cfg = cloneDefaults()
  if (raw === null) return cfg

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    log("odin-voice: config.json ilegible, usando defaults")
    return cfg
  }
  if (!isRecord(parsed)) return cfg

  if (typeof parsed.volume === "number" && Number.isFinite(parsed.volume)) {
    cfg.volume = parsed.volume
  }

  if (isRecord(parsed.categories)) {
    for (const cat of CATEGORIES) {
      const override = parsed.categories[cat]
      if (!isRecord(override)) continue
      const target = cfg.categories[cat]
      if (typeof override.enabled === "boolean") target.enabled = override.enabled
      if (typeof override.phrase === "string") target.phrase = override.phrase
      if (typeof override.clip === "string" && override.clip.length > 0) target.clip = override.clip
      if (typeof override.cooldownMs === "number" && Number.isFinite(override.cooldownMs) && override.cooldownMs >= 0) {
        target.cooldownMs = override.cooldownMs
      }

      if (Array.isArray(override.clips)) {
        const clips = override.clips
          .map(parseClipEntry)
          .filter((entry): entry is ClipEntry => entry !== null)
        target.clips = clips
        if (clips[0] !== undefined) {
          target.clip = clips[0].clip
          target.phrase = clips[0].phrase
        }
      } else if (typeof override.clip === "string" || typeof override.phrase === "string") {
        target.clips = legacyPool(target)
      }
    }
  }

  return cfg
}
