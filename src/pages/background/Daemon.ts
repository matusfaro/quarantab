import { QuaranTab, QuarantineStatus } from '@src/lib/quarantab'

export const ALLOW = {
  type: 'direct',
}
export const BLOCK = {
  // SocksV5 has an explicit setting to change whether to proxy DNS.
  // or not regardless of the `proxyDNS` setting we provide here.
  // This explicit setting in Firefox settings is set to NOT proxy
  // DNS by default which causes a leak for us. Use SocksV4 to avoid
  // this issue as DNS is proxied by default.
  type: 'socks4',
  host: `127.0.0.1`,
  port: 1,
  failoverTimeout: 1,
  username: 'does-not-exist',
  password: 'does-not-exist',
  proxyDNS: true
}

export default class Daemon {
  readonly _browser: typeof browser;
  readonly _quarantab: QuaranTab;

  constructor(browserInstance: typeof browser, quarantab: QuaranTab) {
    this._browser = browserInstance;
    this._quarantab = quarantab
  }

  async onRequest(requestDetails: browser.proxy._OnRequestDetails): Promise<object> {
    try {
      const status = await this._quarantab.checkStatus(requestDetails.cookieStoreId);
      if (status === QuarantineStatus.CLOSED) {
        return BLOCK;
      } else {
        return ALLOW;
      }
    } catch (e: unknown) {
      console.error(`Error in onRequest listener: ${e as string}`)
      return ALLOW
    }
  }

  async onTabCreated(tab: browser.tabs.Tab): Promise<void> {
    try {
      await this._quarantab.onTabCreated(tab);
    } catch (e: unknown) {
      console.error(`Error in onTabRemoved listener: ${e as string}`)
    }
  }

  async onTabUpdated(tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab): Promise<void> {
    try {
      await this._quarantab.onTabUpdated(tab);
    } catch (e: unknown) {
      console.error(`Error in onTabActivated listener: ${e as string}`)
    }
  }

  async onTabActivated(activeInfo: browser.tabs._OnActivatedActiveInfo): Promise<void> {
    try {
      await this._quarantab.onTabActivated(activeInfo);
    } catch (e: unknown) {
      console.error(`Error in onTabActivated listener: ${e as string}`)
    }
  }

  async onTabRemoved(tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo): Promise<void> {
    try {
      await this._quarantab.onTabClosed(tabId);
    } catch (e: unknown) {
      console.error(`Error in onTabRemoved listener: ${e as string}`)
    }
  }

  run(): void {
    // Listen for network requests to block or allow network access
    this._browser.proxy?.onRequest.addListener(this.onRequest.bind(this), { urls: ['<all_urls>'] })

    // Listen for tab opening/closing to detect when a container is no longer used
    // so the container can be safely cleaned up proactively
    this._browser.tabs?.onCreated.addListener(this.onTabCreated.bind(this))
    this._browser.tabs?.onRemoved.addListener(this.onTabRemoved.bind(this))

    // Listen for tab activated to change extension icon to match current state
    this._browser.tabs?.onUpdated.addListener(this.onTabUpdated.bind(this))
    this._browser.tabs?.onActivated.addListener(this.onTabActivated.bind(this))

    console.log(`Listening for network requests and tab events`);
  }
}
