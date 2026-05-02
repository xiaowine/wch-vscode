import * as path from "node:path";
import * as vscode from "vscode";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
  resolveBuildProjectForExecution,
  resolveCurrentBuildTarget,
} from "./buildProjectResolver";
import { generateBuildFiles } from "./makefileGenerator";
import { executeTaskAndWait } from "./taskExecution";

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
  actionLabel = "Build",
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? "当前未找到可编译的 WCH 工程";
  }

  const { model } = resolution.target;
  return `${actionLabel} ${model.project.name || model.baseName}`;
}

export async function buildCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  const result = await runProjectBuild(editor, "Build", false, true);
  showBuildResultMessage(result);
}

export async function buildCurrentProjectAndWait(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<boolean> {
  const result = await runProjectBuild(editor, "Build", false, true);
  showBuildResultMessage(result);
  if (result.started && result.exitCode === 0) {
    return true;
  }
  return false;
}

export async function cleanCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  let outputDirectory: string;
  try {
    outputDirectory = resolveBuildOutputDirectory(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return;
  }

  try {
    await deleteOutputDirectory(outputDirectory);
    void vscode.window.showInformationMessage("清理成功");
  } catch (error) {
    void vscode.window.showErrorMessage(
      `清理构建目录失败：${asErrorMessage(error)}`,
    );
  }
}

export async function cleanBuildCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
  const result = await runProjectBuild(editor, "Clean Build", true, true);
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

  if (cleanOutputDirectory) {
    try {
      await deleteOutputDirectory(project.outputDirectory);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `清理构建目录失败：${asErrorMessage(error)}`,
      );
      return { started: false };
    }
  }

  try {
    await generateBuildFiles(project);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `生成 makefile 失败：${asErrorMessage(error)}`,
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
    throw new Error(resolution.error ?? "当前无法定位可编译工程");
  }

  const { model } = resolution.target;
  if (model.chip.toolchain.toUpperCase() !== "RISC-V") {
    throw new Error("不支持，仅支持 RISC-V 工程");
  }

  const outputDirectoryName = model.build.configName.trim();
  if (!outputDirectoryName) {
    throw new Error("当前工程缺少 build.configName，无法定位构建目录");
  }

  return path.join(model.folderPath, outputDirectoryName);
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
      projectName: project.model.project.name || project.model.baseName,
      action: taskLabelPrefix,
    },
    project.workspaceFolder,
    `${taskLabelPrefix} ${project.model.project.name || project.model.baseName}`,
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

function showBuildResultMessage(result: BuildRunResult): void {
  if (!result.started) {
    return;
  }

  if (result.exitCode === 0) {
    void vscode.window.showInformationMessage("编译成功");
    return;
  }

  void vscode.window.showErrorMessage(
    `编译失败，make 退出码：${result.exitCode ?? "未知"}`,
  );
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
