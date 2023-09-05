export enum Runner {
    BACKGROUND,
    POPUP,
}

type Message = MessageSetQuarantineStatus;
type MessageSetQuarantineStatus = {
    type: 'SET_QUARANTINE_STATUS',
    cookieStoreId: string,
    status: QuarantineStatus,
}

export enum QuarantineStatus {
    NONE,
    OPEN,
    CLOSED,
}

export const NoneColor = 'lightgrey';
export const OpenColor = 'red';
export const ClosedColor = 'green';

export const OpenText = 'OPEN';
export const ClosedText = 'LOCKED';

export class QuaranTab {
    readonly _runner: Runner;
    readonly _browser: typeof browser;
    /**
     * List of Containers that are owned by this extension and their corresponding lock state.
     */
    readonly _cookieStoreIdsToIsLocked: Promise<Map<string, boolean>>;

    constructor(runner: Runner, browserInstance: typeof browser) {
        this._runner = runner;
        this._browser = browserInstance;
        this._cookieStoreIdsToIsLocked = this._loadContainerState();
        this._initializeRunner();
    }

    _initializeRunner(): void {
        if (this._runner === Runner.BACKGROUND) {
            const messageListener = (message: Message) => {
                if (message.type === 'SET_QUARANTINE_STATUS') {
                    this._setIsLocked(message.cookieStoreId, message.status);
                }
            }
            this._browser.runtime.onMessage.addListener(messageListener);
        }
    }

    async _setIsLocked(cookieStoreId: string, status: QuarantineStatus): Promise<void> {
        switch (status) {
            case QuarantineStatus.OPEN:
                (await this._cookieStoreIdsToIsLocked).set(cookieStoreId, false);
                break;
            case QuarantineStatus.CLOSED:
                (await this._cookieStoreIdsToIsLocked).set(cookieStoreId, true);
                break;
            case QuarantineStatus.NONE:
                (await this._cookieStoreIdsToIsLocked).delete(cookieStoreId);
                break;
        }
        if (this._runner === Runner.POPUP) {
            const message: MessageSetQuarantineStatus = {
                type: 'SET_QUARANTINE_STATUS',
                cookieStoreId: cookieStoreId,
                status: status,
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

    async checkStatus(cookieStoreId?: string | undefined): Promise<QuarantineStatus> {
        const isLocked = (await this._cookieStoreIdsToIsLocked).get(cookieStoreId || '');
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
        if (!currentTab.id) throw new Error('Cannot access current tab');

        // Create new temporary container just for this tab
        const container = await browser.contextualIdentities.create({
            name: this._getQuaranTabContainerName(false),
            color: OpenColor,
            icon: 'fence',
        });
        if (!container.cookieStoreId) throw new Error('Failed to create container');
        this._setIsLocked(container.cookieStoreId, QuarantineStatus.OPEN)

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
                    const updatedTab = await this.lockQuarantine(tab);
                    lockAfterLoadWithCallback(updatedTab);
                }
            }
            this._browser.tabs.onUpdated.addListener(onUpdatedListener);
        }

        // Return reference to our new tab
        return newTab;
    }

    async lockQuarantine(currentTab: browser.tabs.Tab): Promise<browser.tabs.Tab> {
        if (!currentTab.cookieStoreId || !currentTab.id) throw new Error('Cannot access current tab');

        // Set to be quarantined
        this._setIsLocked(currentTab.cookieStoreId, QuarantineStatus.CLOSED)

        // TODO Inject script to test network connectivity

        // Update container color to indicate it's quarantined
        this._browser.contextualIdentities.update(currentTab.cookieStoreId, {
            color: ClosedColor,
            name: this._getQuaranTabContainerName(true),
        });

        return this._browser.tabs.get(currentTab.id);
    }

    async purgeQurantine(currentTab: browser.tabs.Tab): Promise<void> {
        if (!currentTab.cookieStoreId) throw new Error('Cannot access current tab');

        await browser.contextualIdentities.remove(currentTab.cookieStoreId);

        this._setIsLocked(currentTab.cookieStoreId, QuarantineStatus.NONE)
    }

    _getQuaranTabContainerName(isLocked: boolean): string {
        return `QuaranTab ${isLocked ? ClosedText : OpenText}`;
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
