# ui/gate — public artwork

Everything in this directory is served **without authentication**, at
`/gate/<name>`. It exists so the signed-out front door in `src/gate.ts` can load
its own background while the visitor has no Access token. Nothing else belongs
here.

## hero.jpg

The front door looks for `/gate/hero.jpg`. It is optional: if the file is
missing the page falls back to a dark gradient and drops the `<img>`, so the
deploy is never broken by its absence.

Save the artwork here as `hero.jpg`, then redeploy:

    pnpm deploy

Keep it under ~400 KB and at least 1600 px wide. It is rendered full-bleed,
dimmed to 38% and covered by a scrim, so a dark, low-contrast, off-centre image
works best — the sign-in card sits in the middle of the frame.
