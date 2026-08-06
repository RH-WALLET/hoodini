# docs/

The published site, served by GitHub Pages from this folder.

- `index.html` — the landing page. Self-contained: no build step, no external
  requests, no third-party scripts. Edit it and push; Pages serves it as is.
- `.nojekyll` — switches off Jekyll. This is a static page and Jekyll bought
  nothing but a build that could fail, which it did. With this file present
  Pages copies the folder verbatim.
- `dom/` — DOM snapshots captured from the terminals, kept as the evidence the
  site adapters were designed against.
- `CWS-SUBMISSION.md` — the Chrome Web Store listing text and the justification
  for each host permission.
