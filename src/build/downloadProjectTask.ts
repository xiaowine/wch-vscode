import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  appendOpenOcdChipIdArgs,
  appendOpenOcdCommandArg,
  getConfiguredMounRiverStudioPath,
  resolveOpenOcdPaths,
  TWO_WIRE_DEBUG_INTERFACE_MODE,
} from "./buildShared";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
  resolveBuildProjectForExecution,
  resolveCurrentBuildTarget,
  resolveProjectFileSystemPath,
} from "./buildProjectResolver";
import {
  getPowerOutput,
  getResetMode,
  powerOffProject,
  type PowerOutput,
} from "./powerOffReset";
import {
  createOpenOcdTerminalWriter,
  type OpenOcdTerminalWriter,
} from "./openOcdOutput";
import { t } from "../i18n";

export const DOWNLOAD_PROJECT_COMMAND = "wchVscode.downloadProject";

export function getCurrentDownloadTargetTooltip(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
  const resolution = resolveCurrentBuildTarget(editor);
  if (!resolution.target) {
    return resolution.error ?? t("error.noDownloadableWchProject");
  }

  const { model } = resolution.target;
  return t("tooltip.actionTarget", {
    action: t("action.download"),
    projectName: model.identity.name || model.identity.baseName,
  });
}

export async function downloadCurrentProject(
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
  showSuccessMessage = true,
): Promise<boolean> {
  let project: ResolvedBuildProject;
  try {
    project = await resolveBuildProjectForExecution(editor);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    return false;
  }

  return downloadResolvedProject(project, showSuccessMessage);
}

export async function downloadResolvedProject(
  project: ResolvedBuildProject,
  showSuccessMessage = true,
): Promise<boolean> {
  const output = createOpenOcdTerminalWriter();
  output.writeLine(
    t("download.starting", {
      projectName:
        project.model.identity.name || project.model.identity.baseName,
    }),
  );

  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  const openOcdPaths = resolveOpenOcdPaths(mounRiverStudioPath);
  if (!openOcdPaths) {
    void vscode.window.showErrorMessage(t("setting.mounRiverStudioPathRequired"));
    return false;
  }

  if (!await fileExists(openOcdPaths.executable)) {
    void vscode.window.showErrorMessage(t("error.mrsOpenOcdExecutableMissing", { filePath: openOcdPaths.executable }));
    return false;
  }

  if (!await fileExists(openOcdPaths.config)) {
    void vscode.window.showErrorMessage(t("error.mrsOpenOcdConfigMissing", { filePath: openOcdPaths.config }));
    return false;
  }

  const downloadTargetPath = resolveDownloadTargetPath(project);
  if (!await fileExists(downloadTargetPath)) {
    void vscode.window.showErrorMessage(t("error.downloadTargetMissing", { filePath: downloadTargetPath }));
    return false;
  }

  const resetMode = getResetMode();
  const resetLog = (message: string) => output.writeLine(message);
  const powerOn = resetMode === "powerOff" ? getPowerOutput() : undefined;
  if (resetMode === "powerOff") {
    try {
      // 先只关闭电源；上电和下载在同一个 OpenOCD 进程里完成，避免中间让 CPU 运行。
      await powerOffProject(project, { log: resetLog });
    } catch (error) {
      void vscode.window.showErrorMessage(formatOpenOcdFailureMessage(
        t("error.operationDownloadFailed"),
        t("error.powerResetFailed", { message: asErrorMessage(error) }),
      ));
      return false;
    }
  }

  try {
    const exitCode = await runOpenOcdDownload(
      project,
      openOcdPaths,
      downloadTargetPath,
      powerOn,
      output,
    );
    if (exitCode === 0) {
      output.writeLine(t("download.succeededLog"));
      if (showSuccessMessage) {
        void vscode.window.showInformationMessage(t("message.downloadSucceeded"));
      }
      return true;
    }

    const detail = t("error.openOcdExitCode", {
      exitCode: exitCode ?? t("value.unknown"),
    });
    output.writeLine(detail);
    void vscode.window.showErrorMessage(formatOpenOcdFailureMessage(
      t("error.operationDownloadFailed"),
      detail,
    ));
  } catch (error) {
    const message = asErrorMessage(error);
    output.writeLine(message);
    void vscode.window.showErrorMessage(
      formatOpenOcdFailureMessage(t("error.operationDownloadFailed"), message),
    );
  }
  return false;
}

async function runOpenOcdDownload(
  project: ResolvedBuildProject,
  openOcdPaths: { executable: string; config: string },
  downloadTargetPath: string,
  powerOn: PowerOutput | undefined,
  output: OpenOcdTerminalWriter,
): Promise<number | null> {
  const args = buildOpenOcdDownloadArgs(
    project,
    openOcdPaths.config,
    downloadTargetPath,
    powerOn,
  );

  return new Promise((resolve, reject) => {
    const child = spawn(openOcdPaths.executable, args, {
      cwd: path.dirname(openOcdPaths.executable),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => output.write(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.write(chunk.toString()));
    child.on("error", (error) => {
      output.writeLine(asErrorMessage(error));
      reject(error);
    });
    child.on("close", (exitCode) => {
      output.flush();
      resolve(exitCode);
    });
  });
}

export function buildOpenOcdDownloadArgs(
  project: ResolvedBuildProject,
  configPath: string,
  downloadTargetPath: string,
  powerOn?: PowerOutput,
): string[] {
  const args = ["-f", configPath];
  appendOpenOcdChipIdArgs(args, project.model.flash.mcuType);

  // 上电和下载必须在同一个 OpenOCD 会话里，避免上电后、下载前 CPU 运行。
  if (powerOn) {
    appendOpenOcdCommandArg(args, "dbgtool");
  }

  // 2-wire 需要在 init 之前切换。
  if (project.model.flash.debugInterfaceMode === TWO_WIRE_DEBUG_INTERFACE_MODE) {
    args.push("-c", "two_wires");
  }

  if (powerOn) {
    args.push("-c", `${powerOn === "5v" ? "pow5v" : "pow3v3"} on`);
  }

  appendOpenOcdCommandArg(args, "init");
  appendOpenOcdCommandArg(args, "halt");
  args.push("-c", buildOpenOcdProgramCommand(project, downloadTargetPath));
  return args;
}

function resolveDownloadTargetPath(project: ResolvedBuildProject): string {
  const targetPath = project.model.flash.targetPath.trim();
  return targetPath ? resolveProjectFileSystemPath(project.model, targetPath) : project.elfPath;
}

function buildOpenOcdProgramCommand(
  project: ResolvedBuildProject,
  downloadTargetPath: string,
): string {
  const args = [`program "${toOpenOcdPath(downloadTargetPath)}"`];
  const address = normalizeFlashAddress(project.model.flash.address);
  if (address) {
    args.push(address);
  }
  args.push("verify", "reset", "exit");
  return args.join(" ");
}

export function toOpenOcdPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function normalizeFlashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) {
    return "";
  }

  return /^0x08000000$/i.test(trimmed) ? "0x00000000" : trimmed;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatOpenOcdFailureMessage(operation: string, detail: string): string {
  return t("error.openOcdFailure", { operation, detail });
}
