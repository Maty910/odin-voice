export const COALESCE_WINDOW_MS = 900

export interface Announcement {
  eventType: string
}

export interface AnnouncementGateDeps<T extends Announcement> {
  now: () => number
  schedule: (run: () => void, delay: number) => unknown
  cancel?: (handle: unknown) => void
  dispatch: (announcement: T) => void
}

export interface AnnouncementGate<T extends Announcement> {
  announce(announcement: T): void
  cancel(): void
}

function priority(eventType: string): number {
  switch (eventType) {
    case "permission.asked": return 4
    case "question.asked": return 3
    case "session.error": return 2
    case "session.idle": return 1
    default: return 0
  }
}

export function createAnnouncementGate<T extends Announcement>(deps: AnnouncementGateDeps<T>): AnnouncementGate<T> {
  let pending: T | undefined
  let pendingPriority = 0
  let timer: unknown

  const flush = (): void => {
    const winner = pending
    pending = undefined
    timer = undefined
    if (winner !== undefined) deps.dispatch(winner)
  }

  return {
    announce(announcement): void {
      const candidatePriority = priority(announcement.eventType)
      if (pending === undefined) {
        pending = announcement
        pendingPriority = candidatePriority
        const deadline = deps.now() + COALESCE_WINDOW_MS
        timer = deps.schedule(flush, Math.max(0, deadline - deps.now()))
        return
      }
      if (candidatePriority > pendingPriority) {
        pending = announcement
        pendingPriority = candidatePriority
      }
    },
    cancel(): void {
      if (timer !== undefined) deps.cancel?.(timer)
      pending = undefined
      timer = undefined
    },
  }
}
