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
  readonly _quarantab;

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

  run(): void {
    // TODO proxy is undefined if no permission
    this._browser.proxy?.onRequest.addListener(
      this.onRequest.bind(this),
      { urls: ['<all_urls>'] })
  }
}
