import { describe, expect, it, vi } from "vitest"
import { createAnnouncementGate, type Announcement } from "../src/announcement-gate.ts"

type Candidate = Announcement & { id: string }

function makeGate() {
  const clock = { now: 0 }
  const scheduled: Array<{ at: number; run: () => void }> = []
  const dispatch = vi.fn<(candidate: Candidate) => void>()
  const gate = createAnnouncementGate<Candidate>({
    now: () => clock.now,
    schedule: (run, delay) => {
      scheduled.push({ at: clock.now + delay, run })
    },
    dispatch,
  })

  const advance = (ms: number): void => {
    clock.now += ms
    for (;;) {
      const due = scheduled
        .filter((entry) => entry.at <= clock.now)
        .sort((a, b) => a.at - b.at)
      if (due.length === 0) return
      for (const entry of due) {
        scheduled.splice(scheduled.indexOf(entry), 1)
        entry.run()
      }
    }
  }

  return { gate, dispatch, advance }
}

describe("announcement gate", () => {
  it("G1: coalesces a burst and dispatches only its highest-priority candidate after 900 ms", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "finished", eventType: "session.idle" })
    gate.announce({ id: "error", eventType: "session.error" })
    gate.announce({ id: "permission", eventType: "permission.asked" })

    advance(899)
    expect(dispatch).not.toHaveBeenCalled()
    advance(1)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ id: "permission", eventType: "permission.asked" })
  })

  it("G2: keeps the first candidate when highest-priority candidates tie", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "first-question", eventType: "question.asked" })
    gate.announce({ id: "second-question", eventType: "question.asked" })
    advance(900)

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ id: "first-question", eventType: "question.asked" })
  })

  it("G3: never invokes the handler for losers, so they consume no handler state", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "loser", eventType: "session.idle" })
    gate.announce({ id: "winner", eventType: "session.error" })
    advance(900)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: "winner" }))
  })

  it("G4: does not replace a candidate after its window has already dispatched", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "finished", eventType: "session.idle" })
    advance(900)
    gate.announce({ id: "permission", eventType: "permission.asked" })

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ id: "finished", eventType: "session.idle" })
    advance(900)
    expect(dispatch).toHaveBeenLastCalledWith({ id: "permission", eventType: "permission.asked" })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it("G5: a late higher-priority candidate keeps the first candidate's deadline", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "finished", eventType: "session.idle" })
    advance(800)
    gate.announce({ id: "permission", eventType: "permission.asked" })

    expect(dispatch).not.toHaveBeenCalled()
    advance(99)
    expect(dispatch).not.toHaveBeenCalled()
    advance(1)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ id: "permission", eventType: "permission.asked" })
    advance(800)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("G6: permission wins when it arrives after a question in the same window", () => {
    const { gate, dispatch, advance } = makeGate()

    gate.announce({ id: "question", eventType: "question.asked" })
    advance(450)
    gate.announce({ id: "permission", eventType: "permission.asked" })
    advance(450)

    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ id: "permission", eventType: "permission.asked" })
  })
})
