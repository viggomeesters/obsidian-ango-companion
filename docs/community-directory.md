# Community Directory Submission

AnGo Companion is structured for Obsidian Community plugin submission.

## Submit URL

```text
https://github.com/viggomeesters/obsidian-ango-companion
```

## Owner-only steps

These steps must be completed by the repository owner because they require an Obsidian account, a linked GitHub account, and confirmation of the developer policies/support commitment.

1. Sign in to https://community.obsidian.md.
2. Link the GitHub account that owns this repository.
3. Go to **Plugins -> New plugin**.
4. Enter the repository URL.
5. Confirm the developer policies.
6. Submit for review.
7. Address any automated review feedback.

## Current release target

- Repository: https://github.com/viggomeesters/obsidian-ango-companion
- Manifest version: `0.1.0`
- Required release assets:
  - `main.js`
  - `manifest.json`
  - `styles.css`
- Root metadata:
  - `README.md`
  - `LICENSE`
  - `manifest.json`
  - `versions.json`

## Listing copy

Name:

```text
AnGo Companion
```

Short description:

```text
Run local AnGo vault validation commands from Obsidian and inspect results in a read-only side pane.
```

Long description:

```text
AnGo Companion runs existing local vault validation scripts from inside Obsidian and displays command status, duration, stdout, stderr, and failures in a dedicated side pane. It supports validating the current Markdown note or changed vault files. The plugin is desktop-only because it spawns local Python commands, and it is read-only by design: it does not create, fix, stage, or commit vault files.
```

## Official references

- https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin
- https://github.com/obsidianmd/obsidian-releases
