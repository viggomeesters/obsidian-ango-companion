import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const vaultRoot = process.env.OBSIDIAN_VAULT_ROOT?.trim();
if (!vaultRoot) {
  console.error("Set OBSIDIAN_VAULT_ROOT to the target Obsidian vault root.");
  process.exit(1);
}

const pluginDir = path.join(vaultRoot, ".obsidian/plugins/ango-companion");
const releaseFiles = ["main.js", "manifest.json", "styles.css"];

await mkdir(pluginDir, { recursive: true });

for (const fileName of releaseFiles) {
  await copyFile(fileName, path.join(pluginDir, fileName));
}

console.log(`Installed AnGo Companion to ${pluginDir}`);
