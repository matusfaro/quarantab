import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import { ClosedText } from '@src/lib/quarantab'

/**
 * Firefox removes an extension's listeners when the background context is reloaded, but tabs in our
 * Containers survive and keep running. These tests pin down that a locked Container has no network
 * access at any point of that reload, including while the Container state is still being loaded.
 */

const LockedCookieStoreId = 'firefox-container-7'

type MockFn = ReturnType<typeof jest.fn>

type MockEvent = {
  listeners: Function[],
  addListener: MockFn,
  removeListener: MockFn,
  hasListener: MockFn,
}

function mockEvent(): MockEvent {
  const listeners: Function[] = []
  return {
    listeners,
    addListener: jest.fn((fn: Function) => { listeners.push(fn) }),
    removeListener: jest.fn((fn: Function) => {
      const index = listeners.indexOf(fn)
      if (index >= 0) listeners.splice(index, 1)
    }),
    hasListener: jest.fn((fn: Function) => listeners.indexOf(fn) >= 0),
  }
}

/** Lets a test hold the Container state load open for as long as it likes. */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** Runs every queued microtask and timer callback so far. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function mockBrowser(containers: { promise: Promise<any[]> }) {
  const proxyOnRequest = mockEvent()
  const webRequestOnBeforeRequest = mockEvent()
  const webRequestOnBeforeRedirect = mockEvent()
  const webRequestOnCompleted = mockEvent()
  const webRequestOnErrorOccurred = mockEvent()
  return {
    proxyOnRequest,
    webRequestOnBeforeRequest,
    webRequestOnBeforeRedirect,
    webRequestOnCompleted,
    webRequestOnErrorOccurred,
    api: {
      runtime: {
        getBrowserInfo: jest.fn(async () => ({ name: 'Firefox', vendor: 'Mozilla' })),
        getURL: jest.fn((path: string) => `moz-extension://test${path}`),
        sendMessage: jest.fn(async () => undefined),
        onMessage: mockEvent(),
      },
      contextualIdentities: {
        query: jest.fn(() => containers.promise),
        remove: jest.fn(async () => undefined),
      },
      tabs: {
        query: jest.fn(async () => [{ id: 1, windowId: 1 }]),
        update: jest.fn(async () => undefined),
        onCreated: mockEvent(),
        onRemoved: mockEvent(),
        onUpdated: mockEvent(),
        onActivated: mockEvent(),
      },
      privacy: {
        network: {
          peerConnectionEnabled: {
            get: jest.fn(async () => ({ value: true, levelOfControl: 'controllable_by_this_extension' })),
            set: jest.fn(async () => undefined),
            onChange: mockEvent(),
          },
        },
      },
      storage: {
        local: {
          get: jest.fn(async () => ({})),
          set: jest.fn(async () => undefined),
          remove: jest.fn(async () => undefined),
        },
      },
      proxy: { onRequest: proxyOnRequest },
      webRequest: {
        onBeforeRequest: webRequestOnBeforeRequest,
        onBeforeRedirect: webRequestOnBeforeRedirect,
        onCompleted: webRequestOnCompleted,
        onErrorOccurred: webRequestOnErrorOccurred,
      },
    },
  }
}

describe('Daemon blocking listeners across a background reload', () => {

  let Daemon: any

  beforeEach(() => {
    // getQuaranTabInstance caches a singleton per module registry
    jest.resetModules()
    Daemon = require('./Daemon').default
  })

  it('registers the blocking listeners before any Container state is loaded', () => {
    const containers = deferred<any[]>()
    const mock = mockBrowser(containers)
    ;(global as any).browser = mock.api

    new Daemon(mock.api)

    // Nothing has been awaited yet, so the Container state is still unknown here. The listeners
    // have to exist already, otherwise requests from a surviving locked tab leave the Container.
    expect(mock.proxyOnRequest.addListener).toHaveBeenCalledTimes(1)
    expect(mock.webRequestOnBeforeRequest.addListener).toHaveBeenCalledTimes(1)
    expect(mock.webRequestOnBeforeRedirect.addListener).toHaveBeenCalledTimes(1)
    expect(mock.webRequestOnCompleted.addListener).toHaveBeenCalledTimes(1)
    expect(mock.webRequestOnErrorOccurred.addListener).toHaveBeenCalledTimes(1)
  })

  it('blocks a request made by a locked Container while the state is still loading', async () => {
    const containers = deferred<any[]>()
    const mock = mockBrowser(containers)
    ;(global as any).browser = mock.api

    new Daemon(mock.api)

    const onBeforeRequest = mock.webRequestOnBeforeRequest.listeners[0]
    const onProxyRequest = mock.proxyOnRequest.listeners[0]

    // A page in the locked Container fires while we are still querying Containers and tabs
    const webRequestVerdict = onBeforeRequest({
      cookieStoreId: LockedCookieStoreId,
      requestId: '1',
      type: 'xmlhttprequest',
      url: 'http://127.0.0.1:45123/leak',
      tabId: 1,
    })
    const proxyVerdict = onProxyRequest({
      cookieStoreId: LockedCookieStoreId,
      requestId: '1',
      type: 'xmlhttprequest',
      url: 'http://127.0.0.1:45123/leak',
      tabId: 1,
    })

    // Both verdicts stay pending on the unresolved state rather than defaulting to allow
    let settled = false
    void Promise.all([webRequestVerdict, proxyVerdict]).then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)

    // Container state finishes loading and reports the Container as locked
    containers.resolve([{ cookieStoreId: LockedCookieStoreId, name: `QuaranTab${ClosedText}` }])

    expect(await webRequestVerdict).toEqual({ cancel: true })
    expect(await proxyVerdict).toEqual(expect.objectContaining({ type: 'socks4', port: 1 }))
  })

  it('stops the blocking listeners once loading finds no Containers of ours', async () => {
    const containers = deferred<any[]>()
    const mock = mockBrowser(containers)
    ;(global as any).browser = mock.api

    new Daemon(mock.api)
    containers.resolve([])
    await settle()

    // Nothing of ours is open, so we go back to not intercepting the user's other traffic
    expect(mock.proxyOnRequest.listeners).toHaveLength(0)
    expect(mock.webRequestOnBeforeRequest.listeners).toHaveLength(0)
  })
})
