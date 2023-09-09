export enum Runner {
    BACKGROUND = 'background',
    POPUP = 'popup',
}

type Message = MessageSetQuarantineStatus | MessageOnTabActivated;
type MessageSetQuarantineStatus = {
    type: 'SET_QUARANTINE_STATUS',
    tabId: number,
    windowId: number,
    cookieStoreId: string,
    status: QuarantineStatus,
}
type MessageOnTabActivated = {
    type: 'ON_TAB_ACTIVATED',
    tabId: number,
    windowId: number,
}

export enum QuarantineStatus {
    NONE,
    OPEN,
    CLOSED,
}

export const NoneColor = 'lightgrey';
export const NoneColorRgb = '#D3D3D3';
export const OpenColor = 'red';
export const OpenColorRgb = '#F06F46';
export const ClosedColor = 'green';
export const ClosedColorRgb = '#72C935';

export const OpenText = '';
export const ClosedText = ' - Locked';

export class QuaranTab {
    readonly _runner: Runner;
    readonly _browser: typeof browser;
    /**
     * Tracking which tabs are using which cookie store ids. Only tabs under Containers that we own are tracked.
     */
    readonly _tabIdToCookieStoreId: Map<number, string> = new Map();
    readonly _cookieStoreIdToTabIds: Map<string, Set<number>> = new Map();
    /**
     * List of Containers that are owned by this extension and their corresponding lock state.
     */
    readonly _cookieStoreIdToIsLocked: Promise<Map<string, boolean>>;
    _onStatusChanged: ((tabId: number) => void) | undefined = undefined;

    constructor(runner: Runner, browserInstance: typeof browser) {
        this._runner = runner;
        this._browser = browserInstance;
        this._cookieStoreIdToIsLocked = this._loadContainerState();
        this._initializeRunner();
    }

    /**
     * Set a callback to be called when the status of the current tab changes. Either when the status changes or the tab changes.
     * 
     * @param callback 
     */
    setOnStatusChanged(callback: (tabId: number) => void): void {
        this._onStatusChanged = callback;
    }

    /**
     * Given a cookieStoreId (Container reference), returns the status of that container.
     * 
     * @param cookieStoreId 
     * @returns 
     */
    async checkStatus(cookieStoreId?: string | undefined): Promise<QuarantineStatus> {
        const isLocked = (await this._cookieStoreIdToIsLocked).get(cookieStoreId || '');
        if (isLocked === true) {
            return QuarantineStatus.CLOSED;
        } else if (isLocked === false) {
            return QuarantineStatus.OPEN;
        } else {
            return QuarantineStatus.NONE;
        }
    }

    /**
     * Creates a new temporary container and re-opens current tab within it.
     * 
     * @param currentTab 
     * @returns new opened tab
     */
    async openTabInQuarantine(currentTab: browser.tabs.Tab, lockAfterLoadWithCallback?: (updatedTab: browser.tabs.Tab) => void): Promise<browser.tabs.Tab> {
        if (!currentTab.id || !currentTab.windowId) throw new Error('Cannot access current tab');

        // Create new temporary container just for this tab
        const container = await browser.contextualIdentities.create({
            name: this._getQuaranTabContainerName(false),
            color: OpenColor,
            icon: 'fence',
        });
        if (!container.cookieStoreId) throw new Error('Failed to create container');
        await this._setIsLocked(currentTab.id, currentTab.windowId, container.cookieStoreId, QuarantineStatus.OPEN)

        // Open new tab in our new container
        const newTabPromise = this._browser.tabs.create({
            url: currentTab.url,
            cookieStoreId: container.cookieStoreId,
            active: true,
            openerTabId: currentTab.id,
            index: currentTab.index + 1,
        });

        // Close current tab
        this._browser.tabs.remove(currentTab.id);

        // If requested, lock the container after the tab has finished loading site
        const newTab = await newTabPromise;
        if (!!lockAfterLoadWithCallback) {
            // Listen for tab updates
            const onUpdatedListener = async (tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => {
                // If site within the tab has completed loading, lock the container
                if (changeInfo.status === 'complete' && tabId === newTab.id) {
                    this._browser.tabs.onUpdated.removeListener(onUpdatedListener);
                    console.log(`${this._runner}: Detected site has loaded, triggering lock for container id ${container.cookieStoreId}`)
                    const updatedTab = await this.lockQuarantine(tab);
                    lockAfterLoadWithCallback(updatedTab);
                }
            }
            this._browser.tabs.onUpdated.addListener(onUpdatedListener);
        }

        // Return reference to our new tab
        console.log(`${this._runner}: Re-opened current tab with new container id ${container.cookieStoreId}`);
        return newTab;
    }

    /**
     * Lock a container and all tabs within it. Locking cuts off network access to prevent data exfiltration.
     * 
     * @param currentTab 
     * @returns 
     */
    async lockQuarantine(currentTab: browser.tabs.Tab): Promise<browser.tabs.Tab> {
        if (!currentTab.cookieStoreId || !currentTab.id || !currentTab.windowId) throw new Error('Cannot access current tab');

        // Set to be quarantined
        await this._setIsLocked(currentTab.id, currentTab.windowId, currentTab.cookieStoreId, QuarantineStatus.CLOSED)
        console.log(`${this._runner}: Cutting network access to container id ${currentTab.cookieStoreId}`);

        // Update container color to indicate it's quarantined
        this._browser.contextualIdentities.update(currentTab.cookieStoreId, {
            color: ClosedColor,
            name: this._getQuaranTabContainerName(true),
        });

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

        // Remove container
        // This should delete all data and close all tabs within the container
        await browser.contextualIdentities.remove(cookieStoreId);
        console.log(`${this._runner}: Purged container with container id ${cookieStoreId}`);

        // If Multi-Account Containers extension is not installed,
        // the container will half-delete itself and leave a zombie container.
        // The container is not reachable so all we have to do is close all
        // the tabs using it.
        const tabIds = (await this._browser.tabs
            .query({ cookieStoreId }))
            .reduce<number[]>((ids, tab) => {
                if (tab.id !== undefined) {
                    ids.push(tab.id);
                }
                return ids;
            }, []);
        if (tabIds.length > 0) {
            console.log(`${this._runner}: Closing tabs still open with purged container id ${cookieStoreId}`);
            await this._browser.tabs.remove(tabIds);
        }
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
     * Listener for the browser.tabs.onActivated callback.
     * 
     * @param activeInfo 
     */
    async onTabActivated(activeInfo: browser.tabs._OnActivatedActiveInfo): Promise<void> {
        this._activeTabChanged(activeInfo.tabId, activeInfo.windowId);

        // Send message to popup process to trigger the same update
        // See _initializeRunner for receiving end.
        if (this._runner === Runner.BACKGROUND) {
            const message: MessageOnTabActivated = {
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

        // Double-check that no tabs are using this container via API
        // Just in case our internal tracking is wrong
        const openTabIds = (await this._browser.tabs.query({ cookieStoreId }))
            .map(openTab => openTab.id)
            // The currently closed tab STILL shows up in the query so let's filter it out here
            .filter(openTabId => openTabId !== tabId)
        if (openTabIds.length > 0) {
            console.error(`${this._runner}: Although we detected no tabs using container id ${cookieStoreId}, tabs API returns there are still ${openTabIds.length} tabs using it with ids ${openTabIds}`);
            return;
        }

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
    }

    _initializeRunner(): void {
        // For background process, listen for messages
        if (this._runner === Runner.BACKGROUND) {
            const messageListener = async (message: Message) => {
                // from popup to update quarantine status. See _setIsLocked for sending end.
                if (message.type === 'SET_QUARANTINE_STATUS') {
                    await this._setIsLocked(message.tabId, message.windowId, message.cookieStoreId, message.status);
                    await this._updateExtensionIcon(message.tabId, message.windowId);
                }
            }
            this._browser.runtime.onMessage.addListener(messageListener);
        }

        // For popup process, listen for messages
        if (this._runner === Runner.POPUP) {
            const messageListener = async (message: Message) => {
                // from background to notify tab activated. See onTabActivated for sending end.
                if (message.type === 'ON_TAB_ACTIVATED') {
                    await this._activeTabChanged(message.tabId, message.windowId);
                }
            }
            this._browser.runtime.onMessage.addListener(messageListener);
        }
    }

    async _activeTabChanged(tabId: number, windowId: number): Promise<void> {
        // External on status changed callback
        this._onStatusChanged?.(tabId);

        // Update icon to reflect current tab's quarantine status
        if (this._runner === Runner.BACKGROUND) {
            await this._updateExtensionIcon(tabId, windowId);
        }
    }

    /**
     * Called when a tab is activated (switched) or the status of a tab changes. Only called in background process.
     */
    async _updateExtensionIcon(tabId: number, windowId: number): Promise<void> {
        const currentTab = await this._browser.tabs.get(tabId);
        if (!currentTab?.cookieStoreId) return;

        const status = await this.checkStatus(currentTab.cookieStoreId)
        var iconPath = 'public/logo-grey.svg'
        switch (status) {
            case QuarantineStatus.OPEN:
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
            windowId: windowId,
        });
    }

    async _setIsLocked(tabId: number, windowId: number, cookieStoreId: string, status: QuarantineStatus): Promise<void> {
        switch (status) {
            case QuarantineStatus.OPEN:
                (await this._cookieStoreIdToIsLocked).set(cookieStoreId, false);
                break;
            case QuarantineStatus.CLOSED:
                (await this._cookieStoreIdToIsLocked).set(cookieStoreId, true);
                break;
            case QuarantineStatus.NONE:
                (await this._cookieStoreIdToIsLocked).delete(cookieStoreId);
                break;
        }

        // External on status changed callback
        this._onStatusChanged?.(tabId);

        // If inside popup, send message to background process to update quarantine status
        // See _initializeRunner for receiving end.
        if (this._runner === Runner.POPUP) {
            const message: MessageSetQuarantineStatus = {
                type: 'SET_QUARANTINE_STATUS',
                tabId,
                windowId,
                cookieStoreId: cookieStoreId,
                status,
            };
            this._browser.runtime.sendMessage(message);
        }
    }

    async _loadContainerState(): Promise<Map<string, boolean>> {
        // contextualIdentities is undefined if Container extension not installed
        const containers = await this._browser.contextualIdentities?.query({});

        // Find all containers that are owned by this extension.
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

export const getQuaranTabInstance = (runner: Runner): QuaranTab => {
    if (!instance) {
        instance = new QuaranTab(runner, browser);
    }
    return instance;
}   
