# Privacy Policy

**Hoodini Finance** — last updated 2026-08-03.

## The short version

Hoodini collects nothing. There is no server to collect it with.

## What is stored, and where

Everything stays in your browser's local extension storage on your device:

| Data | Purpose | Leaves your device? |
|---|---|---|
| Encrypted wallet vault | Holds your key, encrypted with your password | **No** |
| Wallet address | Shown in the popup while locked | **No** |
| Token watchlist | Builds the positions panel | **No** |
| In-flight trade record | Prevents a double-send after a browser crash | **No** |

Your private key is encrypted with a key derived from your password and is
decrypted only into the extension's service-worker memory, never written back
in plaintext.

## What is sent, and to whom

Only blockchain reads and, if you trade, signed transactions — sent directly
from your browser to the public Robinhood Chain RPC endpoint
(`rpc.mainnet.chain.robinhood.com`). This is the same request any wallet makes.
Hoodini operates no server and no proxy.

The extension's declared permissions are the enforceable version of this claim:
it may reach that one RPC host, and read the pages you have granted it.

## What is NOT collected

No analytics. No telemetry. No crash reporting. No advertising identifiers. No
cookies. No account, email, or sign-up. No browsing history. No IP logging by us
— we have nothing to log with.

## Page access

Content scripts run only on the sites named in the manifest, each listed
explicitly. They read the page to find token addresses and draw buttons. Page
content is never transmitted anywhere.

## Your control

- Export your key at any time from the popup.
- Reset the wallet to erase the vault from storage.
- Uninstalling removes all stored data.

Because Hoodini is non-custodial and has no server, there is no account to
delete and no data of yours for us to hold.

## Contact

Open an issue on the project repository.
