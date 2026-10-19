import * as path from "node:path";
import * as vscode from "vscode";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
  resolveBuildProjectForExecution,
  resolveCurrentBuildTarget,
} from "./buildProjectResolver";
import { generateBuildFiles } from "./makefileGenerator";
import { executeTaskAndWait } from "./taskExecution";
import { getBuildMethod } from "./buildMethod";
import { runMounRiverSilentBuild } from "./mrsCliBuild";
import { t } from "../i18n";

export const BUILD_PROJECT_COMMAND = "wchVscode.buildProject";
export const CLEAN_PROJECT_COMMAND = "wchVscode.cleanProject";
export const CLEAN_BUILD_PROJECT_COMMAND = "wchVscode.cleanBuildProject";

export function hasCurrentBuildTarget(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): boolean {
  return Boolean(resolveCurrentBuildTarget(editor).target);
}

export function getCurrentBuildTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  actionLabel = t("action.build"),
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? t("error.noBuildableWchProject");
  }

  const { model } = resolution.target;
  return t("tooltip.actionTarget", {
    action: actionLabel,
    projectName: model.identity.name || model.identity.baseName,
  });
}

export async function buildCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  const result = await runProjectBuild(editor, t("action.build"), false, true);
  showBuildResultMessage(result);
}

export async function buildCurrentProjectAndWait(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  showSuccessMessage = true,
): Promise<boolean> {
  const result = await runProjectBuild(editor, t("action.build"), false, true);
  showBuildResultMessage(result, showSuccessMessage);
  if (result.started && result.exitCode === 0) {
    return true;
  }
  return false;
}

export async function buildResolvedProjectAndWait(
  project: ResolvedBuildProject,
  showSuccessMessage = true,
): Promise<boolean> {
  const result = await runResolvedProjectBuild(project, t("action.build"), false, true);
  showBuildResultMessage(result, showSuccessMessage);
  return result.started && result.exitCode === 0;
}

export async function cleanCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  if (getBuildMethod() === "mrs-cli") {
    await cleanCurrentProjectWithMrsCli(editor);
    return;
  }

  let outputDirectory: string;
  try {
    outputDirectory = resolveBuildOutputDirectory(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return;
  }

  try {
    await deleteOutputDirectory(outputDirectory);
    void vscode.window.showInformationMessage(t("message.cleanSucceeded"));
  } catch (error) {
    void vscode.window.showErrorMessage(
      t("error.cleanOutputDirectoryFailed", { message: asErrorMessage(error) }),
    );
  }
}

async function cleanCurrentProjectWithMrsCli(
  editor: vscode.TextEditor | undefined,
): Promise<void> {
  let project: ResolvedBuildProject;
  try {
    project = await resolveBuildProjectForExecution(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return;
  }

  const outcome = await runMounRiverSilentBuild(project, "clean");
  if (outcome.reason === "succeeded") {
    void vscode.window.showInformationMessage(t("message.cleanSucceeded"));
  } else if (outcome.reason === "failed") {
    void vscode.window.showErrorMessage(t("error.mrsCliCleanFailed"));
  }
}

export async function cleanBuildCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  const result = await runProjectBuild(editor, t("action.cleanBuild"), true, true);
  showBuildResultMessage(result);
}

type BuildRunResult =
  | { started: false }
  | { started: true; exitCode: number | undefined };

async function runProjectBuild(
  editor: vscode.TextEditor | undefined,
  taskLabelPrefix: string,
  cleanOutputDirectory = false,
  waitForExit = false,
): Promise<BuildRunResult> {
  let project: ResolvedBuildProject;
  try {
    project = await resolveBuildProjectForExecution(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return { started: false };
  }

  return runResolvedProjectBuild(
    project,
    taskLabelPrefix,
    cleanOutputDirectory,
    waitForExit,
  );
}

async function runResolvedProjectBuild(
  project: ResolvedBuildProject,
  taskLabelPrefix: string,
  cleanOutputDirectory = false,
  waitForExit = false,
): Promise<BuildRunResult> {
  // mrs-cli 交给 MRS2 解析工程参数并构建，与在 MRS2 内编译一致。
  if (getBuildMethod() === "mrs-cli") {
    const outcome = await runMounRiverSilentBuild(
      project,
      cleanOutputDirectory ? "rebuild" : "build",
    );
    if (outcome.reason === "succeeded") {
      return { started: true, exitCode: 0 };
    }
    if (outcome.reason === "failed") {
      return { started: true, exitCode: 1 };
    }
    return { started: false };
  }

  if (cleanOutputDirectory) {
    try {
      await deleteOutputDirectory(project.outputDirectory);
    } catch (error) {
      void vscode.window.showErrorMessage(
        t("error.cleanOutputDirectoryFailed", { message: asErrorMessage(error) }),
      );
      return { started: false };
    }
  }

  try {
    await generateBuildFiles(project);
  } catch (error) {
    void vscode.window.showErrorMessage(
      t("error.generateMakefileFailed", { message: asErrorMessage(error) }),
    );
    return { started: false };
  }

  const task = createBuildTask(project, taskLabelPrefix);
  if (waitForExit) {
    return {
      started: true,
      exitCode: await executeTaskAndWait(task),
    };
  }

  await vscode.tasks.executeTask(task);
  return { started: true, exitCode: undefined };
}

function resolveBuildOutputDirectory(
  editor: vscode.TextEditor | undefined,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    throw new Error(resolution.error ?? t("error.cannotLocateBuildProject"));
  }

  const { model } = resolution.target;
  if (model.target.toolchain.toUpperCase() !== "RISC-V") {
    throw new Error(t("error.unsupportedRiscvOnly"));
  }

  const outputDirectoryName = model.build.configName.trim();
  if (!outputDirectoryName) {
    throw new Error(t("error.missingBuildConfigNameForOutputDirectory"));
  }

  return path.join(model.identity.folderPath, outputDirectoryName);
}

function createBuildTask(
  project: ResolvedBuildProject,
  taskLabelPrefix: string,
): vscode.Task {
  const execution = new vscode.ProcessExecution(
    project.toolchainPaths.make,
    buildMakeArguments(project),
    {
      cwd: project.outputDirectory,
      env: {
        PATH: `${path.dirname(project.toolchainPaths.gcc)};${process.env.PATH ?? ""}`,
      },
    },
  );
  const task = new vscode.Task(
    {
      type: "wchBuild",
      workspaceFolder: project.workspaceFolder.name,
      projectName: project.model.identity.name || project.model.identity.baseName,
      action: taskLabelPrefix,
    },
    project.workspaceFolder,
    `${taskLabelPrefix} ${project.model.identity.name || project.model.identity.baseName}`,
    "wch-vscode",
    execution,
    [],
  );
  task.group = vscode.TaskGroup.Build;
  task.presentationOptions = {
    clear: true,
    panel: vscode.TaskPanelKind.Dedicated,
    reveal: vscode.TaskRevealKind.Always,
  };
  return task;
}

async function deleteOutputDirectory(outputDirectory: string): Promise<void> {
  const outputDirectoryUri = vscode.Uri.file(outputDirectory);
  try {
    await vscode.workspace.fs.delete(outputDirectoryUri, {
      recursive: true,
      useTrash: false,
    });
  } catch (error) {
    if (isEntryNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

function buildMakeArguments(project: ResolvedBuildProject): string[] {
  const args: string[] = [];
  const parallelJobs = Number.parseInt(
    project.model.build.parallelizationNumber,
    10,
  );
  if (Number.isFinite(parallelJobs) && parallelJobs > 0) {
    args.push(`-j${parallelJobs}`);
  }
  if (!project.model.build.stopOnFirstBuildError) {
    args.push("-k");
  }
  return args;
}

function isEntryNotFoundError(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError &&
    /FileNotFound|EntryNotFound/i.test(error.name)
  );
}

function showBuildResultMessage(
  result: BuildRunResult,
  showSuccessMessage = true,
): void {
  if (!result.started) {
    return;
  }

  if (result.exitCode === 0) {
    if (showSuccessMessage) {
      void vscode.window.showInformationMessage(t("message.buildSucceeded"));
    }
    return;
  }

  const failureMessage = getBuildMethod() === "mrs-cli"
    ? t("error.mrsCliBuildFailed")
    : t("error.buildFailedWithExitCode", {
        exitCode: result.exitCode ?? t("value.unknown"),
      });
  void vscode.window.showErrorMessage(failureMessage);
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
