
# QuarantTab
<img src='img/screenshot.png' width=300>

Safely use sensitive data with online tools. Browser extension to cut-off network access to a website to prevent it from phoning home. This allows you to input sensitive data into a website without worrying about it being stolen.

## Use cases

Do use this to convert/parse sensitive data:

- Parse a live JWT token in https://jwt.io
- Decode a Base64 Authorization header
- Hash a password for /etc/shadow
- Parse a Protobuf message

## Bad use cases

Do **not** use this extension to **generate** sensitive data:

- Generate a strong password online
- Generate a Bitcoin wallet online
- Generate a PGP key online

A malicious website may show you pre-generated data which may seem random to you, but is actually known to the attacker even before you load the website. Cutting off network access will not prevent this situation.

## Where to get it

I would recommend to review the code, build the extension yourself and install it manually.

If you simply install the extension from the Firefox Add-ons store, you are implicitly trusting me that the extension does what it says it does.

You were warned: [Get it from the Firefox Add-ons store](https://addons.mozilla.org/firefox/addon/quarantab/)

## How to use

### Quarantine

Open any website you wish to use with sensitive data. Click the extension icon to quarantine the website. This will cut-off network access to the website. The website will still be able to run JavaScript, but it will not be able to make any network requests.

<img src='img/screenshot-quarantine.png' width=500>

### Lock

If you kept `Auto-lock` enabled, this step is only briefly shown while the page loads. When the page is completely loaded, the extension will automatically lock the website, cutting off the network access.

<img src='img/screenshot-lock.png' width=500>

### Use

At this point, the website is completely locked down. You can now safely use the website and input sensitive data. No data will leak out of the website.

If a website stops working, it probably means that it depends on additional resources that it cannot fetch anymore because network access is cut-off.

Some tools actually work by sending your data to a server for processing, so they will not work with this extension by design.

<img src='img/screenshot-use.png' width=500>

### Purge

When you are done using the site, click the extension icon and click the purge button to delete all website data.

<img src='img/screenshot-purge.png' width=500>

## How it works

This extension takes advantage of Mozilla Firefox's [contextualIdentities API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities) to create temporary Containers in order to:
- Isolate a website from the rest of the browser
- Cut-off network access to just this Container
- Easily delete all data when you are done using the website

Interesting part is that the API semi-functions even without the [Multi-Account Containers extension](https://github.com/mozilla/multi-account-containers) installed with a caveat:
- When calling `browser.contextualIdentities.remove`, the Container is removed, but open tabs continue to be open and seem to be using a zombie-leftover of this container. The container cannot be referenced, but the site continues to operates as if it exists. This is a bug in Firefox. To solve this, I explicitly close all remaining tabs in that Container.

Attacks this extension protects against:
- Network access: Container is routed to a non-existent Socks proxy pointing to 127.0.0.1
- DNS leaks by routing DNS requests via Socks: site could try to resolve my-sensitive-info.badsite.com
- Storing sensitive data in Storage and Cookies
- Communicating with other websites

Out of scope attacks:
- Malicious other extensions communicating with the website
- Socks proxy running on localhost allowing communication with the website
- Container exploits
- Pre-generated data (e.g. using a Bitcoin Wallet Generator that shows you one of 100 pre-generated wallets)

Potential implementation in Chromium (Would love feedback here):
- Use private window as a temporary container

## Permissions

- "proxy" - Required to cut-off network access to the website
- "tabs" - Required to re-open a tab in a new container
- "cookies" - Required for manipulating Container data
- "contextualIdentities" - Required for creating/deleting Containers
- "<all_urls>" - Required to use with any website

## Bug bounty

If you find a bug, please report it to me. A bug bounty is available for this project as long as it meets the following criteria:

1. The bug shows an exploit to exfiltrate data out of a website that is under a locked-down quarantine.
2. You are the first person to report the bug.
3. There are funds available in the bug bounty.
4. The amount is proportional to the severity of the bug at our discretion.
5. For an exploit that leaks any data under all circumstances, the bounty would be 100 USD.
6. The bug exists in this extension or the design of it. It excludes explots in the browser itself, the contextualIdentities implementation or isolation guarantees.

### Bug bounty remaining pool

100 USD

_the amount will grow in the future proportionally to my confidence_

### Bug bounty history

No exploits yet.

## Building

```sh
# Install packages
npm install

# Live Dev
npm run start firefox

# Build
npm run build firefox
```
