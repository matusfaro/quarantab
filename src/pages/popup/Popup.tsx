import React, { useEffect, useState } from "react";

import { ClosedColorRgb, NoneColorRgb, OpenColorRgb, QuarantineStatus, Runner, getQuaranTabInstance } from "@src/lib/quarantab";
import LogoRed from '@assets/img/logo-red.svg';
import LogoGreen from '@assets/img/logo-green.svg';
import LogoGrey from '@assets/img/logo-grey.svg';
import { Alert, Box, Checkbox, Collapse, FormControlLabel, Step, StepLabel, Stepper, ThemeProvider, Tooltip, Typography } from "@mui/material";
import { LoadingButton } from "@mui/lab";
import { Info } from "@mui/icons-material";

export default function Popup(): JSX.Element {

  const [loading, setLoading] = useState<boolean>(true);
  var [errorMsg, setErrorMsg] = useState<string>();
  const [lockAfterLoad, setLockAfterLoad] = useState<boolean>(true);
  const [currentTab, setCurrentTab] = useState<browser.tabs.Tab>();
  const [status, setStatus] = useState<QuarantineStatus>();

  useEffect(() => {
    if (!currentTab) {
      const refreshCurrentWindow = () => {
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
      refreshCurrentWindow();
      getQuaranTabInstance(Runner.POPUP).setOnStatusChanged(() => refreshCurrentWindow());
    }
    else {
      getQuaranTabInstance(Runner.POPUP)
        .checkStatus(currentTab.cookieStoreId)
        .then((newStatus) => {
          setStatus(newStatus);
          setLoading(false);
        }).catch(err => {
          setErrorMsg(`${err}`);
        });
    }
  }, [currentTab]);

  const eligibleForQuarantine = (tab: browser.tabs.Tab | undefined): string | true | undefined => {
    if (!tab
      || !tab.id
      || !tab.cookieStoreId) {
      return undefined;
    }
    if (tab.pinned) {
      return 'Cannot quarantine pinned tabs';
    }
    if (!tab.url?.match(/^https?:\/\//)) {
      return 'Unsupported URL scheme';
    }
    return true;
  }
  const eligibility = eligibleForQuarantine(currentTab);

  var Logo = LogoGrey
  var showLockAfterLoad = false;
  var bigButtonAction;
  var bigButtonTitle;
  var bigButtonColor: 'success' | 'error' | 'info' = 'info';
  var color: string = NoneColorRgb;
  if (eligibility !== true) {
    bigButtonTitle = 'Quarantine';
    errorMsg = errorMsg || eligibility;
  }
  // Tab is not quarantined
  // Show button to put current tab in quarantine
  else if (status === QuarantineStatus.NONE && currentTab) {
    showLockAfterLoad = true;
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
    bigButtonTitle = 'Lock';
    bigButtonColor = 'error';
    Logo = LogoRed;
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
    bigButtonTitle = 'Purge';
    color = ClosedColorRgb;
    bigButtonColor = 'success';
    Logo = LogoGreen;
    bigButtonAction = async () => {
      try {
        setLoading(true);
        await getQuaranTabInstance(Runner.POPUP).purgeQurantine(currentTab.cookieStoreId)
        window.close();
      } catch (err) {
        setErrorMsg(`${err}`);
      }
    };
  }
  // Loading state
  else {
    bigButtonTitle = 'Quarantine';
  }

  return (
    <ThemeProvider theme={{}}>
      <Box
        minHeight={250}
        width={400}
        display='flex'
        flexDirection='column'
      >
        <Box display='flex' justifyContent='center' alignItems='flex-end' sx={{ m: 4, marginBottom: 0 }}>
          <img src={Logo} width={48} height={48} />
          <Typography variant='h4' component='h1' sx={{ marginLeft: 4 }}>
            QuaranTab
          </Typography>
        </Box>

        <Box textAlign='center' sx={{ m: 2, marginBottom: 0 }} >
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
          <br />
          <Collapse in={showLockAfterLoad} appear>
            <Box display='flex' justifyContent='center'>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={lockAfterLoad}
                    onClick={() => setLockAfterLoad(!lockAfterLoad)}
                  />
                )}
                label='Auto-lock'
              />
              <Tooltip disableInteractive arrow title={(<Typography>
                Lock after page fully loads.
              </Typography>)}>
                <Info fontSize='small' />
              </Tooltip>
            </Box>
          </Collapse>
        </Box>

        <Box flexGrow={1} />

        <Collapse in={!!errorMsg}>
          <Alert color='error' variant='outlined' sx={{ m: 2, marginTop: 0 }} >
            <Typography>
              {errorMsg}
            </Typography>
          </Alert>
        </Collapse>

        <Collapse in={!errorMsg}>
          <Stepper activeStep={status || 0} sx={{ m: 2, marginTop: 0 }} >
            <Step completed={QuarantineStatus.NONE < (status || 0)}>
              <Tooltip disableInteractive arrow title={(<Typography>
                Quarantine will re-open this page in a fresh new temporary container isolated from all other tabs.
              </Typography>)}>
                <StepLabel>Quarantine</StepLabel>
              </Tooltip>
            </Step>
            <Step completed={QuarantineStatus.OPEN < (status || 0)}>
              <Tooltip disableInteractive arrow title={(<Typography>
                Locking will cut-off internet access to this container to prevent any site from phoning home.
              </Typography>)}>
                <StepLabel color='error'>Lock</StepLabel>
              </Tooltip>
            </Step>
            <Step completed={QuarantineStatus.CLOSED < (status || 0)}>
              <Tooltip disableInteractive arrow title={(<Typography>
                Purge will delete this container and delete all data associated with it.
              </Typography>)}>
                <StepLabel color='success'>Purge</StepLabel>
              </Tooltip>
            </Step>
          </Stepper>
        </Collapse>
      </Box>
    </ThemeProvider >
  );
}
