import React, { useEffect, useState } from "react";

import { ClosedColor, NoneColor, OpenColor, QuarantineStatus, Runner, getQuaranTabInstance } from "@src/lib/quarantab";

export default function Popup(): JSX.Element {

  const [errorMsg, setErrorMsg] = useState<string>();
  const [lockAfterLoad, setLockAfterLoad] = useState<boolean>(true);
  const [currentTab, setCurrentTab] = useState<browser.tabs.Tab>();
  const [status, setStatus] = useState<QuarantineStatus>();

  const loadCurrentTab = async () => {
    console.log('Loading current tab');
    try {
    } catch (err) {
      setErrorMsg(`${err}`);
    }
  };
  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        const newCurrentTab = tabs[0];
        if (!newCurrentTab) {
          setErrorMsg(`Cannot detect tab`);
        }
        setCurrentTab(newCurrentTab);
      }).catch(err => {
        setErrorMsg(`${err}`);
      });
  }, []);

  useEffect(() => {
    if (!!currentTab) {
      try {
        getQuaranTabInstance(Runner.POPUP)
          .checkStatus(currentTab.cookieStoreId)
          .then((newStatus) => {
            setStatus(newStatus);
          }).catch(err => {
            setErrorMsg(`${err}`);
          });
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    }
  }, [currentTab]);

  var bigButtonAction, bigButtonTitle, bigButtonColor = NoneColor;
  // Tab is not quarantined
  // Show button to put current tab in quarantine
  // TODO detect tabs that cannot be quarantined like the browser settings page
  if (status === QuarantineStatus.NONE && currentTab) {
    bigButtonTitle = 'Quarantine tab';
    bigButtonAction = async () => {
      try {
        const updatedTab = await getQuaranTabInstance(Runner.POPUP).openTabInQuarantine(
          currentTab,
          lockAfterLoad ? (updatedUpdatedTab) => setCurrentTab(updatedUpdatedTab) : undefined);
        setCurrentTab(updatedTab);
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Tab is in quarantined but not locked
  // Show button to lock tabs
  else if (status === QuarantineStatus.OPEN && currentTab) {
    bigButtonTitle = 'Lock tab';
    bigButtonColor = OpenColor;
    bigButtonAction = async () => {
      try {
        const updatedTab = await getQuaranTabInstance(Runner.POPUP).lockQuarantine(currentTab);
        setCurrentTab(updatedTab);
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Tab is quarantined AND locked
  // Show button to purge site and container
  else if (status === QuarantineStatus.CLOSED && currentTab) {
    bigButtonTitle = 'Purge tab';
    bigButtonColor = ClosedColor;
    bigButtonAction = () => {
      try {
        getQuaranTabInstance(Runner.POPUP).purgeQurantine(currentTab)
        loadCurrentTab();
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Loading state
  else {
    bigButtonTitle = 'Loading...';
  }

  // TODO check for this._browser.contextualIdentities and show message Containres extension is not installed
  // TODO check for all permissions and show message that permissions are missing
  return (
    <div className="absolute top-0 left-0 right-0 bottom-0 text-center h-full p-3 bg-gray-800">
      <header className="flex flex-col items-center justify-center text-white">
        <p>Popup styled with TailwindCSS!</p>
      </header>
      <button
        disabled={!bigButtonAction}
        onClick={bigButtonAction}
      >
        {bigButtonTitle}
      </button>
      <div style={{ display: 'flex' }}>
        <input
          color={bigButtonColor}
          type='checkbox'
          checked={lockAfterLoad}
          onClick={() => setLockAfterLoad(!lockAfterLoad)}
        />
        Auto-lock after page load
      </div>
      {errorMsg}
    </div>
  );
}
