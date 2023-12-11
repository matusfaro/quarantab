import { QuaranTab, QuarantineStatus, Runner, getQuaranTabInstance } from '@src/lib/quarantab'
import { close } from 'fs-extra'

const WebRequestAllow: browser.webRequest.BlockingResponse = {}
const WebRequestBlock: browser.webRequest.BlockingResponse = {
  cancel: true,
}

const ProxyRequestAllow = {
  type: 'direct',
}
const ProxyRequestBlock = {
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
  readonly _cookieStoreIdToOpenRequestIds = new Map<string, Set<string>>();
  readonly _cookieStoreIdToClosedRequestIds = new Map<string, Set<string>>();

  constructor(browserInstance: typeof browser) {
    this._browser = browserInstance;
    const { startBlockingListeners, stopBlockingListeners } = this.prepareControllableListeners();
    this._quarantab = getQuaranTabInstance(Runner.BACKGROUND, startBlockingListeners, stopBlockingListeners);
    this.runListeners();
  }

  webRequestOnBeforeRequest(requestDetails: browser.webRequest._OnBeforeRequestDetails): void {
    this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'open');
  }

  // Currently we utilize browser.proxy.onRequest to block requests so we don't need to block
  // using browser.webRequest.onBeforeRequest. This method is unused, but is left here as a reference
  // in case we end up wanting to block. To make this work:
  // - Add "webRequestBlocking" permission to the manifest
  // - In onBeforeRequest.addListener, add ['blocking'] as a second parameter
  // - In onBeforeRequest.addListener, use this method instead of webRequestOnBeforeRequest
  async webRequestOnBeforeRequestBlocking(requestDetails: browser.webRequest._OnBeforeRequestDetails): Promise<browser.webRequest.BlockingResponse> {
    try {
      // Determine whether this request is part of our container and whether it should be blocked
      const status = await this._quarantab.checkStatus(requestDetails.cookieStoreId);
      switch (status) {
        // Part of our container and container is currently open
        case QuarantineStatus.OPEN:
          if (requestDetails.type === 'websocket') {
            // Special handling for websockets, see method for details
            return (await this._quarantab.shouldBlockWebsocketOnOpen()) ? WebRequestBlock : WebRequestAllow;
          }
          break;
        // Part of our container and container is now blocked
        case QuarantineStatus.CLOSED:
        case QuarantineStatus.CLOSING:
          return WebRequestBlock;
        // Not out container, allow
        default:
          break;
      }

      // Track connection as open and allow it 
      this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'open');
      return WebRequestAllow;

    } catch (e: unknown) {
      console.error(`Error in onBeforeRequest listener: ${e as string}`)
      // On error allow
      return WebRequestAllow
    }
  }

  webRequestOnCompleted(requestDetails: browser.webRequest._OnCompletedDetails): void {
    this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'completed');
  }

  webRequestOnErrorOccurred(requestDetails: browser.webRequest._OnErrorOccurredDetails): void {
    this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'error');
  }

  async trackRequestStateChanged(cookieStoreId: string | undefined, requestId: string, requestType: browser.webRequest.ResourceType, requestState: 'open' | 'completed' | 'error' | 'block'): Promise<void> {
    try {
      // If cookiestoreid is empty, not part of our container
      if (!cookieStoreId) {
        return;
      }

      // Decide whether we want to track this request type.
      // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/ResourceType
      switch (requestType) {
        // In Firefox, when a shim is made for a particular tracker, the connection is seen as open, but
        // it will never complete or error out. It is unfortunate we can't determine whether the connection
        // is still open, or was shimmed by Firefox.
        //
        // Bug in Firefox: https://bugzilla.mozilla.org/show_bug.cgi?id=1869194
        //
        // We need to track connections that can send data back to a malicious server. The following request types
        // can only send data at the initial connection so it is safe to use.
        // Other requests that are long-lived such websocket and server-sent events are ones we need
        // to continue tracking.
        case 'script':
        case 'stylesheet':
        case 'ping':
        case 'font':
        case 'imageset':
        case 'image':
          return; // Don't track
        default:
          break; // Track
      }

      // Determine the container status where this request is being made
      const status = await this._quarantab.checkStatus(cookieStoreId);

      // This container is not under our control
      if (status === QuarantineStatus.NONE) {
        return;
      }

      // Check if this connection already closed
      var closedRequestIds = this._cookieStoreIdToClosedRequestIds.get(cookieStoreId);
      if (closedRequestIds?.has(requestId)) {
        closedRequestIds.delete(requestId);
        if (closedRequestIds.size === 0) {
          this._cookieStoreIdToClosedRequestIds.delete(cookieStoreId);
        }
        return;
      }

      // If this connection is closing, but we have no record of it, keep track that it is closed
      // This happens when the listener events are out of order
      var openRequestIds = this._cookieStoreIdToOpenRequestIds.get(cookieStoreId);
      if (requestState !== 'open' && (!openRequestIds || !openRequestIds?.has(requestId))) {
        if (!closedRequestIds) {
          closedRequestIds = new Set<string>();
          this._cookieStoreIdToClosedRequestIds.set(cookieStoreId, closedRequestIds);
        }
        closedRequestIds.add(requestId);
        return;
      }

      // Initialize set of open connections for this container session
      if (!openRequestIds) {
        openRequestIds = new Set<string>();
        this._cookieStoreIdToOpenRequestIds.set(cookieStoreId, openRequestIds);
      }

      // Change state of request to open or close
      if (requestState === 'open') {
        openRequestIds.add(requestId);
      } else {
        openRequestIds.delete(requestId);
        if (openRequestIds.size === 0) {
          this._cookieStoreIdToOpenRequestIds.delete(cookieStoreId);
        }
      }

      // Notify subscribers
      await this._quarantab.onRequestCountChanged(cookieStoreId, openRequestIds.size);

    } catch (e: unknown) {
      console.error(`Error in trackRequestStateChanged listener: ${e as string}`)
    }
  }

  getCookieStoreIdOpenRequestCount(cookieStoreId: string | undefined): number {
    // If cookiestoreid is empty, not part of our container, return zero connections
    if (!cookieStoreId) {
      return 0;
    }

    // Count the number of open connections for this container session
    return this._cookieStoreIdToOpenRequestIds.get(cookieStoreId)?.size || 0;
  }

  /**
   * This method is called for every new request in the entire browser.
   * Keep it lean!
   * 
   * @param requestDetails 
   * @returns 
   */
  async onProxyRequest(requestDetails: browser.proxy._OnRequestDetails): Promise<object> {
    try {
      // Determine whether this request is part of our container and whether it should be blocked
      const status = await this._quarantab.checkStatus(requestDetails.cookieStoreId);
      switch (status) {
        // Part of our container and container is currently open
        case QuarantineStatus.OPEN:
          if (requestDetails.type === 'websocket') {
            // Special handling for websockets, see method for details
            if (await this._quarantab.shouldBlockWebsocketOnOpen()) {
              this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'block');
              return ProxyRequestBlock;
            }
          }
          return ProxyRequestAllow;
        // Part of our container and container is now blocked
        case QuarantineStatus.CLOSED:
        case QuarantineStatus.CLOSING:
          this.trackRequestStateChanged(requestDetails.cookieStoreId, requestDetails.requestId, requestDetails.type, 'block');
          return ProxyRequestBlock;
        // Not out container, allow
        default:
          return ProxyRequestAllow;
      }
    } catch (e: unknown) {
      console.error(`Error in onRequest listener: ${e as string}`)
      // On error allow
      return ProxyRequestAllow
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

  peerConnectionOnChange(details: browser.types._OnChangeDetails): void {
    try {
      this._quarantab.onWebRtcEnabledChanged(!!details.value);
    } catch (e: unknown) {
      console.error(`Error in peerConnectionOnChange listener: ${e as string}`)
    }
  }

  prepareControllableListeners(): { startBlockingListeners: () => void, stopBlockingListeners: () => void } {

    // Methods to start/stop listeners for the purposes of blocking network access
    // This is to avoid listening when the extension is not in use, when no containers are open
    const proxyOnRequestListener = this.onProxyRequest.bind(this)
    const webRequestOnBeforeRequestListener = this.webRequestOnBeforeRequest.bind(this)
    const webRequestOnCompletedRequestListener = this.webRequestOnCompleted.bind(this)
    const webRequestOnErrorOccurredRequestListener = this.webRequestOnErrorOccurred.bind(this)
    const startBlockingListeners = () => {

      // Listen for network requests to block or allow network access by setting bogus proxy settings
      this._browser.proxy.onRequest.hasListener(proxyOnRequestListener)
        || this._browser.proxy.onRequest.addListener(proxyOnRequestListener, { urls: ['<all_urls>'] })

      // Listen for requests start and stop to keep a running count of all active connections (non-blocking)
      this._browser.webRequest.onBeforeRequest.hasListener(webRequestOnBeforeRequestListener)
        || this._browser.webRequest.onBeforeRequest.addListener(webRequestOnBeforeRequestListener, { urls: ['<all_urls>'] });
      this._browser.webRequest.onCompleted.hasListener(webRequestOnCompletedRequestListener)
        || this._browser.webRequest.onCompleted.addListener(webRequestOnCompletedRequestListener, { urls: ['<all_urls>'] });
      this._browser.webRequest.onErrorOccurred.hasListener(webRequestOnErrorOccurredRequestListener)
        || this._browser.webRequest.onErrorOccurred.addListener(webRequestOnErrorOccurredRequestListener, { urls: ['<all_urls>'] });

    }
    const stopBlockingListeners = () => {

      // Remove all dynamic listeners
      this._browser.proxy.onRequest.hasListener(proxyOnRequestListener)
        && this._browser.proxy.onRequest.removeListener(proxyOnRequestListener);
      this._browser.webRequest.onBeforeRequest.hasListener(webRequestOnBeforeRequestListener)
        && this._browser.webRequest.onBeforeRequest.removeListener(webRequestOnBeforeRequestListener);
      this._browser.webRequest.onCompleted.hasListener(webRequestOnCompletedRequestListener)
        && this._browser.webRequest.onCompleted.removeListener(webRequestOnCompletedRequestListener);
      this._browser.webRequest.onErrorOccurred.hasListener(webRequestOnErrorOccurredRequestListener)
        && this._browser.webRequest.onErrorOccurred.removeListener(webRequestOnErrorOccurredRequestListener);
    }

    return { startBlockingListeners, stopBlockingListeners }
  }

  runListeners(): void {

    // Listen for tab opening/closing to detect when a container is no longer used
    // so the container can be safely cleaned up proactively
    this._browser.tabs.onCreated.addListener(this.onTabCreated.bind(this))
    this._browser.tabs.onRemoved.addListener(this.onTabRemoved.bind(this))

    // Listen for tab activated to change extension icon to match current state
    this._browser.tabs.onUpdated.addListener(this.onTabUpdated.bind(this))
    this._browser.tabs.onActivated.addListener(this.onTabActivated.bind(this))

    // Listen for global WebRTC enable state changes
    this._browser.privacy.network.peerConnectionEnabled.onChange.addListener(this.peerConnectionOnChange.bind(this));
  }
}
