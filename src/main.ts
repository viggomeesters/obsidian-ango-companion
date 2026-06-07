import {
  App,
  ItemView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  normalizePath,
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
const VALIDATE_ON_SAVE_DELAY_MS = 900;
const HISTORY_LIMIT = 10;

interface AnGoSettings {
  persistLastRun: boolean;
  pythonCommand: string;
  validateOnSave: boolean;
  vaultRoot: string;
}

const DEFAULT_SETTINGS: AnGoSettings = {
  persistLastRun: true,
  pythonCommand: "python3",
  validateOnSave: false,
  vaultRoot: "",
};

interface AnGoPluginData extends Partial<AnGoSettings> {
  lastRun?: ValidationRun | null;
}

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
  private history: ValidationRun[] = [];
  private isRunningValidation = false;
  private lastRun: ValidationRun | null = null;
  private saveTimers = new Map<string, number>();
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_ANGO_VALIDATOR,
      (leaf) => new AnGoValidatorView(leaf, this),
    );

    this.addSettingTab(new AnGoSettingTab(this.app, this));
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("Idle");

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.scheduleValidateOnSave(file);
        }
      }),
    );

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
      id: "validate-note-with-context",
      name: "Validate current note and AnGo context",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isMarkdownFile(file)) return false;
        if (!checking) {
          void this.validateNoteWithContext(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "validate-current-folder",
      name: "Validate current folder",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          void this.validateCurrentFolder(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "validate-vault",
      name: "Validate vault",
      callback: () => {
        void this.validateVault();
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
    const data = (await this.loadData()) as AnGoPluginData | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.lastRun = data?.lastRun ?? null;
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
  }

  getLastRun(): ValidationRun | null {
    return this.lastRun;
  }

  getHistory(): ValidationRun[] {
    return this.history;
  }

  private async validateCurrentNote(file: TFile): Promise<void> {
    await this.runValidation("Validate current note", file.path, [file.path]);
  }

  private async validateChangedFiles(): Promise<void> {
    await this.runValidation("Validate changed files", "changed files", ["--changed"]);
  }

  private async validateNoteWithContext(file: TFile): Promise<void> {
    await this.runValidationGroup(
      "Validate current note and AnGo context",
      `${file.path} + ${ANGO_CONTEXT_PATH}`,
      [
        { args: [file.path], labelSuffix: "current note" },
        { args: [ANGO_CONTEXT_PATH], labelSuffix: "AnGo context" },
      ],
    );
  }

  private async validateCurrentFolder(file: TFile): Promise<void> {
    await this.runValidation("Validate current folder", file.parent?.path || "/", [file.parent?.path || "."]);
  }

  private async validateVault(): Promise<void> {
    await this.runValidation("Validate vault", "vault", ["--all"]);
  }

  private scheduleValidateOnSave(file: TFile): void {
    if (!this.settings.validateOnSave || !isMarkdownFile(file)) return;

    const existingTimer = this.saveTimers.get(file.path);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      this.saveTimers.delete(file.path);
      if (this.isRunningValidation) return;
      void this.runValidation("Validate saved note", file.path, [file.path]);
    }, VALIDATE_ON_SAVE_DELAY_MS);
    this.saveTimers.set(file.path, timer);
  }

  private async runValidation(
    title: string,
    target: string,
    validatorArgs: string[],
  ): Promise<void> {
    await this.runValidationGroup(title, target, [{ args: validatorArgs }]);
  }

  private async runValidationGroup(
    title: string,
    target: string,
    validationTargets: { args: string[]; labelSuffix?: string }[],
  ): Promise<void> {
    if (!Platform.isDesktop) {
      new Notice("AnGo Validator runs only on desktop because it calls local Python scripts.");
      return;
    }

    if (this.isRunningValidation) {
      new Notice("AnGo validation is already running.");
      return;
    }

    this.isRunningValidation = true;
    this.updateStatusBar("Running");

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
      this.isRunningValidation = false;
      this.updateStatusBar("Failed");
      return;
    }

    const missingScripts = [VALIDATOR_SCRIPT, WORKFLOW_VALIDATOR_SCRIPT].filter(
      (scriptPath) => !existsSync(path.join(vaultRoot, scriptPath)),
    );

    if (missingScripts.length > 0) {
      const run = createSkippedRun(title, target, vaultRoot, missingScripts, this.settings.pythonCommand);
      await this.showRun(run);
      new Notice("AnGo validation could not run: missing script.");
      this.isRunningValidation = false;
      this.updateStatusBar("Failed");
      return;
    }

    const startedAt = new Date().toISOString();
    const commands: CommandResult[] = [];
    for (const validationTarget of validationTargets) {
      const suffix = validationTarget.labelSuffix ? ` (${validationTarget.labelSuffix})` : "";
      commands.push(
        await runCommand(
          this.settings.pythonCommand,
          [VALIDATOR_SCRIPT, ...validationTarget.args],
          vaultRoot,
          `Vault validation${suffix}`,
        ),
      );
      commands.push(
        await runCommand(
          this.settings.pythonCommand,
          [WORKFLOW_VALIDATOR_SCRIPT, ...validationTarget.args],
          vaultRoot,
          `Workflow validation${suffix}`,
        ),
      );
    }

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
    this.isRunningValidation = false;
    this.updateStatusBar(ok ? "Passed" : "Failed");
    new Notice(ok ? "AnGo validation passed." : "AnGo validation failed. See output pane.");
  }

  private getVaultRoot(): string | null {
    const configuredRoot = this.settings.vaultRoot.trim();
    if (configuredRoot) return configuredRoot;

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    return adapter.getBasePath?.() ?? null;
  }

  private async showRun(run: ValidationRun): Promise<void> {
    this.lastRun = run;
    this.history = [run, ...this.history.filter((entry) => entry.startedAt !== run.startedAt)].slice(0, HISTORY_LIMIT);
    await this.savePluginData();

    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_ANGO_VALIDATOR,
      active: true,
    });

    if (leaf.view instanceof AnGoValidatorView) {
      leaf.view.setRun(run);
    }
  }

  async openVaultFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      new Notice(`AnGo file not found: ${filePath}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  resolveVaultFile(filePath: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile ? file : null;
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      ...this.settings,
      lastRun: this.settings.persistLastRun ? this.lastRun : null,
    });
  }

  private updateStatusBar(status: "Failed" | "Idle" | "Passed" | "Running"): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.setText(`AnGo: ${status}`);
    this.statusBarEl.toggleClass("ango-status--failed", status === "Failed");
    this.statusBarEl.toggleClass("ango-status--passed", status === "Passed");
    this.statusBarEl.toggleClass("ango-status--running", status === "Running");
  }
}

class AnGoValidatorView extends ItemView {
  private run: ValidationRun | null = null;
  private readonly plugin: AnGoCompanionPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: AnGoCompanionPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

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
    this.run = this.run ?? this.plugin.getLastRun();
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

    const diagnostics = analyzeRun(this.run);
    const ok = diagnostics.failedCommands.length === 0;
    header.createDiv({
      cls: `ango-validator__badge ${ok ? "ango-validator__badge--ok" : "ango-validator__badge--fail"}`,
      text: ok ? "Passed" : "Failed",
    });

    renderRunSummary(container, diagnostics);

    const meta = container.createDiv({ cls: "ango-validator__meta" });
    meta.createDiv({ text: this.run.title });
    meta.createDiv({ text: `Target: ${this.run.target}` });
    meta.createDiv({ text: `Vault: ${this.run.vaultRoot}` });
    meta.createDiv({ text: `Finished: ${this.run.finishedAt}` });

    this.run.commands.forEach((command) => renderCommandResult(container, command, this.run?.vaultRoot ?? "", this.plugin));
    renderHistory(container, this.plugin.getHistory(), this.run);
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

    new Setting(containerEl)
      .setName("Validate on save")
      .setDesc("Automatically validate saved Markdown notes after a short debounce. Disabled by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.validateOnSave)
          .onChange(async (value) => {
            this.plugin.settings.validateOnSave = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Remember last validation run")
      .setDesc("Store the last local validator output in this plugin's Obsidian data so the pane can restore it after reopening.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.persistLastRun)
          .onChange(async (value) => {
            this.plugin.settings.persistLastRun = value;
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

interface CommandDiagnostics {
  errors: string[];
  warnings: string[];
  paths: string[];
}

interface RunDiagnostics {
  errorCount: number;
  failedCommands: CommandResult[];
  commandDiagnostics: Map<CommandResult, CommandDiagnostics>;
  warningCount: number;
}

function renderRunSummary(parent: HTMLElement, diagnostics: RunDiagnostics): void {
  const summary = parent.createDiv({ cls: "ango-validator__summary" });
  renderSummaryItem(summary, "Errors", String(diagnostics.errorCount), diagnostics.errorCount > 0 ? "fail" : "ok");
  renderSummaryItem(summary, "Warnings", String(diagnostics.warningCount), diagnostics.warningCount > 0 ? "warn" : "ok");
  renderSummaryItem(summary, "Failed validators", String(diagnostics.failedCommands.length), diagnostics.failedCommands.length > 0 ? "fail" : "ok");

  if (diagnostics.failedCommands.length > 0) {
    const failed = parent.createDiv({ cls: "ango-validator__failed" });
    failed.createDiv({ cls: "ango-validator__section-title", text: "Failed validators" });
    diagnostics.failedCommands.forEach((command) => {
      failed.createDiv({
        cls: "ango-validator__finding ango-validator__finding--error",
        text: `${command.label}: ${command.error ?? `exit ${command.exitCode ?? "unknown"}`}`,
      });
    });
  }
}

function renderSummaryItem(parent: HTMLElement, label: string, value: string, tone: "fail" | "ok" | "warn"): void {
  const item = parent.createDiv({ cls: `ango-validator__summary-item ango-validator__summary-item--${tone}` });
  item.createDiv({ cls: "ango-validator__summary-value", text: value });
  item.createDiv({ cls: "ango-validator__summary-label", text: label });
}

function renderCommandResult(
  parent: HTMLElement,
  command: CommandResult,
  vaultRoot: string,
  plugin: AnGoCompanionPlugin,
): void {
  const section = parent.createEl("details", {
    cls: "ango-validator__command",
  });
  section.open = command.exitCode !== 0 || Boolean(command.error);
  const diagnostics = analyzeCommand(command, vaultRoot);

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

  const actions = section.createDiv({ cls: "ango-validator__actions" });
  renderCopyButton(actions, "Copy command", `${command.executable} ${command.args.join(" ")}`);
  renderCopyButton(actions, "Copy stdout", command.stdout);
  renderCopyButton(actions, "Copy stderr", command.stderr);

  if (command.error) {
    section.createDiv({ cls: "ango-validator__error", text: command.error });
  }

  renderFindings(section, diagnostics);
  renderPathLinks(section, diagnostics.paths, plugin);
  renderOutputBlock(section, "stdout", command.stdout);
  renderOutputBlock(section, "stderr", command.stderr);
}

function renderCopyButton(parent: HTMLElement, label: string, value: string): void {
  const button = parent.createEl("button", {
    cls: "ango-validator__button",
    text: label,
  });
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
    new Notice(`${label} copied.`);
  });
}

function renderFindings(parent: HTMLElement, diagnostics: CommandDiagnostics): void {
  if (diagnostics.errors.length === 0 && diagnostics.warnings.length === 0) return;

  const block = parent.createDiv({ cls: "ango-validator__findings" });
  block.createDiv({ cls: "ango-validator__section-title", text: "Findings" });
  diagnostics.errors.forEach((line) => {
    block.createDiv({ cls: "ango-validator__finding ango-validator__finding--error", text: line });
  });
  diagnostics.warnings.forEach((line) => {
    block.createDiv({ cls: "ango-validator__finding ango-validator__finding--warning", text: line });
  });
}

function renderPathLinks(parent: HTMLElement, paths: string[], plugin: AnGoCompanionPlugin): void {
  const availablePaths = paths.filter((filePath) => plugin.resolveVaultFile(filePath));
  if (availablePaths.length === 0) return;

  const block = parent.createDiv({ cls: "ango-validator__path-links" });
  block.createDiv({ cls: "ango-validator__section-title", text: "Referenced files" });
  availablePaths.forEach((filePath) => {
    const button = block.createEl("button", {
      cls: "ango-validator__path-link",
      text: filePath,
    });
    button.addEventListener("click", () => {
      void plugin.openVaultFile(filePath);
    });
  });
}

function renderHistory(parent: HTMLElement, history: ValidationRun[], currentRun: ValidationRun): void {
  const previousRuns = history.filter((run) => run.startedAt !== currentRun.startedAt);
  if (previousRuns.length === 0) return;

  const block = parent.createDiv({ cls: "ango-validator__history" });
  block.createDiv({ cls: "ango-validator__section-title", text: "Session history" });
  previousRuns.slice(0, 5).forEach((run) => {
    const ok = run.commands.every((command) => command.exitCode === 0 && !command.error);
    const item = block.createDiv({ cls: "ango-validator__history-item" });
    item.createSpan({
      cls: `ango-validator__status ${ok ? "ango-validator__status--ok" : "ango-validator__status--fail"}`,
      text: ok ? "OK" : "ERR",
    });
    item.createSpan({ cls: "ango-validator__history-title", text: run.title });
    item.createSpan({ cls: "ango-validator__history-time", text: run.finishedAt });
  });
}

function renderOutputBlock(parent: HTMLElement, label: string, output: string): void {
  const block = parent.createDiv({ cls: "ango-validator__output-block" });
  block.createDiv({ cls: "ango-validator__output-label", text: label });
  block.createEl("pre", {
    cls: "ango-validator__output",
    text: output.trim() || "(empty)",
  });
}

function analyzeRun(run: ValidationRun): RunDiagnostics {
  const commandDiagnostics = new Map<CommandResult, CommandDiagnostics>();
  let errorCount = 0;
  let warningCount = 0;
  const failedCommands: CommandResult[] = [];

  run.commands.forEach((command) => {
    const diagnostics = analyzeCommand(command, run.vaultRoot);
    commandDiagnostics.set(command, diagnostics);
    errorCount += diagnostics.errors.length;
    warningCount += diagnostics.warnings.length;

    if (command.exitCode !== 0 || command.error) {
      failedCommands.push(command);
      if (diagnostics.errors.length === 0) errorCount += 1;
    }
  });

  return {
    commandDiagnostics,
    errorCount,
    failedCommands,
    warningCount,
  };
}

function analyzeCommand(command: CommandResult, vaultRoot: string): CommandDiagnostics {
  const combinedOutput = [command.error ?? "", command.stdout, command.stderr].join("\n");
  const lines = combinedOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    errors: unique(lines.filter(isErrorLine)),
    warnings: unique(lines.filter(isWarningLine)),
    paths: extractVaultPaths(combinedOutput, vaultRoot),
  };
}

function isErrorLine(line: string): boolean {
  if (/\b0\s+errors?\b/i.test(line)) return false;
  return /\b(error|err|failed|failure|traceback|exception|missing)\b/i.test(line);
}

function isWarningLine(line: string): boolean {
  if (/\b0\s+warnings?\b/i.test(line)) return false;
  return /\b(warn|warning)\b/i.test(line);
}

function extractVaultPaths(output: string, vaultRoot: string): string[] {
  const matches = output.match(/(?:\/[^\s"'<>]+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9_.-]+)/g) ?? [];
  const paths = matches
    .map((candidate) => candidate.replace(/[),.;:]+$/g, ""))
    .map((candidate) => toVaultRelativePath(candidate, vaultRoot))
    .filter((candidate): candidate is string => Boolean(candidate));
  return unique(paths);
}

function toVaultRelativePath(candidate: string, vaultRoot: string): string | null {
  if (path.isAbsolute(candidate)) {
    if (!vaultRoot || vaultRoot === "(not configured)") return null;

    const relativePath = path.relative(vaultRoot, candidate);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
    return normalizePath(relativePath);
  }

  return normalizePath(candidate);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
