# Security

Hoodini holds private keys. This document says what it defends against, what it
does not, and how to report a problem.

## Reporting a vulnerability

Please do **not** open a public issue for anything that could put funds at risk.
Report privately to the maintainers and allow time for a fix before disclosure.

## Threat model

### Defended

| Threat | Defence |
|---|---|
| A hostile page reads or uses the wallet | Content scripts are untrusted. They can request a **quote** and nothing else; unlock, export, spend and holdings are refused at the message router, with a second backstop list that holds even if the policy table is edited wrongly. |
| Stolen browser profile | The vault is AES-256-GCM under a scrypt-derived key (N=2^17, r=8, p=1). Offline guessing is memory-hard. |
| Tampered vault | GCM is authenticated and the vault header is bound as AAD, so an edited address or version fails to decrypt rather than opening under another identity. |
| Key left in memory | The key is reachable only inside `withKey`, never returned. Idle auto-lock, plus MV3 worker teardown, drop it. |
| Remote code injection | Strict CSP: `script-src 'self'`, no `unsafe-eval`, no `unsafe-inline`, no remote origins. No dynamic `import()`, no `eval`. |
| Silent fee skimming | The 0% fee is enforced structurally: fee-taking router functions are omitted from our ABIs, so calling one is a compile error. A test scans built calldata for any address that is not the router, the token, WETH or a sentinel. |
| Accidental live trading | `LIVE_TRADING` is a **build-time** constant, default false. A released build cannot be talked into broadcasting. The check sits immediately before `sendRawTransaction`. |
| Double-spend after a crash | An in-flight trade is journalled *before* broadcast. An unresolved entry blocks further trading and is **never** auto-resent. |
| Malicious registry swap | The venue registry is bundled and shipped in the extension. There is no remote config. |
| Address spoofing on a page | Scraped addresses are EIP-55 validated and resolved on-chain before use. A mixed-case address with a bad checksum is discarded. |

### Not defended

- **A compromised device.** A keylogger or malware with local code execution
  defeats any browser-extension wallet, including this one.
- **A malicious extension with broad permissions** installed alongside Hoodini.
- **A weak password.** scrypt raises the cost of guessing; it does not fix
  `password1`.
- **Loss of the password.** There is no recovery. That is what non-custodial
  means.
- **Venue risk.** Launchpads here are upgradeable, admin-controlled, or both.
  flap's Portal implementation changed during development. Hoodini routes trades;
  it cannot make a venue honest.
- **MEV and sandwiching.** Slippage limits bound the loss; they do not prevent
  the attack.
- **Phishing.** Hoodini will never ask for your private key outside the popup's
  explicit export flow, which always re-requests your password.

## Design rules that exist for security reasons

1. `@hoodini/core` exports no broadcast path. Signing and sending exist only in
   the service worker, which is where the gate is. A test enforces this.
2. Only addresses verified on-chain (`DATA_SOURCES.md`) may be used to build a
   transaction.
3. Approvals are for the exact amount, never unlimited.
4. Every contract interface is read from deployed verified source, not from an
   ABI listing — twice during development an ABI advertised functions whose
   bodies were `revert FeatureDisabled()`.

## Not affiliated with Robinhood

Hoodini Finance is an independent project. It is **not** affiliated with,
endorsed by, or connected to Robinhood Markets, Inc. It trades on Robinhood
Chain, a public blockchain.
