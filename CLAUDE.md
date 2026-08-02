# nock — CLAUDE.md
## What this is
0% non-custodial Chrome extension overlaying quick buy/sell for Robinhood Chain tokens on terminals, X, Telegram Web. Venue-agnostic: all major RH launchpads + Uniswap behind one VenueAdapter interface. No backend. Open source target. The project token is launched and managed manually outside this repo; no code here touches token issuance.
## Two-Claude protocol
Claude chat = strategist/spec-writer. Claude Code = executor. Specs arrive as pasted prompts. Never freelance beyond the current spec's scope.
## Session protocol
Start: git pull origin main && git log --oneline -3. Close: commit, git push origin HEAD:main, verify with git log origin/main -1, then confirm local == origin/main. Report the commit hash from the remote log, never from memory.
## Model policy
Opus for multi-step/stateful/design work. Sonnet only for isolated mechanical tasks. State the model at session start. No mid-spec switches. Note: the FIRST curve VenueAdapter is Opus design work; each subsequent curve adapter following the established pattern is Sonnet-eligible.
## Non-negotiable security invariants (v1, permanent)
1. Private keys are generated client-side, encrypted at rest (AES-GCM, scrypt KDF), stored only in chrome.storage.local, decrypted only into service-worker memory, auto-lock on timer. Keys never leave the device. Ever.
2. No telemetry containing keys, addresses-with-balances, or transaction contents. Prefer zero telemetry.
3. No remote code, no eval, no remote config, strict MV3 CSP, minimal host permissions (supported sites + RPC endpoints only). The venue factory registry is bundled data, updated only via extension releases.
4. No backend in v1. All reads via public RPC and public APIs directly from the extension.
5. DRY_RUN=true and LIVE_TRADING=false are the defaults everywhere. Any send path checks LIVE_TRADING at the last possible moment. First live test is a single canary <= 0.005 ETH, explicitly approved by Rory in-session.
6. 0% platform fee is a product invariant. No code path may ever append a fee, tip-skim, or spread.
## Spec discipline
Specs >400 LOC or >3 tightly coupled files get split by integration layer, each leaving the system in a verifiable state. Audit-first: read BUILD-PLAN.md, DECISIONS.md, ARCHITECTURE.md, DATA_SOURCES.md before proposing changes. Present proposals, stop, wait for approval.
