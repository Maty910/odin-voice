export interface VoiceContext {
  agent?: string
  subagent: boolean
  topSessionID?: string
}

type RecordValue = Record<string, unknown>
const LOOKUP_TIMEOUT_MS = 250

export interface SessionLookup {
  get(sessionID: string): Promise<unknown>
  context?(sessionID: string): Promise<unknown>
  // Compatibilidad interna para consumidores directos de extractEvent durante la
  // transición; el adapter V2 nunca crea ni invoca este miembro.
  messages?(sessionID: string): Promise<unknown>
}

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined
}

function unwrapSdkResponse(value: unknown): unknown {
  const response = asRecord(value)
  if (response === undefined) return value
  if ("data" in response) return response.data
  if ("error" in response || "request" in response || "response" in response) return undefined
  return value
}

function readString(record: RecordValue | undefined, keys: string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function readAgent(record: RecordValue | undefined): string | undefined {
  const direct = readString(record, ["agent", "agentName", "agent_name"])
  if (direct !== undefined) return direct

  const nested = asRecord(record?.agent)
  return readString(nested, ["name", "id"])
}

function readParentID(record: RecordValue | undefined): string | undefined {
  const direct = readString(record, ["parentID", "parentId", "parent_id"])
  if (direct !== undefined) return direct
  return readString(asRecord(record?.parent), ["id", "sessionID", "sessionId"])
}

function firstSession(payload: RecordValue): RecordValue | undefined {
  const event = asRecord(payload.event)
  const properties = asRecord(payload.properties)
  const eventProperties = asRecord(event?.properties)
  const data = asRecord(payload.data)
  const eventData = asRecord(event?.data)
  return [
    asRecord(payload.session),
    asRecord(properties?.session),
    asRecord(event?.session),
    asRecord(eventProperties?.session),
    asRecord(data?.session),
    asRecord(eventData?.session),
  ].find((session) => session !== undefined)
}

function readSessionID(root: RecordValue): string | undefined {
  const session = firstSession(root)
  const event = asRecord(root.event)
  const properties = asRecord(root.properties)
  const eventProperties = asRecord(event?.properties)
  const data = asRecord(root.data)
  const eventData = asRecord(event?.data)
  return readString(session, ["id", "sessionID", "sessionId", "session_id"])
    ?? readString(eventProperties, ["sessionID", "sessionId", "session_id"])
    ?? readString(properties, ["sessionID", "sessionId", "session_id"])
    ?? readString(root, ["sessionID", "sessionId", "session_id"])
    ?? readString(data, ["sessionID", "sessionId", "session_id"])
    ?? readString(eventData, ["sessionID", "sessionId", "session_id"])
}

function readEventType(root: RecordValue | undefined): string {
  if (typeof root?.type === "string") return root.type
  const event = asRecord(root?.event)
  return typeof event?.type === "string" ? event.type : ""
}

function firstForm(payload: RecordValue): RecordValue | undefined {
  const event = asRecord(payload.event)
  const properties = asRecord(payload.properties)
  const eventProperties = asRecord(event?.properties)
  const data = asRecord(payload.data)
  const eventData = asRecord(event?.data)
  return [
    asRecord(payload.form),
    asRecord(properties?.form),
    asRecord(event?.form),
    asRecord(eventProperties?.form),
    asRecord(data?.form),
    asRecord(eventData?.form),
  ].find((form) => form !== undefined)
}

function questionFormContext(payload: RecordValue): VoiceContext | undefined {
  const form = firstForm(payload)
  const kind = readString(asRecord(form?.metadata), ["kind"])
  if (kind !== "question") return undefined

  const sessionID = readString(form, ["sessionID", "sessionId", "session_id"])
  return sessionID === undefined
    ? { subagent: false }
    : { subagent: false, topSessionID: sessionID }
}

export function extractContext(payload: unknown): VoiceContext {
  const root = asRecord(payload)
  if (root === undefined) return { subagent: false }

  const session = firstSession(root)
  const parentID = readParentID(session)
  const sessionID = readString(session, ["id", "sessionID", "sessionId", "session_id"])
  const agent = readAgent(session) ?? readAgent(root)
  const context: VoiceContext = { subagent: parentID !== undefined }

  if (agent !== undefined) context.agent = agent
  if (parentID !== undefined) context.topSessionID = parentID
  else if (sessionID !== undefined) context.topSessionID = sessionID
  return context
}

function contextFromSession(session: RecordValue, fallbackSessionID?: string): VoiceContext {
  const parentID = readParentID(session)
  const sessionID = readString(session, ["id", "sessionID", "sessionId", "session_id"]) ?? fallbackSessionID
  const agent = readAgent(session)
  const context: VoiceContext = { subagent: parentID !== undefined }

  if (agent !== undefined) context.agent = agent
  if (parentID !== undefined) context.topSessionID = parentID
  else if (sessionID !== undefined) context.topSessionID = sessionID
  return context
}

function lastUserMessageAgent(messages: unknown, sessionID: string): string | undefined {
  if (!Array.isArray(messages)) return undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(messages[index])
    const info = asRecord(entry?.info)
    if (info?.role !== "user" || info.sessionID !== sessionID) continue
    const agent = readString(info, ["agent"])
    if (agent !== undefined) return agent
  }
  return undefined
}

async function withinLookupTimeout<T>(operation: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, LOOKUP_TIMEOUT_MS)
  })

  try {
    return await Promise.race([Promise.resolve().then(operation), timeout])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function resolveIdleContext(root: RecordValue, lookup: SessionLookup | undefined): Promise<VoiceContext> {
  if (firstSession(root) !== undefined) return extractContext(root)

  const sessionID = readSessionID(root)
  if (sessionID === undefined || lookup === undefined) return { subagent: false }

  const session = asRecord(unwrapSdkResponse(await withinLookupTimeout(() => lookup.get(sessionID))))
  if (session === undefined) return { subagent: false }

  const context = contextFromSession(session, sessionID)
  const sessionContext = lookup.context ?? lookup.messages
  if (!context.subagent || sessionContext === undefined) return context

  const messages = unwrapSdkResponse(await withinLookupTimeout(() => sessionContext(sessionID)))
  const agent = lastUserMessageAgent(messages, sessionID)
  return agent === undefined ? context : { ...context, agent }
}

export function createSessionLookup(ctx: unknown): SessionLookup | undefined {
  const session = asRecord(asRecord(ctx)?.session)
  const get = session?.get
  if (typeof get !== "function") return undefined

  const context = session?.context
  return {
    get: (sessionID) => Promise.resolve(get.call(session, { sessionID })),
    ...(typeof context === "function"
      ? { context: (sessionID: string) => Promise.resolve(context.call(session, { sessionID })) }
      : {}),
  }
}

export interface NormalizedEvent {
  eventType: string
  context: VoiceContext
}

export async function extractEvent(payload: unknown, lookup?: SessionLookup): Promise<NormalizedEvent> {
  const root = asRecord(payload)
  const receivedEventType = readEventType(root)
  if (receivedEventType === "form.created" && root !== undefined) {
    const context = questionFormContext(root)
    if (context !== undefined) return { eventType: "question.asked", context }
  }

  const eventType = receivedEventType === "session.execution.succeeded"
    ? "session.idle"
    : receivedEventType === "session.execution.failed"
      // Verified publisher: anomalyco/opencode@v2.1.2,
      // packages/core/src/session/execution.ts:135-142, SessionEvent.Execution.Failed.
      ? "session.error"
      : receivedEventType
  return {
    eventType,
    context: eventType === "session.idle" && root !== undefined
      ? await resolveIdleContext(root, lookup)
      : extractContext(payload),
  }
}
