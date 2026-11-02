// Lógica pura, testeable, sin red. El ejecutable scripts/generate-clips.ts la consume.

export type Category = "finished" | "error" | "question" | "permission"

export interface ClipInput {
  clip: string
  phrase: string
  agent?: string
  scope?: string
  [key: string]: unknown
}

export interface CategoryClip {
  category: Category
  clip: string
  phrase: string
  agent?: string
  scope?: string
}

export interface CategoryDefinition {
  clip?: unknown
  phrase?: unknown
  clips?: unknown
  [key: string]: unknown
}

export interface CategoryMap {
  [key: string]: CategoryDefinition
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; missing: string }

export function validateCredentials(deps: {
  env: Record<string, string | undefined>
}): ValidateResult {
  const apiKey = deps.env.ELEVENLABS_API_KEY
  const voiceId = deps.env.ELEVENLABS_VOICE_ID
  if (!apiKey || apiKey.length === 0) {
    return { ok: false, missing: "ELEVENLABS_API_KEY" }
  }
  if (!voiceId || voiceId.length === 0) {
    return { ok: false, missing: "ELEVENLABS_VOICE_ID" }
  }
  return { ok: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clipInput(value: unknown): ClipInput | null {
  if (!isRecord(value) || typeof value.clip !== "string" || typeof value.phrase !== "string") return null
  const item: ClipInput = { clip: value.clip, phrase: value.phrase }
  if (typeof value.agent === "string") item.agent = value.agent
  if (typeof value.scope === "string") item.scope = value.scope
  return item
}

export function clipPool(category: CategoryDefinition): ClipInput[] {
  if (Array.isArray(category.clips)) {
    return category.clips
      .map(clipInput)
      .filter((entry): entry is ClipInput => entry !== null)
  }
  const legacy = clipInput(category)
  return legacy === null ? [] : [legacy]
}

// Planning puro: si force=true, todos. Si no, solo los faltantes.
// Orden estable: insertion order de categories y de cada pool.
export function planClips(deps: {
  existing: Set<string>
  force: boolean
  categories: CategoryMap
}): CategoryClip[] {
  const out: CategoryClip[] = []
  for (const [category, definition] of Object.entries(deps.categories)) {
    for (const item of clipPool(definition)) {
      if (deps.force || !deps.existing.has(item.clip)) {
        const planned: CategoryClip = {
          category: category as Category,
          clip: item.clip,
          phrase: item.phrase,
        }
        if (item.agent !== undefined) planned.agent = item.agent
        if (item.scope !== undefined) planned.scope = item.scope
        out.push(planned)
      }
    }
  }
  return out
}
