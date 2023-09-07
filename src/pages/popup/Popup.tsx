import React, { useEffect, useState } from "react";

import { ClosedColor, ClosedColorRgb, NoneColor, NoneColorRgb, OpenColor, OpenColorRgb, QuarantineStatus, Runner, getQuaranTabInstance } from "@src/lib/quarantab";
import Logo from '@assets/img/logo.svg';
import { Alert, Box, Button, Checkbox, Collapse, FormControlLabel, Grid, IconButton, SvgIcon, ThemeProvider, Tooltip, Typography } from "@mui/material";
import { LoadingButton } from "@mui/lab";

export default function Popup(): JSX.Element {

  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string>();
  const [lockAfterLoad, setLockAfterLoad] = useState<boolean>(true);
  const [currentTab, setCurrentTab] = useState<browser.tabs.Tab>();
  const [status, setStatus] = useState<QuarantineStatus>();

  useEffect(() => {
    if (!currentTab) {
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
    }
  }, [currentTab]);

  useEffect(() => {
    if (!!currentTab) {
      try {
        getQuaranTabInstance(Runner.POPUP)
          .checkStatus(currentTab.cookieStoreId)
          .then((newStatus) => {
            setStatus(newStatus);
            setLoading(false);
          }).catch(err => {
            setErrorMsg(`${err}`);
          });
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    }
  }, [currentTab]);

  var info;
  var showLockAfterLoad = false;
  var bigButtonTooltip;
  var bigButtonAction;
  var bigButtonTitle;
  var bigButtonColor: 'success' | 'error' | 'info' = 'info';
  var color: string = NoneColorRgb;
  // Tab is not quarantined
  // Show button to put current tab in quarantine
  // TODO detect tabs that cannot be quarantined like the browser settings page
  if (status === QuarantineStatus.NONE && currentTab) {
    info = 'This site is not managed by this extension.';
    showLockAfterLoad = true;
    bigButtonTooltip = 'Quarantine will re-open this page in a fresh new temporary container isolated from all other tabs.';
    bigButtonTitle = 'Quarantine';
    bigButtonAction = async () => {
      try {
        setLoading(true);
        const updatedTab = await getQuaranTabInstance(Runner.POPUP).openTabInQuarantine(
          currentTab,
          lockAfterLoad ? (updatedUpdatedTab) => {
            setLoading(true);
            setCurrentTab(updatedUpdatedTab);
          } : undefined);
        setCurrentTab(updatedTab);
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Tab is in quarantined but not locked
  // Show button to lock tabs
  else if (status === QuarantineStatus.OPEN && currentTab) {
    info = 'This site is quarantined in its own Container, but continues to have access to internet in order to load all of its assets.';
    bigButtonTooltip = 'Locking will cut-off internet access to this container to prevent any site from phoning home.';
    bigButtonTitle = 'Lock';
    bigButtonColor = 'error';
    color = OpenColorRgb;
    bigButtonAction = async () => {
      try {
        setLoading(true);
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
    info = 'This site has no internet access. Any sensitive information will not leave your computer.';
    bigButtonTooltip = 'Purge will delete this container and delete all data associated with it.';
    bigButtonTitle = 'Purge';
    color = ClosedColorRgb;
    bigButtonColor = 'success';
    bigButtonAction = async () => {
      try {
        setLoading(true);
        await getQuaranTabInstance(Runner.POPUP).purgeQurantine(currentTab)
        window.close();
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Loading state
  else {
    bigButtonTitle = '';
  }

  // TODO check for this._browser.contextualIdentities and show message Containres extension is not installed
  // TODO check for all permissions and show message that permissions are missing
  return (
    <ThemeProvider theme={{}}>
      <Box
        minHeight={330}
        width={400}
        display='flex'
        flexDirection='column'
      >
        <Box display='flex' justifyContent='center' sx={{ m: 4 }}>
          <img src={Logo} width={32} height={32} />
          <Typography variant='h4' component='h1' sx={{ marginLeft: 4 }}>
            QuaranTab
          </Typography>
        </Box>

        <Box textAlign='center' sx={{ m: 2, marginBottom: 0 }} >
          <Tooltip title={(<Typography>{bigButtonTooltip}</Typography>)} arrow>
            <LoadingButton
              variant='contained'
              size='large'
              color={bigButtonColor}
              disabled={!bigButtonAction || loading}
              onClick={bigButtonAction}
              loading={loading}
              sx={{ m: 1, minWidth: 150 }}
            >
              {bigButtonTitle}
            </LoadingButton>
          </Tooltip>
          <br />
          <Collapse in={showLockAfterLoad} appear>
            <Tooltip title={(<Typography>Waits for the page to load and automatically locks the container cutting off its network access.</Typography>)} arrow>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={lockAfterLoad}
                    onClick={() => setLockAfterLoad(!lockAfterLoad)}
                  />
                )}
                label="Auto lock"
              />
            </Tooltip>
          </Collapse>
        </Box>

        <Box flexGrow={1} />

        <Collapse in={!!errorMsg}>
          <Alert color='error' variant='filled' sx={{ m: 2 }} >
            <Typography>
              {errorMsg}
            </Typography>
          </Alert>
        </Collapse>

        <Collapse in={!!info}>
          <Alert
            variant='standard'
            color={bigButtonColor}
            icon={false}
            sx={{ m: 2 }}
          >
            <Typography>
              {info}
            </Typography>
          </Alert>
        </Collapse>
      </Box>
    </ThemeProvider >
  );
}
