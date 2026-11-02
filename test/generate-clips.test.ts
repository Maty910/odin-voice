import { describe, expect, it } from "vitest"
import { planClips, validateCredentials } from "../src/generate-clips.ts"

describe("validateCredentials", () => {
  it("G1: sin ELEVENLABS_API_KEY -> error nombra ELEVENLABS_API_KEY (R24)", () => {
    const res = validateCredentials({ env: { ELEVENLABS_VOICE_ID: "abc" } })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.missing).toBe("ELEVENLABS_API_KEY")
    }
  })

  it("G2: sin ELEVENLABS_VOICE_ID -> error nombra ELEVENLABS_VOICE_ID (R24)", () => {
    const res = validateCredentials({ env: { ELEVENLABS_API_KEY: "abc" } })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.missing).toBe("ELEVENLABS_VOICE_ID")
    }
  })

  it("G-extra: con ambas -> ok=true", () => {
    const res = validateCredentials({
      env: { ELEVENLABS_API_KEY: "abc", ELEVENLABS_VOICE_ID: "v" },
    })
    expect(res.ok).toBe(true)
  })

  it("G-extra: con ambas vacias -> trata como faltante", () => {
    const res = validateCredentials({
      env: { ELEVENLABS_API_KEY: "", ELEVENLABS_VOICE_ID: "" },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"]).toContain(res.missing)
    }
  })
})

describe("planClips", () => {
  const categories = {
    finished: { clip: "finished.mp3", phrase: "Listo." },
    error: { clip: "error.mp3", phrase: "Hubo un error." },
    question: { clip: "question.mp3", phrase: "Tengo una pregunta." },
    permission: { clip: "permission.mp3", phrase: "Necesito tu permiso." },
  }

  it("G3: clips existentes sin --force -> plan vacio (R25)", () => {
    const plan = planClips({
      existing: new Set(["finished.mp3", "error.mp3", "question.mp3", "permission.mp3"]),
      force: false,
      categories,
    })
    expect(plan).toEqual([])
  })

  it("G4: un clip faltante -> plan solo con ese (R26)", () => {
    const plan = planClips({
      existing: new Set(["finished.mp3", "error.mp3", "permission.mp3"]),
      force: false,
      categories,
    })
    expect(plan).toHaveLength(1)
    expect(plan[0].clip).toBe("question.mp3")
    expect(plan[0].phrase).toBe("Tengo una pregunta.")
    expect(plan[0].category).toBe("question")
  })

  it("G5: con --force -> plan con todas (R26)", () => {
    const plan = planClips({
      existing: new Set(["finished.mp3", "error.mp3", "question.mp3", "permission.mp3"]),
      force: true,
      categories,
    })
    expect(plan).toHaveLength(4)
    const clips = plan.map((p) => p.clip).sort()
    expect(clips).toEqual(["error.mp3", "finished.mp3", "permission.mp3", "question.mp3"])
  })

  it("G-extra: todos faltantes sin force -> plan con todas", () => {
    const plan = planClips({
      existing: new Set(),
      force: false,
      categories,
    })
    expect(plan).toHaveLength(4)
  })

  it("A6: aplana pools y conserva tags irrelevantes para la generacion", () => {
    const plan = planClips({
      existing: new Set(["finished-1.mp3"]),
      force: false,
      categories: {
        finished: {
          clips: [
            { clip: "finished-1.mp3", phrase: "[pause] It is done." },
            { clip: "finished-themis-1.mp3", phrase: "[exhales] Themis.", agent: "themis" },
          ],
        },
        error: { clip: "error-1.mp3", phrase: "[sighs] Error." },
      },
    })

    expect(plan).toEqual([
      {
        category: "finished",
        clip: "finished-themis-1.mp3",
        phrase: "[exhales] Themis.",
        agent: "themis",
      },
      { category: "error", clip: "error-1.mp3", phrase: "[sighs] Error." },
    ])
  })
})
