# Security Policy

## Supported versions

Only the latest release is actively supported.

## Reporting a vulnerability

Please report security issues privately by emailing the maintainer or opening a minimal GitHub security advisory if available.

Do not include sensitive vault content in public issues. If a reproduction requires validation output, reduce it to a minimal synthetic example first.

## Security posture

AnGo Companion is read-only. It reads the active Obsidian file path through Obsidian's vault API, spawns local validation commands, and renders their output in a local view. It does not send vault content to external services and does not create, modify, fix, stage, or commit vault files.

The plugin runs only on desktop because it calls local Python scripts. Users can configure the Python command and vault root in plugin settings.

If **Remember last validation run** is enabled, the latest local validator output is stored in the plugin's Obsidian data so the output pane can restore it after reopening. Disable that setting if validator output may contain sensitive details that should not be persisted locally.
