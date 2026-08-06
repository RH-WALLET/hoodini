# Chrome Web Store submission

Everything needed for the listing. **Rory submits** — publishing is his call,
not something this project does on his behalf.

## Pre-flight

- [ ] `pnpm test` green, `pnpm typecheck` green
- [ ] `pnpm --filter @hoodini/extension build` clean
- [ ] Confirm `LIVE_TRADING` is **false** in the shipped build unless a live
      release is intended (it is a build-time constant; the default is false)
- [ ] Version bumped in `src/manifest.ts` (currently 0.0.1 — the store rejects a
      re-upload of a version already published)
- [ ] `activeTab` is still declared and still used, or dropped — an unused
      permission is a common rejection reason
- [ ] `docs/index.html` has the real token CA, or still says "not launched"
- [ ] Reviewer note below updated if permissions changed

## Permission justifications

Reviewers reject vague answers. Each of these maps to one capability.

| Permission | Justification |
|---|---|
| `storage` | Stores the password-encrypted wallet vault, the token watchlist that produces the positions panel, and an in-flight trade record that prevents a duplicate send after a browser crash. All local; nothing is transmitted. |
| `https://rpc.mainnet.chain.robinhood.com/*` | The public Robinhood Chain RPC endpoint. Required to read balances and prices and to broadcast transactions the user signs. This is the only network host the extension contacts. |
| Content scripts on `axiom.trade`, `gmgn.ai`, `trade.padre.gg`, `x.com`, `www.x.com`, `web.telegram.org`, `dexscreener.com` | The extension's entire purpose: it finds token contract addresses shown on these pages and draws buy/sell controls beside them. Page content is read locally and never transmitted. The first three are trading terminals the controls attach to; the last four are places a contract address is commonly seen. |
- `https://robinhoodchain.blockscout.com/*` — the public block explorer, read-only.
  Used for two things the chain RPC cannot answer: the ETH price shown beside the
  balance, and the user's own transaction list. The price request carries no address.
  The history request necessarily does, so the extension makes it only when the user
  asks for it and says so on screen. No account, no key and no user data is ever sent.


**Single purpose:** let a user trade Robinhood Chain tokens directly from the
pages where those tokens are discussed, using a wallet held on their own device.

## Remote code

**None.** CSP is `script-src 'self'; object-src 'self'`. There is no `eval`, no
`new Function`, no dynamic `import()`, and no remotely-hosted script. The venue
registry is bundled data updated only by shipping a new version. This is
enforced by tests, not just by policy.

## Data disclosure form

Answer **"No"** to every collection category. Then tick:

- [x] I do not sell or transfer user data to third parties
- [x] I do not use or transfer user data for purposes unrelated to the item's
      single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for
      lending purposes

Privacy policy URL: point at the hosted copy of `PRIVACY.md`.

## Listing copy

**Short description** (132 char max):

> Trade Robinhood Chain tokens straight from X, Telegram and your terminal. 0% fee, keys stay on your device, no account.

**Detailed description:**

> Hoodini puts buy and sell buttons directly on the pages where Robinhood Chain
> tokens are discussed — trading terminals, X, Telegram Web and DexScreener.
>
> • **0% platform fee.** Hoodini takes nothing. You pay the venue's own fee and
>   network gas, exactly as you would trading directly.
> • **Your keys never leave your device.** The wallet is generated locally and
>   encrypted with your password using scrypt and AES-GCM. It is decrypted only
>   in memory and locks itself when idle.
> • **No backend, no account.** There is no server. The extension talks directly
>   to the public Robinhood Chain RPC. Nothing to sign up for, nothing to trust.
> • **Every venue, one button.** Pons, flap.sh, Doppler and Uniswap sit behind a
>   single interface, so a token is tradeable wherever it launched.
> • **Open source.** MIT licensed. Read exactly what it does.
>
> Trading is risky and you can lose everything you put in. Hoodini is
> non-custodial: if you lose your password, nobody can recover your wallet.
>
> Hoodini Finance is not affiliated with, endorsed by, or connected to Robinhood
> Markets, Inc.

## Note for reviewers

> This extension is a non-custodial wallet and trading overlay. Keys are
> generated client-side, encrypted with scrypt + AES-GCM, and stored only in
> chrome.storage.local — they are never transmitted. The extension contacts
> exactly two network hosts, both declared in host_permissions and both public:
> the Robinhood Chain RPC, and the chain's Blockscout explorer for the ETH price
> and the user's own transaction list. Content scripts read page text to find token contract
> addresses and inject controls; page content is never sent anywhere. There is
> no remote code: CSP is script-src 'self' with no unsafe-eval. Source:
> https://github.com/RH-WALLET/hoodini

## Assets still needed

- [ ] Icon 128×128 (plus 48 and 16) — **placeholders exist** (`scripts/make-icons.mjs`); replace with real artwork
- [ ] At least one 1280×800 screenshot
- [x] Hosted privacy policy URL — `https://rh-wallet.github.io/hoodini/privacy.html`
      (paste this into the listing's Privacy policy field; it is linked from the
      landing page footer and pinned against the manifest by test)
