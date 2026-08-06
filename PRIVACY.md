# Privacy Policy

**Hoodini Finance** — last updated 2026-08-07.

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

Hoodini operates no server and no proxy, so nothing is ever sent to us. There is
no "us" to send it to. Your browser talks to two public hosts directly, and to
nothing else:

**1. The Robinhood Chain RPC** (`rpc.mainnet.chain.robinhood.com`) — blockchain
reads, and, if you trade, signed transactions. The same requests any wallet
makes.

**2. The chain's Blockscout explorer** (`robinhoodchain.blockscout.com`) — two
requests, and they are not equally private, so they are not treated as such:

| Request | Carries your address? | When |
|---|---|---|
| The ETH price, shown beside your balance | **No** — a global figure about the chain | Whenever the popup is open |
| Your own transaction list | **Yes** — it cannot be fetched without naming the address | Only when you open Activity |

The second one is a real disclosure and is named here rather than buried: it
tells the explorer which wallet is being looked at. No key is involved and
nothing of ours is sent, but a third party learns something, so the extension
asks for it only when you go looking for it and says so on screen. If you never
open Activity, your address is never sent anywhere but the RPC — which sees it
anyway the moment you trade, as it would with any wallet.

The extension's declared permissions are the enforceable version of this claim:
those two hosts, and the pages you have granted it. There is no third.

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
