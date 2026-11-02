import { describe, expect, it, vi } from "vitest"
import { extractContext, extractEvent } from "../src/context.ts"

const idle = (sessionID: string) => ({
  event: { type: "session.idle", data: { sessionID } },
})

const formCreated = (kind: string | undefined, sessionID = "top-1") => ({
  type: "form.created",
  data: {
    form: {
      sessionID,
      ...(kind === undefined ? {} : { metadata: { kind } }),
    },
  },
})

const execution = (type: string, sessionID: string) => ({
  type,
  data: { sessionID },
})

describe("extractContext", () => {
  it("A9: extracts a subagent context from an event payload", () => {
    expect(extractContext({
      event: {
        properties: {
          session: { id: "child-1", parentID: "top-1", agent: "Themis" },
        },
      },
    })).toEqual({ agent: "Themis", subagent: true, topSessionID: "top-1" })
  })

  it("A9: degrades missing payloads to generic context without throwing", () => {
    expect(() => extractContext(undefined)).not.toThrow()
    expect(extractContext(undefined)).toEqual({ subagent: false })
    expect(extractContext({ event: { properties: {} } })).toEqual({ subagent: false })
  })

  it("A9: accepts an alternative session shape and preserves its agent spelling", () => {
    expect(extractContext({
      session: { id: "child-2", parentId: "top-2", agent: { name: "THOR" } },
    })).toEqual({ agent: "THOR", subagent: true, topSessionID: "top-2" })
  })
})

describe("extractEvent", () => {
  it("A9: normalizes eventType and context from a realistic event payload", async () => {
    expect(await extractEvent({
      event: {
        type: "session.idle",
        properties: {
          session: { id: "child-1", parentID: "top-1", agent: "Themis" },
        },
      },
    })).toEqual({
      eventType: "session.idle",
      context: { agent: "Themis", subagent: true, topSessionID: "top-1" },
    })
  })

  it("A9: degrades minimal payloads to empty eventType and generic context", async () => {
    expect(await extractEvent(undefined)).toEqual({ eventType: "", context: { subagent: false } })
    expect(await extractEvent({ event: { properties: {} } })).toEqual({
      eventType: "",
      context: { subagent: false },
    })
  })

  it("A9: normalizes eventType from a root-level type on an alternative shape", async () => {
    expect(await extractEvent({
      type: "session.idle",
      session: { id: "child-2", parentId: "top-2", agent: { name: "THOR" } },
    })).toEqual({
      eventType: "session.idle",
      context: { agent: "THOR", subagent: true, topSessionID: "top-2" },
    })
  })

  it("V2-envelope-data-form-question: normalizes the documented wire envelope", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    expect(await extractEvent(formCreated("question"), lookup)).toEqual({
      eventType: "question.asked",
      context: { subagent: false, topSessionID: "top-1" },
    })
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("V2-envelope-properties-form-question: remains compatible with the legacy envelope", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    expect(await extractEvent({
      type: "form.created",
      properties: { form: { sessionID: "top-1", metadata: { kind: "question" } } },
    }, lookup)).toEqual({
      eventType: "question.asked",
      context: { subagent: false, topSessionID: "top-1" },
    })
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("V2-form-silence: non-question, missing or malformed forms stay silent without lookup", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }
    const payloads = [
      formCreated("other"),
      formCreated(undefined),
      { type: "form.created", data: { form: { sessionID: "top-1", metadata: "question" } } },
      { type: "form.created", data: { form: { sessionID: "top-1", metadata: null } } },
      { type: "form.replied", data: { form: { sessionID: "top-1" } } },
      { type: "form.cancelled", data: { form: { sessionID: "top-1" } } },
    ]

    for (const payload of payloads) {
      expect(await extractEvent(payload, lookup)).toEqual({
        eventType: payload.type,
        context: { subagent: false },
      })
    }
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("V2-envelope-data-execution-succeeded: resolves ID-only context", async () => {
    const get = vi.fn(async () => ({ id: "child-1", parentID: "top-1" }))
    const messages = vi.fn(async () => [
      { info: { role: "user", sessionID: "child-1", agent: "themis" }, parts: [] },
    ])

    expect(await extractEvent(execution("session.execution.succeeded", "child-1"), { get, messages })).toEqual({
      eventType: "session.idle",
      context: { agent: "themis", subagent: true, topSessionID: "top-1" },
    })
    expect(get).toHaveBeenCalledWith("child-1")
    expect(messages).toHaveBeenCalledWith("child-1")
  })

  it("V2-envelope-properties-execution-succeeded: remains compatible with the legacy envelope", async () => {
    const get = vi.fn(async () => ({ id: "child-1", parentID: "top-1" }))
    const messages = vi.fn(async () => [
      { info: { role: "user", sessionID: "child-1", agent: "themis" }, parts: [] },
    ])

    expect(await extractEvent({
      type: "session.execution.succeeded",
      properties: { sessionID: "child-1" },
    }, { get, messages })).toEqual({
      eventType: "session.idle",
      context: { agent: "themis", subagent: true, topSessionID: "top-1" },
    })
    expect(get).toHaveBeenCalledWith("child-1")
    expect(messages).toHaveBeenCalledWith("child-1")
  })

  it("V2-execution-silence: started and interrupted stay silent without lookup", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    for (const eventType of ["session.execution.started", "session.execution.interrupted"]) {
      expect(await extractEvent(execution(eventType, "top-1"), lookup)).toEqual({
        eventType,
        context: { subagent: false },
      })
    }
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("V2-execution-failed: maps to the legacy error event without lookup", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    expect(await extractEvent(execution("session.execution.failed", "top-1"), lookup)).toEqual({
      eventType: "session.error",
      context: { subagent: false },
    })
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("C1: resolves an ID-only idle child through the injected lookup and its last matching UserMessage.agent", async () => {
    const get = vi.fn(async () => ({ id: "child-1", parentID: "top-1" }))
    const messages = vi.fn(async () => [
      { info: { role: "user", sessionID: "child-1", agent: "iris" }, parts: [] },
      { info: { role: "assistant", sessionID: "child-1" }, parts: [] },
      { info: { role: "user", sessionID: "child-1", agent: "themis" }, parts: [] },
    ])

    expect(await extractEvent(idle("child-1"), { get, messages } as never)).toEqual({
      eventType: "session.idle",
      context: { agent: "themis", subagent: true, topSessionID: "top-1" },
    })
    expect(get).toHaveBeenCalledWith("child-1")
    expect(messages).toHaveBeenCalledWith("child-1")
  })

  it("C1b: unwraps SDK field-style responses for an ID-only child", async () => {
    const get = vi.fn(async () => ({
      data: { id: "child-1", parentID: "top-1" },
      request: {},
      response: {},
    }))
    const messages = vi.fn(async () => ({
      data: [{ info: { role: "user", sessionID: "child-1", agent: "themis" }, parts: [] }],
      request: {},
      response: {},
    }))

    expect(await extractEvent(idle("child-1"), { get, messages })).toEqual({
      eventType: "session.idle",
      context: { agent: "themis", subagent: true, topSessionID: "top-1" },
    })
    expect(get).toHaveBeenCalledWith("child-1")
    expect(messages).toHaveBeenCalledWith("child-1")
  })

  it("C2: keeps session lookups isolated by ID", async () => {
    const get = vi.fn(async (sessionID: string) => sessionID === "child-a"
      ? { id: "child-a", parentID: "top-a" }
      : { id: "child-b", parentID: "top-b" })
    const messages = vi.fn(async (sessionID: string) => [{
      info: { role: "user", sessionID, agent: sessionID === "child-a" ? "themis" : "iris" },
      parts: [],
    }])
    const lookup = { get, messages }

    expect(await extractEvent(idle("child-a"), lookup)).toMatchObject({
      context: { agent: "themis", subagent: true, topSessionID: "top-a" },
    })
    expect(await extractEvent(idle("child-b"), lookup)).toMatchObject({
      context: { agent: "iris", subagent: true, topSessionID: "top-b" },
    })
    expect(get.mock.calls).toEqual([["child-a"], ["child-b"]])
    expect(messages.mock.calls).toEqual([["child-a"], ["child-b"]])
  })

  it("C3: preserves historical embedded payloads without lookup", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    expect(await extractEvent({
      event: {
        type: "session.idle",
        properties: { session: { id: "child-legacy", parentID: "top-legacy", agent: "Themis" } },
      },
    }, lookup)).toEqual({
      eventType: "session.idle",
      context: { agent: "Themis", subagent: true, topSessionID: "top-legacy" },
    })
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("V2-envelope-data-session: preserves embedded agent and parent context without lookup", async () => {
    const lookup = { get: vi.fn(), messages: vi.fn() }

    expect(await extractEvent({
      event: {
        type: "session.idle",
        data: { session: { id: "child-data", parentID: "top-data", agent: "Themis" } },
      },
    }, lookup)).toEqual({
      eventType: "session.idle",
      context: { agent: "Themis", subagent: true, topSessionID: "top-data" },
    })
    expect(lookup.get).not.toHaveBeenCalled()
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("C4: treats a root ID-only session as generic and does not fetch messages", async () => {
    const lookup = {
      get: vi.fn(async () => ({ id: "root-1" })),
      messages: vi.fn(),
    }

    expect(await extractEvent(idle("root-1"), lookup)).toEqual({
      eventType: "session.idle",
      context: { subagent: false, topSessionID: "root-1" },
    })
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("C4b: keeps a field-style root response out of child message lookup", async () => {
    const lookup = {
      get: vi.fn(async () => ({ data: { id: "root-1" }, request: {}, response: {} })),
      messages: vi.fn(),
    }

    expect(await extractEvent(idle("root-1"), lookup)).toEqual({
      eventType: "session.idle",
      context: { subagent: false, topSessionID: "root-1" },
    })
    expect(lookup.messages).not.toHaveBeenCalled()
  })

  it("C5: falls back safely for lookup errors, denied messages, timeout, and missing parent or agent", async () => {
    expect(await extractEvent(idle("child-1"), {
      get: vi.fn(async () => { throw new Error("denied") }),
      messages: vi.fn(),
    })).toEqual({ eventType: "session.idle", context: { subagent: false } })

    expect(await extractEvent(idle("child-1"), {
      get: vi.fn(async () => ({ id: "child-1", parentID: "top-1" })),
      messages: vi.fn(async () => { throw new Error("permission denied") }),
    })).toEqual({
      eventType: "session.idle",
      context: { subagent: true, topSessionID: "top-1" },
    })

    expect(await extractEvent(idle("root-1"), {
      get: vi.fn(async () => ({ id: "root-1" })),
      messages: vi.fn(),
    })).toEqual({
      eventType: "session.idle",
      context: { subagent: false, topSessionID: "root-1" },
    })

    expect(await extractEvent(idle("child-1"), {
      get: vi.fn(async () => ({ id: "child-1", parentID: "top-1" })),
      messages: vi.fn(async () => [{ info: { role: "assistant", sessionID: "child-1" }, parts: [] }]),
    })).toEqual({
      eventType: "session.idle",
      context: { subagent: true, topSessionID: "top-1" },
    })

    vi.useFakeTimers()
    try {
      const pending = extractEvent(idle("child-timeout"), {
        get: vi.fn(() => new Promise(() => {})),
        messages: vi.fn(),
      })
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ eventType: "session.idle", context: { subagent: false } })
    } finally {
      vi.useRealTimers()
    }
  })

  it("C5b: degrades SDK error, missing-data, and undefined responses without reading messages", async () => {
    for (const response of [
      { error: { message: "denied" } },
      { request: {}, response: {} },
      undefined,
    ]) {
      const lookup = { get: vi.fn(async () => response), messages: vi.fn() }

      expect(await extractEvent(idle("child-1"), lookup)).toEqual({
        eventType: "session.idle",
        context: { subagent: false },
      })
      expect(lookup.messages).not.toHaveBeenCalled()
    }

    for (const response of [
      { error: { message: "denied" } },
      { request: {}, response: {} },
      undefined,
    ]) {
      const lookup = {
        get: vi.fn(async () => ({ data: { id: "child-1", parentID: "top-1" }, request: {}, response: {} })),
        messages: vi.fn(async () => response),
      }

      expect(await extractEvent(idle("child-1"), lookup)).toEqual({
        eventType: "session.idle",
        context: { subagent: true, topSessionID: "top-1" },
      })
    }
  })

  it("C5c: treats combined SDK error envelopes as unavailable data", async () => {
    const combinedError = { data: undefined, error: { message: "denied" }, request: {}, response: {} }
    const unavailableSession = { get: vi.fn(async () => combinedError), messages: vi.fn() }

    expect(await extractEvent(idle("child-1"), unavailableSession)).toEqual({
      eventType: "session.idle",
      context: { subagent: false },
    })
    expect(unavailableSession.messages).not.toHaveBeenCalled()

    const unavailableMessages = {
      get: vi.fn(async () => ({ data: { id: "child-1", parentID: "top-1" }, request: {}, response: {} })),
      messages: vi.fn(async () => combinedError),
    }

    expect(await extractEvent(idle("child-1"), unavailableMessages)).toEqual({
      eventType: "session.idle",
      context: { subagent: true, topSessionID: "top-1" },
    })
    expect(unavailableMessages.messages).toHaveBeenCalledWith("child-1")
  })

  it("C6: ignores message parts and does no lookup outside session.idle", async () => {
    const parts = Object.defineProperty({}, "value", {
      get: () => { throw new Error("message parts must stay private") },
    })
    const lookup = {
      get: vi.fn(async () => ({ id: "child-1", parentID: "top-1" })),
      messages: vi.fn(async () => [{
        info: { role: "user", sessionID: "child-1", agent: "themis" },
        parts,
      }]),
    }

    expect(await extractEvent(idle("child-1"), lookup)).toMatchObject({
      context: { agent: "themis", subagent: true, topSessionID: "top-1" },
    })
    expect(await extractEvent({
      event: { type: "unknown.event", properties: { sessionID: "child-1" } },
    }, lookup)).toEqual({
      eventType: "unknown.event",
      context: { subagent: false },
    })
    expect(lookup.get).toHaveBeenCalledTimes(1)
    expect(lookup.messages).toHaveBeenCalledTimes(1)
  })
})
