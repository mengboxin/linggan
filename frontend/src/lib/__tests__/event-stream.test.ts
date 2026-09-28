import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  token: 'access-token',
  addNotification: vi.fn(),
}))

vi.mock('../auth', () => ({
  apiUrl: (path: string) => path,
  auth: {
    getAccessToken: () => mocks.token,
  },
}))

vi.mock('../notification-store', () => ({
  useNotificationStore: {
    getState: () => ({ add: mocks.addNotification }),
  },
}))

class FakeEventSource {
  static CLOSED = 2
  static instances: FakeEventSource[] = []

  readyState = 1
  onerror: (() => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener() {}

  close() {
    this.readyState = FakeEventSource.CLOSED
  }
}

describe('EventStreamClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('creates a new EventSource after a closed connection', async () => {
    const { EventStreamClient } = await import('../event-stream')
    const client = new EventStreamClient()

    client.start()
    const first = FakeEventSource.instances[0]
    first.readyState = FakeEventSource.CLOSED
    first.onerror?.()

    await vi.advanceTimersByTimeAsync(3000)

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1]?.url).toContain('/api/events/stream?token=access-token')
    client.stop()
  })

  it('keeps only one connection when start is called repeatedly for the same token', async () => {
    const { EventStreamClient } = await import('../event-stream')
    const client = new EventStreamClient()

    client.start()
    client.start()
    client.start()

    expect(FakeEventSource.instances).toHaveLength(1)
    client.stop()
  })
})
