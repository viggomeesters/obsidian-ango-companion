# Contributing

Thanks for considering a contribution.

## Development setup

```bash
npm install
npm run build
npm run typecheck
npm run install:vault
```

For manual testing, build the plugin and install the release assets into an Obsidian vault:

```text
.obsidian/plugins/ango-companion/
```

Reload Obsidian and enable **AnGo Companion** in **Settings -> Community plugins**.

## Design constraints

- Keep the plugin read-only.
- Do not create, modify, fix, stage, or commit vault files.
- Keep spawned validation commands explicit and visible in the output pane.
- Avoid runtime dependencies unless they are clearly needed.
- Prefer Obsidian-native DOM APIs and small, focused changes.
- Keep vault-specific defaults configurable where possible.

## Pull requests

Please include:

- what changed
- why it changed
- screenshots for visible UI changes
- validation output for `npm run build` and `npm run typecheck`
