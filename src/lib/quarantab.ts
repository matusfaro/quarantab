export enum Runner {
    BACKGROUND = 'background',
    POPUP = 'popup',
}

export type Unsubscribe = () => void;

type Message = {
    type: 'CONTAINER_ABOUT_TO_START',
} | {
    type: 'SET_QUARANTINE_STATUS',
    cookieStoreId: string,
    status: QuarantineStatus,
} | {
    type: 'ON_TAB_ACTIVATED',
    tabId: number,
    windowId: number,
} | {
    type: 'ON_TAB_UPDATED',
    tabId: number,
    windowId: number,
} | {
    type: 'ON_REQUEST_COUNT_CHANGED',
    cookieStoreId: string,
    count: number,
} | {
    type: 'ON_WEBRTC_ENABLED_CHANGED',
    isEnabled: boolean,
}

export enum QuarantineStatus {
    NONE,
    OPEN,
    CLOSING,
    CLOSED,
}

export const NoneColor = 'lightgrey';
export const NoneColorRgb = '#D3D3D3';
export const OpenColor = 'yellow';
export const OpenColorRgb = '#F7CD45';
export const ClosingColor = 'red';
export const ClosingColorRgb = '#CD4B3C';
export const ClosedColor = 'green';
export const ClosedColorRgb = '#72C935';

export const OpenText = '';
export const ClosedText = ' - Locked';

const WebRtcDisabledFlag = 'webrtc-disabled';

export class QuaranTab {
    readonly _browserInfo = browser.runtime.getBrowserInfo();
    readonly _startupListeners?: () => void;
    readonly _shutdownListeners?: () => void;
    readonly _runner: Runner;
    readonly _browser: typeof browser;
    /**
     * Tracking which tabs are using which cookie store ids. Only tabs under Containers that we own are tracked.
     */
    readonly _tabIdToCookieStoreId: Map<number, string> = new Map();
    readonly _cookieStoreIdToTabIds: Map<string, Set<number>> = new Map();
    readonly _cookieStoreIdOpenRequestCount: Map<string, number> = new Map();
    readonly _cookieStoreIdToOpenRequestCountChangedListener: Map<string, (openRequestCount: number) => void> = new Map();
    /**                    containerColor = OpenColor;

     * List of Containers that are owned by this extension and their corresponding lock state.
     */
    readonly _cookieStoreIdToIsLocked: Promise<Map<string, boolean>>;
    _onStatusChanged: (() => void) | undefined = undefined;
    _onWebRtcEnabledChangeListener: ((isEnabled: boolean) => void) | undefined;

    constructor(runner: Runner, browserInstance: typeof browser, startupListeners?: () => void, shutdownListeners?: () => void) {
        this._runner = runner;
        this._browser = browserInstance;
        this._startupListeners = startupListeners;
        this._shutdownListeners = shutdownListeners;

        this._cookieStoreIdToIsLocked = this._loadContainerState();
        this._initializeRunner();
    }

    async _startup(): Promise<void> {
        this._startupListeners?.();
        await this.disableWebRtc();
    }

    async _shutdown(): Promise<void> {
        this._shutdownListeners?.();
        await this.resetWebRtc();
    }

    /**
     * Set a callback to be called when the status of the current tab changes. Either when the status changes or the tab changes.
     * 
     * @param callback 
     */
    subscribeOnStatusChanged(onChanged: () => void): Unsubscribe {
        this._onStatusChanged = onChanged;
        return () => {
            if (this._onStatusChanged === onChanged) {
                this._onStatusChanged = undefined;
            }
        }
    }

    /**
     * Given a cookieStoreId (Container reference), returns the status of that container.
     * 
     * @param cookieStoreId 
     * @returns 
     */
    async checkStatus(cookieStoreId?: string | undefined): Promise<QuarantineStatus> {
        if (cookieStoreId === undefined) return QuarantineStatus.NONE;

        const isLocked = (await this._cookieStoreIdToIsLocked).get(cookieStoreId);
        if (isLocked === true) {
            if (!this._cookieStoreIdOpenRequestCount.get(cookieStoreId)) {
                return QuarantineStatus.CLOSED;
            } else {
                return QuarantineStatus.CLOSING;
            }
        } else if (isLocked === false) {
            return QuarantineStatus.OPEN;
        } else {
            return QuarantineStatus.NONE;
        }
    }

    /**
     * Special case whether to block WebSocket connections on open status.
     * 
     * In Firefox, we can terminate open WebSocket connections using window.stop()
     * but in other browsers (e.g. Chrome) we cannot. So we must block WebSocket
     * connections from starting even before network lock is requested
     */
    async shouldBlockWebsocketOnOpen(): Promise<boolean> {
        const browserInfo = (await this._browserInfo);
        if (browserInfo.name === 'Firefox' && browserInfo.vendor === 'Mozilla') {
            return false;
        } else {
            return true;
        }
    }

    /**
     * Creates a new temporary container and re-opens current tab within it.
     * 
     * @param currentTab 
     * @returns new opened tab
     */
    async openTabInQuarantine(
        replaceTab?: browser.tabs.Tab,
        lockAfterLoadWithCallback?: (updatedTab: Promise<browser.tabs.Tab>) => void,
    ): Promise<browser.tabs.Tab> {
        if (replaceTab && (!replaceTab.id || !replaceTab.windowId)) throw new Error('Cannot access tab');

        // Notify background script a container is about to be started
        // Wait until we get a response to ensure everythign is prepared
        const messageEnableMonitoring: Message = {
            type: 'CONTAINER_ABOUT_TO_START',
        };
        await this._browser.runtime.sendMessage(messageEnableMonitoring);

        // Create new temporary container just for this tab
        const container = await browser.contextualIdentities.create({
            name: this._getQuaranTabContainerName(false),
            color: OpenColor,
            icon: 'fence',
        });
        if (!container.cookieStoreId) throw new Error('Failed to create container');
        await this._setIsLocked(container.cookieStoreId, QuarantineStatus.OPEN)

        // Open new tab in our new container
        const newTabPromise = this._browser.tabs.create({
            url: replaceTab !== undefined ? replaceTab.url : undefined,
            cookieStoreId: container.cookieStoreId,
            active: true,
            openerTabId: replaceTab !== undefined ? replaceTab.id : undefined,
            index: replaceTab !== undefined ? replaceTab.index + 1 : undefined,
        });

        // Close current tab
        if (replaceTab?.id !== undefined) {
            this._browser.tabs.remove(replaceTab.id);
        }

        // If requested, lock the container after the tab has finished loading site
        if (!!lockAfterLoadWithCallback) {
            // Listen for tab updates
            const onUpdatedListener = async (tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => {
                const newTab = await newTabPromise;
                // If site within the tab has completed loading, lock the container
                if (changeInfo.status === 'complete' && tabId === newTab.id) {
                    this._browser.tabs.onUpdated.removeListener(onUpdatedListener);
                    console.log(`${this._runner}: Detected site has loaded, triggering lock for container id ${container.cookieStoreId} in a moment`)

                    // Wait extra second after page load to let extra resources to be initiated
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    // Finally lock the container
                    lockAfterLoadWithCallback(this.lockQuarantine(tab));
                }
            }
            this._browser.tabs.onUpdated.addListener(onUpdatedListener);
        }

        // Return reference to our new tab
        console.log(`${this._runner}: ${replaceTab ? 'Re-opened current' : 'Opened new'} tab with new container id ${container.cookieStoreId}`);
        return await newTabPromise;
    }

    /**
     * Lock a container and all tabs within it. Locking cuts off network access to prevent data exfiltration.
     * 
     * @param currentTab 
     * @returns 
     */
    async lockQuarantine(currentTab: browser.tabs.Tab): Promise<browser.tabs.Tab> {
        if (!currentTab.cookieStoreId || !currentTab.id || !currentTab.windowId) throw new Error('Cannot access current tab');

        // Fetch current open request count
        const openRequestCount = this.getCookieStoreOpenRequestCount(currentTab.cookieStoreId);

        // Set to be quarantined
        await this._setIsLocked(currentTab.cookieStoreId,
            openRequestCount > 0 ? QuarantineStatus.CLOSING : QuarantineStatus.CLOSED)
        console.log(`${this._runner}: Cutting network access to container id ${currentTab.cookieStoreId}`);

        return this._browser.tabs.get(currentTab.id);
    }

    /**
     * Delete a container. Includes deleting all of its data and closing any tabs associated with this container.
     * 
     * @param cookieStoreId 
     * @returns 
     */
    async purgeQurantine(cookieStoreId?: string): Promise<void> {
        if (!cookieStoreId) return;

        // Since we listen for tab changes and delete containers once all tabs
        // are closed, all we need to do is close all tabs using this container
        const tabIds = (await this._browser.tabs
            .query({ cookieStoreId }))
            .reduce<number[]>((ids, tab) => {
                if (tab.id !== undefined) {
                    ids.push(tab.id);
                }
                return ids;
            }, []);
        await this._browser.tabs.remove(tabIds);
        console.log(`${this._runner}: Closed ${tabIds.length} tabs to trigger purge of container id ${cookieStoreId}`);
    }

    /**
     * Check if WebRTC is enabled globally in the browser.
     */
    async getWebRtcEnabled(): Promise<browser.types._GetReturnDetails> {
        const setting = await this._browser.privacy.network.peerConnectionEnabled.get({});
        return setting;
    }

    /**
     * Disable WebRTC globally in the browser.
     */
    async disableWebRtc(): Promise<void> {
        // Get current state
        const setting = await this.getWebRtcEnabled();
        if (!setting.value) {
            // Already disabled, nothing to do
            return;
        }
        if (setting.levelOfControl === 'not_controllable') {
            throw new Error('WebRTC cannot be changed by this extension');
        }
        if (setting.levelOfControl === 'controlled_by_other_extensions') {
            throw new Error('WebRTC is controlled by other extensions');
        }
        // Disable it
        await this._browser.privacy.network.peerConnectionEnabled.set({ value: false });
        await this._browser.storage.local.set({ [WebRtcDisabledFlag]: true });
        this.onWebRtcEnabledChanged(false);
    }

    /**
     * Reset previously disabled WebRTC globally in the browser to previous state.
     */
    async resetWebRtc(): Promise<void> {
        // Get current state
        const setting = await this.getWebRtcEnabled();
        const isWebrtcDisabledByUs = (await this._browser.storage.local.get(WebRtcDisabledFlag))[WebRtcDisabledFlag];
        if (setting.levelOfControl !== 'controlled_by_this_extension' && !isWebrtcDisabledByUs) {
            // Most likely wasn't changed by our extension so let's leave it as is.
            // This could be incorrect if both of these happen:
            // - Restart the browser which resets levelOfControl from controlled_by_this_extension to controllable_by_this_extension 
            // - Clear browsing data which also clears extension's storage.local
            return;
        }
        // Revert it back to previous state
        await this._browser.privacy.network.peerConnectionEnabled.set({ value: true });
        await this._browser.storage.local.remove(WebRtcDisabledFlag);
        this.onWebRtcEnabledChanged(true);
    }

    /**
     * Subscribe to changes when WebRTC is enabled or disabled.
     * 
     * @param onChanged callback for when WebRTC is enabled or disabled
     * @returns Unsubscribe function
     */
    subscribeWebRtcStatusChanged(onChanged: (isEnabled: boolean) => void): Unsubscribe {
        this._onWebRtcEnabledChangeListener = onChanged;
        this.getWebRtcEnabled().then(setting => onChanged(!!setting.value));
        return () => {
            if (this._onWebRtcEnabledChangeListener === onChanged) {
                this._onWebRtcEnabledChangeListener = undefined;
            }
        }
    }

    /**
     * Call when WebRTC is enabled or disabled from on change listener to notify downstream subscribers.
     * 
     * @param isEnabled
     */
    onWebRtcEnabledChanged(isEnabled: boolean): void {
        // Let popup know webrtc changed
        if (this._runner === Runner.BACKGROUND) {
            const message: Message = {
                type: 'ON_WEBRTC_ENABLED_CHANGED',
                isEnabled,
            };
            this._browser.runtime.sendMessage(message)
                .catch(err => { /* Expected if popup is closed */ });
        }

        // Let subscribers know 
        this._onWebRtcEnabledChangeListener?.(isEnabled);
    }

    /**
     * Get the number of open requests for a given container.
     * 
     * @param cookieStoreId 
     * @returns Open request count
     */
    getCookieStoreOpenRequestCount(cookieStoreId: string): number {
        return this._cookieStoreIdOpenRequestCount.get(cookieStoreId) || 0;
    }

    /**
     * Subscribe to changes when the number of open requests changes for a given container.
     * 
     * @param cookieStoreId Which cookie store id to listen for
     * @param onChanged Callback for when the number of open requests changes
     * @returns Unsubscribe function
     */
    subscribeCookieStoreOpenRequestCountChanged(cookieStoreId: string, onChanged: (openRequestCount: number) => void): Unsubscribe {
        this._cookieStoreIdToOpenRequestCountChangedListener.set(cookieStoreId, onChanged);
        onChanged(this.getCookieStoreOpenRequestCount(cookieStoreId))
        return () => {
            if (this._cookieStoreIdToOpenRequestCountChangedListener.get(cookieStoreId) === onChanged) {
                this._cookieStoreIdToOpenRequestCountChangedListener.delete(cookieStoreId);
            }
        }
    }

    /**
     * Call when the number of open requests changes for a given container to notify downstream subscribers.
     * 
     * @param cookieStoreId 
     * @param count 
     */
    async onRequestCountChanged(cookieStoreId: string, count: number): Promise<void> {
        // Let popup know request count changed
        if (this._runner === Runner.BACKGROUND) {
            const message: Message = {
                type: 'ON_REQUEST_COUNT_CHANGED',
                cookieStoreId,
                count,
            };
            await this._browser.runtime.sendMessage(message)
                .catch(err => { /* Expected if popup is closed */ });
        }

        // This handles transition from CLOSING to CLOSED by identifying:
        // - There was at least one open request before
        // - There are now no more open requests
        // - Network is locked
        // If these criteria are met, notify subscribers of new status change
        // mainly to trigger color change of container and icon
        if (this._runner === Runner.POPUP) {
            if (count === 0
                && !!this._cookieStoreIdOpenRequestCount.get(cookieStoreId)
                && (await this._cookieStoreIdToIsLocked).get(cookieStoreId) === true) {
                this._setIsLocked(cookieStoreId, QuarantineStatus.CLOSED);
            }
        }

        if (count <= 0) {
            this._cookieStoreIdOpenRequestCount.delete(cookieStoreId);
        } else {
            this._cookieStoreIdOpenRequestCount.set(cookieStoreId, count);
        }

        // Let subscribers know 
        this._cookieStoreIdToOpenRequestCountChangedListener.get(cookieStoreId)?.(count);
    }

    /**
     * Listener for the browser.tabs.onCreated callback.
     * 
     * @param tab 
     * @returns 
     */
    async onTabCreated(tab: browser.tabs.Tab): Promise<void> {
        if (!tab.id || !tab.cookieStoreId) return;

        // Only track if tab is using a container that we own
        if (!(await this._cookieStoreIdToIsLocked).has(tab.cookieStoreId)) {
            return;
        }

        // Populate tab-to-container mapping
        this._tabIdToCookieStoreId.set(tab.id, tab.cookieStoreId);

        // Populate container-to-tabs mapping
        console.log(`${this._runner}: Detected new tab for container id ${tab.cookieStoreId}`);
        var tabIds = this._cookieStoreIdToTabIds.get(tab.cookieStoreId);
        if (!tabIds) {
            tabIds = new Set();
            this._cookieStoreIdToTabIds.set(tab.cookieStoreId, tabIds);
        }
        tabIds.add(tab.id);
    }

    /**
     * Listener for the browser.tabs.onCreated callback.
     * 
     * @param tab 
     * @returns 
     */
    async onTabUpdated(tab: browser.tabs.Tab): Promise<void> {
        if (!tab.id || !tab.windowId) return;

        // Send message to popup process to trigger the same update
        // See _initializeRunner for receiving end.
        if (this._runner === Runner.BACKGROUND) {
            const message: Message = {
                type: 'ON_TAB_UPDATED',
                tabId: tab.id,
                windowId: tab.windowId,
            };
            this._browser.runtime.sendMessage(message)
                .catch(err => { /* Expected if popup is closed */ });
        }
    }

    /**
     * Listener for the browser.tabs.onActivated callback.
     * 
     * @param activeInfo 
     */
    async onTabActivated(activeInfo: browser.tabs._OnActivatedActiveInfo): Promise<void> {
        // Update icon to reflect current tab's quarantine status
        if (this._runner === Runner.BACKGROUND) {
            await this._updateExtensionIcon();
        }

        // Send message to popup process to trigger the same update
        // See _initializeRunner for receiving end.
        if (this._runner === Runner.BACKGROUND) {
            const message: Message = {
                type: 'ON_TAB_ACTIVATED',
                tabId: activeInfo.tabId,
                windowId: activeInfo.windowId,
            };
            this._browser.runtime.sendMessage(message)
                .catch(err => { /* Expected if popup is closed */ });
        }
    }

    /**
     * Listener for the browser.tabs.onRemoved callback.
     * 
     * @param tabId 
     * @returns 
     */
    async onTabClosed(tabId: number): Promise<void> {
        // Check if this tab is our container
        const cookieStoreId = this._tabIdToCookieStoreId.get(tabId)
        if (cookieStoreId === undefined) {
            return;
        }
        this._tabIdToCookieStoreId.delete(tabId)

        // Look up other tabs using this container
        const tabIds = this._cookieStoreIdToTabIds.get(cookieStoreId);
        if (!tabIds) {
            return;
        }
        tabIds.delete(tabId);
        console.log(`${this._runner}: Detected tab closed for container id ${cookieStoreId}`);

        // If there are still tabs using this container, we're done
        if (tabIds.size !== 0) {
            console.debug(`${this._runner}: There are still ${tabIds.size} tabs using container id ${cookieStoreId}`);
            return;
        }
        this._cookieStoreIdToTabIds.delete(cookieStoreId);

        // Make sure the container exists before removing it
        // May happen if you re-open a tab with a container that was previously removed.
        try {
            await browser.contextualIdentities.get(cookieStoreId);
        } catch (err) {
            console.log(`${this._runner}: A closed tab using a container id ${cookieStoreId} which does not exist.`)
            return;
        }

        // Remove container since we're not using it anymore
        console.log(`${this._runner}: Removing container since no open tabs with container id ${cookieStoreId}`);
        await browser.contextualIdentities.remove(cookieStoreId);

        // Check if all our containers are deleted
        if (this._cookieStoreIdToTabIds.size === 0) {
            console.log(`${this._runner}: All containers removed, shutting down`);
            await this._shutdown();
        }
    }

    _initializeRunner(): void {
        // For background process, listen for messages
        if (this._runner === Runner.BACKGROUND) {
            const messageListener = async (message: Message) => {
                // from popup to update quarantine status. See _setIsLocked for sending end.
                if (message.type === 'SET_QUARANTINE_STATUS') {
                    await this._setIsLocked(message.cookieStoreId, message.status);
                    await this._updateExtensionIcon();
                }
                // from popup to start monitoring. See openTabInQuarantine for sending end.
                if (message.type === 'CONTAINER_ABOUT_TO_START') {
                    console.log(`${this._runner}: New container starting, starting up`);
                    await this._startup();
                }
            }
            this._browser.runtime.onMessage.addListener(messageListener);
        }

        // For popup process, listen for messages
        if (this._runner === Runner.POPUP) {
            const messageListener = async (message: Message) => {
                // from background to notify tab activated. See onTabActivated for sending end.
                if (message.type === 'ON_TAB_ACTIVATED') {
                    // External on status changed callback
                    this._onStatusChanged?.();
                }
                if (message.type === 'ON_TAB_UPDATED') {
                    // External on status changed callback
                    this._onStatusChanged?.();
                }
                if (message.type === 'ON_REQUEST_COUNT_CHANGED') {
                    // Request count changed
                    await this.onRequestCountChanged(message.cookieStoreId, message.count);
                }
                if (message.type === 'ON_WEBRTC_ENABLED_CHANGED') {
                    // Webrtc enabled changed
                    this.onWebRtcEnabledChanged(message.isEnabled);
                }
            }
            this._browser.runtime.onMessage.addListener(messageListener);
        }
    }

    /**
     * Called when a tab is activated (switched) or the status of a tab changes. Only called in background process.
     */
    async _updateExtensionIcon(): Promise<void> {
        const activeTabs = await this._browser.tabs.query({ active: true });
        await Promise.all(activeTabs.map(async (tab) => {
            if (!tab.active || !tab.windowId) return;
            const status = await this.checkStatus(tab.cookieStoreId)
            var iconPath = 'public/logo-grey.svg'
            switch (status) {
                case QuarantineStatus.OPEN:
                    iconPath = 'public/logo-yellow.svg'
                    break;
                case QuarantineStatus.CLOSING:
                    iconPath = 'public/logo-red.svg'
                    break;
                case QuarantineStatus.CLOSED:
                    iconPath = 'public/logo-green.svg'
                    break;
                default:
                    break;
            }
            this._browser.browserAction.setIcon({
                path: iconPath,
                windowId: tab.windowId,
            });
        }));
    }

    /**
     * Called when container color needs to be updated.
     */
    async _updateContainerColor(cookieStoreId: string, status: QuarantineStatus): Promise<void> {
        // Update container color based on status
        if (this._runner === Runner.POPUP) {
            var containerColor: string | undefined = undefined;
            switch (status) {
                case QuarantineStatus.OPEN:
                    containerColor = OpenColor;
                    break;
                case QuarantineStatus.CLOSING:
                    containerColor = ClosingColor;
                    break;
                case QuarantineStatus.CLOSED:
                    containerColor = ClosedColor;
                    break;
            }
            if (containerColor) {
                this._browser.contextualIdentities.update(cookieStoreId, {
                    color: containerColor,
                    name: this._getQuaranTabContainerName(status === QuarantineStatus.CLOSED),
                });
            }
        }
    }

    /**
     * Inject a content script into a tab in preparation for cutting off network access.
     */
    async _onNetworkClose(cookieStoreId: string): Promise<void> {
        const handledTabIds = new Set<number>();
        var remainingTabIds: number[] = [];
        do {
            // Record that we have handled these tabs
            remainingTabIds.forEach(tabId => handledTabIds.add(tabId));

            try {
                const tabResults = await Promise.all(remainingTabIds.map(async tabId => {
                    // Remove tab from our list of tabs using this container
                    return await this._browser.scripting.executeScript({
                        target: {
                            tabId,
                            allFrames: true,
                        },
                        files: ['/inject-offline/index.js'],
                        world: 'ISOLATED',
                        injectImmediately: true,
                    });
                }));
                tabResults.forEach(tabResult => tabResult.forEach(frameResult => {
                    if (frameResult.error) {
                        throw new Error(frameResult.error);
                    }
                }));
            } catch (err) {
                console.error(`${this._runner}: Failed to inject or run content script on page`, err);
                throw new Error(`Failed to inject and run script in tab to cut off network access: ${err}`);
            }

            // Find all remaining tabs within our container
            remainingTabIds = (await this._browser.tabs.query({ cookieStoreId }))
                .filter(tab => tab.id !== undefined)
                .map(tab => tab.id as number)
                .filter(tabId => !handledTabIds.has(tabId));

        } while (remainingTabIds.length > 0);
    }            

    async _setIsLocked(cookieStoreId: string, status: QuarantineStatus): Promise<void> {
        // If inside popup, send message to background process to update quarantine status
        // See _initializeRunner for receiving end.
        if (this._runner === Runner.POPUP) {
            const message: Message = {
                type: 'SET_QUARANTINE_STATUS',
                cookieStoreId: cookieStoreId,
                status,
            };
            await this._browser.runtime.sendMessage(message);
        }

        const previousIsLocked = (await this._cookieStoreIdToIsLocked).get(cookieStoreId)
        switch (status) {
            case QuarantineStatus.OPEN:
                (await this._cookieStoreIdToIsLocked).set(cookieStoreId, false);
                break;
            case QuarantineStatus.CLOSING:
            case QuarantineStatus.CLOSED:
                (await this._cookieStoreIdToIsLocked).set(cookieStoreId, true);
                break;
            case QuarantineStatus.NONE:
                (await this._cookieStoreIdToIsLocked).delete(cookieStoreId);
                break;
        }
        const currentIsLocked = (await this._cookieStoreIdToIsLocked).get(cookieStoreId)

        if (this._runner === Runner.BACKGROUND) {
            if (previousIsLocked !== true && currentIsLocked === true) {
                await this._onNetworkClose(cookieStoreId);
            }
        }

        if (this._runner === Runner.POPUP) {
            this._updateContainerColor(cookieStoreId, status);
        }

        // External on status changed callback
        this._onStatusChanged?.();
    }

    async _loadContainerState(): Promise<Map<string, boolean>> {
        // contextualIdentities is undefined if Container extension not installed
        const containers = await this._browser.contextualIdentities?.query({});

        // Find all containers that are owned by this extension.
        var hasActiveContainers: boolean = false;
        const cookieStoreIdsToIsLocked = new Map<string, boolean>();
        for (const container of containers || []) {
            // Only check for containers that are managed by this extension
            const containerStatus = this._getStatusFromContainerName(container.name);
            if (container.cookieStoreId && containerStatus !== QuarantineStatus.NONE) {
                // Check if any tabs have this container open
                const tabsFound = (await this._browser.tabs.query({
                    cookieStoreId: container.cookieStoreId
                }));
                const hasActiveTabs = tabsFound.length > 0;
                if (hasActiveTabs) {
                    hasActiveContainers = true;
                    // Since this container is in active use, keep track of this container
                    cookieStoreIdsToIsLocked.set(
                        container.cookieStoreId,
                        containerStatus === QuarantineStatus.CLOSED);

                } else {
                    // Remove containers that have no active tabs
                    this._browser.contextualIdentities.remove(container.cookieStoreId);
                }
            }
        }
        if (hasActiveContainers) {
            // Need to ensure our listeners are started if we detect we have existing tabs open
            console.log(`${this._runner}: Our containers detected, starting up listeners`);
            await this._startup();
        } else {
            // If we don't have any containers, shutdown to cleanup any leftover
            // state (e.g. WebRTC enable flag) if the browser was not shut down cleanly.
            await this._shutdown();
        }
        return cookieStoreIdsToIsLocked;
    }

    _getQuaranTabContainerName(isLocked: boolean): string {
        return `QuaranTab${isLocked ? ClosedText : OpenText}`;
    }

    _getStatusFromContainerName(name: string): QuarantineStatus {
        if (name === this._getQuaranTabContainerName(false)) {
            return QuarantineStatus.OPEN;
        } else if (name === this._getQuaranTabContainerName(true)) {
            return QuarantineStatus.CLOSED;
        }
        return QuarantineStatus.NONE;
    }
}

var instance: QuaranTab | undefined;

export const getQuaranTabInstance = (runner: Runner, startupListeners?: () => void, shutdownListeners?: () => void): QuaranTab => {
    if (!instance) {
        instance = new QuaranTab(runner, browser, startupListeners, shutdownListeners);
    }
    return instance;
}   
