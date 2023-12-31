import React, { useEffect, useState } from "react";

import { ClosingColorRgb, OpenColorRgb, QuarantineStatus, Runner, getQuaranTabInstance } from "@src/lib/quarantab";
import LogoYellow from '@assets/img/logo-yellow.svg';
import LogoRed from '@assets/img/logo-red.svg';
import LogoGreen from '@assets/img/logo-green.svg';
import LogoGrey from '@assets/img/logo-grey.svg';
import { Alert, Box, Button, Checkbox, Chip, Collapse, CssBaseline, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, Stack, Theme, ThemeProvider, Tooltip, Typography, createMuiTheme } from "@mui/material";
import { LoadingButton } from "@mui/lab";
import Grid from '@mui/material/Unstable_Grid2';
import Groups from "./icons/Group";
import SafetyDivider from "./icons/SafetyDivider";
import Wifi from "./icons/Wifi";
import WifiOff from "./icons/WifiOff";
import GitHub from "./icons/GitHub";
import TooltipIcon from "./TooltipIcon";
import { createTheme } from '@mui/material/styles'
import Refresh from "./icons/Refresh";
import OpenInNew from "./icons/OpenInNew";
import InfoOutlined from "./InfoOutlined";
import Close from "./icons/Close";
import WebSocket from "./icons/WebSocket";
import WebRTC from "./icons/WebRTC";
import Dns from "./icons/Dns";

const theme: Theme = createTheme({
  palette: {
    warning: { main: OpenColorRgb },
    error: { main: ClosingColorRgb },
  },
  typography: {
    fontFamily: '"Gill Sans", sans-serif',
  },
  components: {
    MuiGrid2: {
      defaultProps: {
        disableEqualOverflow: true,
      }
    },
    MuiButton: {
      defaultProps: {
        size: 'large',
        color: 'inherit',
      }
    },
  },
});

export default function Popup(): JSX.Element {

  const [loading, setLoading] = useState<boolean>(true);
  var [errorMsg, setErrorMsg] = useState<string>();
  const [currentTab, setCurrentTab] = useState<browser.tabs.Tab>();
  const [status, setStatus] = useState<QuarantineStatus>();
  const [reopening, setReopening] = useState<boolean>();
  const [helpOpen, setHelpOpen] = useState<boolean>(false);

  useEffect(() => {
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
    const unsubscribe = getQuaranTabInstance(Runner.POPUP).subscribeOnStatusChanged(() => refreshCurrentWindow());
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!!currentTab) {
      getQuaranTabInstance(Runner.POPUP)
        .checkStatus(currentTab.cookieStoreId)
        .then((newStatus) => {
          setStatus(newStatus);
        }).catch(err => {
          setErrorMsg(`${err}`);
        });
    }
  }, [currentTab]);

  const [openRequestCount, setOpenRequestCount] = useState<number>(0);
  useEffect(() => {
    if (status === undefined || !currentTab?.cookieStoreId) {
      return; // still loading
    }

    // Subscribe ot open request counting
    const unsubscribe = getQuaranTabInstance(Runner.POPUP).subscribeCookieStoreOpenRequestCountChanged(
      currentTab.cookieStoreId,
      count => setOpenRequestCount(count));
    setOpenRequestCount(getQuaranTabInstance(Runner.POPUP).getCookieStoreOpenRequestCount(currentTab.cookieStoreId))
    setLoading(false);

    return () => {
      unsubscribe();
      setOpenRequestCount(0);
    };
  }, [currentTab?.cookieStoreId, status === undefined]);

  const [webRtcEnabled, setWebRtcEnabled] = useState<boolean>();
  useEffect(() => {
    const unsubscribe = getQuaranTabInstance(Runner.POPUP).subscribeWebRtcStatusChanged(
      isEnabled => setWebRtcEnabled(isEnabled));
    return () => unsubscribe();
  }, []);

  const [shouldBlockWebsocketOnOpen, setShouldBlockWebsocketOnOpen] = useState<boolean>();
  useEffect(() => {
    getQuaranTabInstance(Runner.POPUP).shouldBlockWebsocketOnOpen()
      .then((shouldBlock) => {
        setShouldBlockWebsocketOnOpen(shouldBlock);
      });
  }, []);

  const eligibleForQuarantine = (tab: browser.tabs.Tab | undefined): string | true | undefined => {
    if (!tab
      || !tab.id
      || !tab.cookieStoreId) {
      return undefined;
    }
    if (!tab.url?.match(/^https?:\/\//)) {
      return undefined;
    }
    if (tab.pinned) {
      return 'Cannot quarantine pinned tabs';
    }
    return true;
  }
  const currentTabEligible = eligibleForQuarantine(currentTab);

  const onClickQuarantine = async (reopen: boolean) => {
    try {
      setLoading(true);
      setReopening(reopen);
      const updatedTab = await getQuaranTabInstance(Runner.POPUP).openTabInQuarantine(
        reopen ? currentTab : undefined,
        reopen ? (updatedUpdatedTabPromise) => updatedUpdatedTabPromise
          .then((updatedUpdatedTab) => {
            setLoading(false);
            setCurrentTab(updatedUpdatedTab);
          }).catch(err => {
            setErrorMsg(`Failed to lock: ${err}`);
          })
          : undefined);
        setCurrentTab(updatedTab);
    } catch (err) {
      setErrorMsg(`Failed to quarantine: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  const onClickLock = async () => {
    try {
      if (!currentTab) throw new Error('Cannot find current tab');
      setLoading(true);
      const updatedTab = await getQuaranTabInstance(Runner.POPUP).lockQuarantine(currentTab);
      setCurrentTab(updatedTab);
    } catch (err) {
      setErrorMsg(`${err}`);
    } finally {
      setLoading(false);
    }
  }

  const onClickClose = async () => {
    try {
      if (!currentTab) throw new Error('Cannot find current tab');
      setLoading(true);
      await getQuaranTabInstance(Runner.POPUP).purgeQurantine(currentTab.cookieStoreId);
      setLoading(false);
    } catch (err) {
      setLoading(false);
      setErrorMsg(`${err}`);
    }
  }

  var Logo = LogoGrey
  if (status === QuarantineStatus.OPEN) {
    Logo = LogoYellow;
  } else if (status === QuarantineStatus.CLOSING) {
    Logo = LogoRed;
  } else if (status === QuarantineStatus.CLOSED) {
    Logo = LogoGreen;
  }

  return (
    <ThemeProvider theme={theme}>
      <Box
        width={400}
      >
        <CssBaseline />

        {/* Header */}
        <Grid container spacing={2}>
          {/* Logo and title */}
          <Grid xs={8} xsOffset={2} display='flex' justifyContent='center' alignItems='center'
            padding={5} paddingBottom={3}>
            <img src={Logo} width={48} height={48} />
            <Typography variant='h5' component='h1' sx={{ marginLeft: 2 }}>
              QuaranTab
            </Typography>
          </Grid>
          {/* Menu */}
          <Grid xs={2} display='flex' alignItems='flex-start' justifyContent='flex-end'>
            <IconButton onClick={() => setHelpOpen(true)}>
              <InfoOutlined />
            </IconButton>
            <Tooltip disableInteractive arrow title={(<Typography>
              View source code for this extension
            </Typography>)}>
              <IconButton href='https://github.com/matusfaro/quarantab' rel='noopener nofollow'>
                <GitHub />
              </IconButton>
            </Tooltip>
          </Grid>
        </Grid>

        {/* Current state information */}
        <Grid container spacing={2}>

          {/* Container isolation */}
          <Grid xs={6} xsOffset={1} display='flex' direction='row' alignItems='center'>
            <Typography>Container isolation</Typography>
            <TooltipIcon title="Opening a website in a container prevents it from communicating with other websites in your browser." />
          </Grid>
          <Grid xs={5} display='flex' alignItems='center' justifyContent='center'>
            {loading ? (
              <Chip label='NONE' color='default' sx={{ width: 120 }} icon={(<Groups />)} />
            ) : (status === undefined || status === QuarantineStatus.NONE ? (
              <Chip label='NONE' color='warning' sx={{ width: 120 }} icon={(<Groups />)} />
            ) : (
              <Chip label="ACTIVE" color="success" sx={{ width: 120 }} icon={(<SafetyDivider />)} />
            ))}
          </Grid>

          {/* WebRTC */}
          <Grid xs={6} xsOffset={1} display='flex' direction='row' alignItems='center'>
            <Typography>WebRTC API</Typography>
            <TooltipIcon title='WebRTC is used for communicating with other P2P clients. While you are using a container, the WebRTC API is blocked for the entire browser. This is because a per-tab blocking is not possible from within an Addon.' />
          </Grid>
          <Grid xs={5} display='flex' alignItems='center' justifyContent='center'>
            <Chip
              label={webRtcEnabled === undefined ? ("Unknown") : (!!webRtcEnabled ? ("ENABLED") : ("DISABLED"))}
              color={(status === undefined || status === QuarantineStatus.NONE || webRtcEnabled === undefined)
                ? 'default' : (!!webRtcEnabled
                  ? 'warning'
                  : 'success')}
              icon={(<WebRTC />)}
              sx={{ width: 120 }}
            />
          </Grid>

          {/* Websockets */}
          <Grid xs={6} xsOffset={1} display='flex' direction='row' alignItems='center'>
            <Typography>WebSocket API</Typography>
            <TooltipIcon title='WebSockets are used for two-way communication over a persistent connection with a server. We intercept proxy on-request to block new connections and a content script to terminate existing connections.' />
          </Grid>
          <Grid xs={5} display='flex' alignItems='center' justifyContent='center'>
            <Chip
              label={(status === undefined || status === QuarantineStatus.NONE || (status === QuarantineStatus.OPEN && !shouldBlockWebsocketOnOpen))
                ? 'ONLINE'
                : 'OFFLINE'}
              color={(status === undefined || status === QuarantineStatus.NONE)
                ? 'default' : (((status === QuarantineStatus.OPEN && !shouldBlockWebsocketOnOpen))
                  ? 'warning'
                  : ('success'))}
              icon={(<WebSocket />)}
              sx={{ width: 120 }}
            />
          </Grid>

          {/* HTTP traffic */}
          <Grid xs={6} xsOffset={1} display='flex' direction='row' alignItems='center'>
            <Typography>HTTP Network access</Typography>
            <TooltipIcon title='HTTP traffic is the primary protocol for accessing websites. We route all HTTP requests through a non-existent Socks proxy to effectively disable HTTP traffic.' />
          </Grid>
          <Grid xs={5} display='flex' alignItems='center' justifyContent='center'>
            <Chip
              label={status === QuarantineStatus.CLOSED ?
                'OFFLINE' : (openRequestCount > 0
                  ? `${openRequestCount} OPEN`
                  : 'ONLINE')}
              color={(status === undefined || status === QuarantineStatus.NONE)
                ? 'default' : ((status === QuarantineStatus.CLOSED)
                  ? 'success' : (status === QuarantineStatus.CLOSING
                    ? 'error'
                    : ('warning')))}
              icon={(status === QuarantineStatus.CLOSED || status === QuarantineStatus.CLOSING)
                ? (<WifiOff />)
                : (<Wifi />)}
              sx={{ width: 120 }}
            />
          </Grid>

          {/* DNS traffic */}
          <Grid xs={6} xsOffset={1} display='flex' direction='row' alignItems='center'>
            <Typography>DNS access</Typography>
            <TooltipIcon title='DNS is used for mapping hostnames into IP addresses. We route all DNS queries through a non-existent Socks proxy to effectivelly disable DNS.' />
          </Grid>
          <Grid xs={5} display='flex' alignItems='center' justifyContent='center'>
            <Chip
              label={(status !== QuarantineStatus.CLOSED && status !== QuarantineStatus.CLOSING)
                ? 'ONLINE'
                : 'OFFLINE'}
              color={(status === undefined || status === QuarantineStatus.NONE)
                ? 'default' : ((status !== QuarantineStatus.CLOSED && status !== QuarantineStatus.CLOSING)
                  ? 'warning'
                  : 'success')}
              icon={(<Dns />)}
              sx={{ width: 120 }}
            />
          </Grid>
        </Grid>

        {/* Actionable buttons for current state */}
        <Collapse in={status === QuarantineStatus.NONE}>
          <Grid container margin={theme.spacing(1)} spacing={2}>
            <Grid xs={6} display='flex' alignItems='center' justifyContent='center'>
              <LoadingButton
                startIcon={<Refresh />}
                variant='text'
                disabled={loading || !currentTabEligible}
                onClick={() => onClickQuarantine(true)}
                loading={loading}
                sx={{ m: 1, minWidth: 160 }}
              >
                This tab
              </LoadingButton>
            </Grid>
            <Grid xs={6} display='flex' alignItems='center' justifyContent='center'>
              <LoadingButton
                startIcon={<OpenInNew />}
                disabled={loading}
                onClick={() => onClickQuarantine(false)}
                loading={loading}
                sx={{ m: 1, minWidth: 160 }}
              >
                New tab
              </LoadingButton>
            </Grid>
          </Grid>
        </Collapse>
        <Collapse in={status === QuarantineStatus.OPEN}>
          <Grid container margin={theme.spacing(1)} spacing={2}>
            <Grid xs={12} display='flex' alignItems='center' justifyContent='center'>
              <LoadingButton
                startIcon={<WifiOff />}
                disabled={loading || reopening || !currentTabEligible}
                onClick={() => onClickLock()}
                loading={loading || reopening}
                sx={{ m: 1, minWidth: 160 }}
              >
                Block network
              </LoadingButton>
            </Grid>
          </Grid>
        </Collapse>
        <Collapse in={status === QuarantineStatus.CLOSING || status === QuarantineStatus.CLOSED}>
          <Grid container margin={theme.spacing(1)} spacing={2}>
            <Grid xs={12} display='flex' alignItems='center' justifyContent='center'>
              <LoadingButton
                startIcon={<Close />}
                disabled={loading}
                onClick={() => onClickClose()}
                loading={loading || status === QuarantineStatus.CLOSING}
                sx={{ m: 1, minWidth: 160 }}
              >
                Close container
              </LoadingButton>
            </Grid>
          </Grid>
        </Collapse>

        <Box flexGrow={1} />

        {/* Show error message if present */}
        <Collapse in={!!errorMsg}>
          <Box margin={theme.spacing(1)}>
            <Alert severity='error' sx={{ m: 2 }} >
            <Typography>
              {errorMsg}
            </Typography>
          </Alert>
          </Box>
        </Collapse>

        {/* State information text */}
        <Collapse in={status === QuarantineStatus.OPEN}>
          <Box margin={theme.spacing(1)}>
            <Alert severity='warning' sx={{ m: 2 }}>
              <Typography>
                {reopening
                  ? 'Network will be automatically blocked once website fully loads.'
                  : 'Once you open your website, block its network access.'}
              </Typography>
            </Alert>
          </Box>
        </Collapse>
        <Collapse in={status === QuarantineStatus.CLOSING}>
          <Box margin={theme.spacing(1)}>
            <Alert severity='error' sx={{ m: 2 }} >
              <Typography>
                There are still {openRequestCount} connections open. Please wait for them to finish or timeout.
              </Typography>
            </Alert>
          </Box>
        </Collapse>
        <Collapse in={status === QuarantineStatus.CLOSED}>
          <Box margin={theme.spacing(1)}>
            <Alert severity='success' sx={{ m: 2 }} >
              <Typography>
                Site is successfully quarantined and will not be able to leak any sensitive information.
              </Typography>
            </Alert>
          </Box>
        </Collapse>
      </Box>

      {/* Help dialog */}
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        fullScreen
      >
        <DialogTitle id="scroll-dialog-title">Safely use sensitive data with online tools.</DialogTitle>
        <DialogContent dividers>
          <DialogContentText>
            <Typography variant='caption'></Typography>
            <p>QuaranTab extension quarantines a website and prevents it from communicating with other websites in your browser and the internet.</p>
            <p>This makes it safe for you to use a website offline with sensitive information</p>
            <p>Some example use cases are:</p>
            <ul>
              <li>Parse a live JWT token</li>
              <li>Decode a Base64 Authorization header</li>
              <li>Hash a password</li>
              <li>Parse a Protobuf message</li>
            </ul>
            <p>Do NOT use this extension for generating sensitive information such as:</p>
            <ul>
              <li>Generating a password</li>
              <li>Generating a Bitcoin wallet</li>
              <li>Generating a PGP key online</li>
            </ul>
            <p>A website may present you with a seemingly random value which may have been pre-generated.</p>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHelpOpen(false)}>Close</Button>
        </DialogActions>

      </Dialog>
    </ThemeProvider>
  );
}
