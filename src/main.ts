import {
  App,
  ItemView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const VIEW_TYPE_ANGO_VALIDATOR = "ango-validator-output";
const VAULT_ROOT_PLACEHOLDER = "/path/to/ango-vault";
const ANGO_CONTEXT_PATH = "system/context/ango.md";
const SCHEMA_PATH = "system/contracts/life-os-schema.yaml";
const VALIDATOR_SCRIPT = "system/scripts/vault/validate_vault.py";
const WORKFLOW_VALIDATOR_SCRIPT = "system/scripts/vault/validate_vault_workflow.py";

interface AnGoSettings {
  pythonCommand: string;
  vaultRoot: string;
}

const DEFAULT_SETTINGS: AnGoSettings = {
  pythonCommand: "python3",
  vaultRoot: "",
};

interface CommandResult {
  label: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

interface ValidationRun {
  title: string;
  target: string;
  startedAt: string;
  finishedAt: string;
  vaultRoot: string;
  commands: CommandResult[];
}

export default class AnGoCompanionPlugin extends Plugin {
  settings: AnGoSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_ANGO_VALIDATOR,
      (leaf) => new AnGoValidatorView(leaf),
    );

    this.addSettingTab(new AnGoSettingTab(this.app, this));

    this.addCommand({
      id: "validate-current-note",
      name: "Validate current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isMarkdownFile(file)) return false;
        if (!checking) {
          void this.validateCurrentNote(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "validate-changed-files",
      name: "Validate changed files",
      callback: () => {
        void this.validateChangedFiles();
      },
    });

    this.addCommand({
      id: "open-ango-context",
      name: "Open AnGo context",
      callback: () => {
        void this.openVaultFile(ANGO_CONTEXT_PATH);
      },
    });

    this.addCommand({
      id: "open-schema",
      name: "Open schema",
      callback: () => {
        void this.openVaultFile(SCHEMA_PATH);
      },
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async validateCurrentNote(file: TFile): Promise<void> {
    await this.runValidation("Validate current note", file.path, [file.path]);
  }

  private async validateChangedFiles(): Promise<void> {
    await this.runValidation("Validate changed files", "changed files", ["--changed"]);
  }

  private async runValidation(
    title: string,
    target: string,
    validatorArgs: string[],
  ): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice("AnGo Validator runs only on desktop because it calls local Python scripts.");
      return;
    }

    const vaultRoot = this.getVaultRoot();
    if (!vaultRoot) {
      const run = createConfigurationErrorRun(
        title,
        target,
        "Vault root unavailable",
        "Set Vault root override to the absolute path of the vault that contains the AnGo validation scripts.",
        this.settings.pythonCommand,
      );
      await this.showRun(run);
      new Notice("AnGo validation could not run: vault root unavailable.");
      return;
    }

    const missingScripts = [VALIDATOR_SCRIPT, WORKFLOW_VALIDATOR_SCRIPT].filter(
      (scriptPath) => !existsSync(path.join(vaultRoot, scriptPath)),
    );

    if (missingScripts.length > 0) {
      const run = createSkippedRun(title, target, vaultRoot, missingScripts, this.settings.pythonCommand);
      await this.showRun(run);
      new Notice("AnGo validation could not run: missing script.");
      return;
    }

    const startedAt = new Date().toISOString();
    const commands = [
      await runCommand(this.settings.pythonCommand, [VALIDATOR_SCRIPT, ...validatorArgs], vaultRoot, "Vault validation"),
      await runCommand(
        this.settings.pythonCommand,
        [WORKFLOW_VALIDATOR_SCRIPT, ...validatorArgs],
        vaultRoot,
        "Workflow validation",
      ),
    ];

    const run: ValidationRun = {
      title,
      target,
      startedAt,
      finishedAt: new Date().toISOString(),
      vaultRoot,
      commands,
    };

    await this.showRun(run);

    const ok = commands.every((command) => command.exitCode === 0 && !command.error);
    new Notice(ok ? "AnGo validation passed." : "AnGo validation failed. See output pane.");
  }

  private getVaultRoot(): string | null {
    const configuredRoot = this.settings.vaultRoot.trim();
    if (configuredRoot) return configuredRoot;

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return adapter.getBasePath?.() ?? null;
  }

  private async showRun(run: ValidationRun): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_ANGO_VALIDATOR,
      active: true,
    });

    if (leaf.view instanceof AnGoValidatorView) {
      leaf.view.setRun(run);
    }
  }

  private async openVaultFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(`AnGo file not found: ${filePath}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }
}

class AnGoValidatorView extends ItemView {
  private run: ValidationRun | null = null;

  getViewType(): string {
    return VIEW_TYPE_ANGO_VALIDATOR;
  }

  getDisplayText(): string {
    return "AnGo Validator";
  }

  getIcon(): string {
    return "shield-check";
  }

  setRun(run: ValidationRun): void {
    this.run = run;
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ango-validator");

    const header = container.createDiv({ cls: "ango-validator__header" });
    header.createDiv({ cls: "ango-validator__title", text: "AnGo Validator" });

    if (!this.run) {
      container.createDiv({
        cls: "ango-validator__empty",
        text: "Run an AnGo validation command to see output here.",
      });
      return;
    }

    const ok = this.run.commands.every((command) => command.exitCode === 0 && !command.error);
    header.createDiv({
      cls: `ango-validator__badge ${ok ? "ango-validator__badge--ok" : "ango-validator__badge--fail"}`,
      text: ok ? "Passed" : "Failed",
    });

    const meta = container.createDiv({ cls: "ango-validator__meta" });
    meta.createDiv({ text: this.run.title });
    meta.createDiv({ text: `Target: ${this.run.target}` });
    meta.createDiv({ text: `Vault: ${this.run.vaultRoot}` });
    meta.createDiv({ text: `Finished: ${this.run.finishedAt}` });

    this.run.commands.forEach((command) => renderCommandResult(container, command));
  }
}

class AnGoSettingTab extends PluginSettingTab {
  private readonly plugin: AnGoCompanionPlugin;

  constructor(app: App, plugin: AnGoCompanionPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AnGo Companion" });

    new Setting(containerEl)
      .setName("Python command")
      .setDesc("Executable used for AnGo validators. Use a full path if Obsidian cannot find python3.")
      .addText((text) =>
        text
          .setPlaceholder("python3")
          .setValue(this.plugin.settings.pythonCommand)
          .onChange(async (value) => {
            this.plugin.settings.pythonCommand = value.trim() || "python3";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault root override")
      .setDesc("Leave empty to use the current Obsidian vault path. Set an absolute path when validating a different AnGo vault.")
      .addText((text) =>
        text
          .setPlaceholder(VAULT_ROOT_PLACEHOLDER)
          .setValue(this.plugin.settings.vaultRoot)
          .onChange(async (value) => {
            this.plugin.settings.vaultRoot = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}

function isMarkdownFile(file: TFile | null): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<CommandResult> {
  const started = performance.now();

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        label,
        executable,
        args,
        exitCode: null,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        label,
        executable,
        args,
        exitCode,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

function createSkippedRun(
  title: string,
  target: string,
  vaultRoot: string,
  missingScripts: string[],
  executable: string,
): ValidationRun {
  const now = new Date().toISOString();
  return {
    title,
    target,
    startedAt: now,
    finishedAt: now,
    vaultRoot,
    commands: missingScripts.map((scriptPath) => ({
      label: "Missing script",
      executable,
      args: [scriptPath],
      exitCode: null,
      stdout: "",
      stderr: `Missing script: ${path.join(vaultRoot, scriptPath)}`,
      durationMs: 0,
      error: "Script not found",
    })),
  };
}

function createConfigurationErrorRun(
  title: string,
  target: string,
  error: string,
  details: string,
  executable: string,
): ValidationRun {
  const now = new Date().toISOString();
  return {
    title,
    target,
    startedAt: now,
    finishedAt: now,
    vaultRoot: "(not configured)",
    commands: [
      {
        label: "Configuration",
        executable,
        args: [],
        exitCode: null,
        stdout: "",
        stderr: details,
        durationMs: 0,
        error,
      },
    ],
  };
}

function renderCommandResult(parent: HTMLElement, command: CommandResult): void {
  const section = parent.createEl("details", {
    cls: "ango-validator__command",
  });
  section.open = command.exitCode !== 0 || Boolean(command.error);

  const summary = section.createEl("summary", { cls: "ango-validator__command-summary" });
  const success = command.exitCode === 0 && !command.error;
  summary.createSpan({
    cls: `ango-validator__status ${success ? "ango-validator__status--ok" : "ango-validator__status--fail"}`,
    text: success ? "OK" : "ERR",
  });
  summary.createSpan({ cls: "ango-validator__command-label", text: command.label });
  summary.createSpan({
    cls: "ango-validator__command-code",
    text: `${command.executable} ${command.args.join(" ")}`,
  });
  summary.createSpan({
    cls: "ango-validator__duration",
    text: `${command.durationMs} ms`,
  });

  if (command.error) {
    section.createDiv({ cls: "ango-validator__error", text: command.error });
  }

  renderOutputBlock(section, "stdout", command.stdout);
  renderOutputBlock(section, "stderr", command.stderr);
}

function renderOutputBlock(parent: HTMLElement, label: string, output: string): void {
  const block = parent.createDiv({ cls: "ango-validator__output-block" });
  block.createDiv({ cls: "ango-validator__output-label", text: label });
  block.createEl("pre", {
    cls: "ango-validator__output",
    text: output.trim() || "(empty)",
  });
}
