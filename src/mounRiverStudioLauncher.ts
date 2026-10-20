import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createMounRiverStudioEnvironment,
  getConfiguredMounRiverStudioPath,
  resolveMounRiverStudioExecutable,
} from "./build/buildShared";
import { t } from "./i18n";
import { getWchProjectState } from "./projectState";

export const OPEN_IN_MOUN_RIVER_STUDIO_COMMAND = "wchVscode.openInMounRiverStudio";

const outputChannel = vscode.window.createOutputChannel(t("mrs2.outputChannel"));
let hiddenMrsTerminal: vscode.Terminal | undefined;

vscode.window.onDidCloseTerminal((terminal) => {
  if (terminal === hiddenMrsTerminal) {
    hiddenMrsTerminal = undefined;
  }
});

export async function openProjectInMounRiverStudio(wvprojPath: string): Promise<void> {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${t("mrs2.openRequested")}`);
  outputChannel.appendLine(`wvprojPath: ${wvprojPath}`);

  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  outputChannel.appendLine(`mounRiverStudioPath: ${mounRiverStudioPath || "<empty>"}`);

  const executablePath = resolveMounRiverStudioExecutable(mounRiverStudioPath);
  outputChannel.appendLine(`executablePath: ${executablePath ?? "<unresolved>"}`);

  if (!executablePath) {
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("setting.mounRiverStudioPathRequired"));
    return;
  }

  if (!await fileExists(executablePath)) {
    outputChannel.appendLine("executable exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.mrs2ExecutableMissing", { filePath: executablePath }));
    return;
  }
  outputChannel.appendLine("executable exists: true");

  if (!await fileExists(wvprojPath)) {
    outputChannel.appendLine("wvproj exists: false");
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.wvprojMissing", { filePath: wvprojPath }));
    return;
  }
  outputChannel.appendLine("wvproj exists: true");

  try {
    // 中文路径下 ShellExecute/文件关联可能返回 0x2，直接启动可执行文件更可靠。
    await launchMounRiverStudio(executablePath, wvprojPath);
    void vscode.window.showInformationMessage(t("message.mrs2ProjectOpened"));
    return;
  } catch (error) {
    outputChannel.appendLine(`direct launch failed: ${asErrorMessage(error)}`);
  }

  try {
    const projectUri = vscode.Uri.file(wvprojPath);
    outputChannel.appendLine(`openExternal target: ${projectUri.toString(true)}`);
    const opened = await vscode.env.openExternal(projectUri);
    outputChannel.appendLine(`openExternal result: ${opened}`);
    if (opened) {
      void vscode.window.showInformationMessage(t("message.mrs2ProjectOpened"));
      return;
    }

    const command = `${quoteCmdArgument(executablePath)} ${quoteCmdArgument(wvprojPath)}`;
    outputChannel.appendLine(`hidden terminal command: ${command}`);
    const terminal = getOrCreateHiddenTerminal(mounRiverStudioPath);
    terminal.sendText(command);
    void vscode.window.showInformationMessage(t("message.mrs2ProjectOpened"));
  } catch (error) {
    outputChannel.appendLine(`terminal launch threw: ${asErrorMessage(error)}`);
    outputChannel.show(true);
    void vscode.window.showErrorMessage(t("error.mrs2OpenFailed", { message: asErrorMessage(error) }));
  }
}

function launchMounRiverStudio(executablePath: string, wvprojPath: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(executablePath, [wvprojPath], {
    cwd: path.dirname(executablePath),
    env: createMounRiverStudioEnvironment(),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  // 进程能创建不代表 MRS 真的启动；继承错误环境变量时它会立刻退出。
  const timer = setTimeout(() => {
    child.unref();
    resolve();
  }, 2000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`MounRiver Studio exited with code ${code ?? "unknown"}`));
  });
  return promise;
}

export type CurrentMrsProjectResolution =
  | { status: "found"; wvprojPath: string; projectName: string }
  | { status: "no-folder" | "ambiguous" | "not-mrs" };

export function resolveCurrentMrsProject(): CurrentMrsProjectResolution {
  const folder = resolveCurrentWorkspaceFolder();
  if (!folder) {
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    return { status: hasWorkspace ? "ambiguous" : "no-folder" };
  }

  const project = getWchProjectState().projects.find(
    (item) => item.folderPath === folder.uri.fsPath,
  );
  const wvprojPath = project?.configurationWvprojPath
    ?? project?.models[0]?.identity.files.wvproj
    ?? project?.projectPairs[0]?.wvproj.filePath;
  if (!wvprojPath) {
    return { status: "not-mrs" };
  }

  const model = project?.models[0];
  const projectName = model?.identity.name
    || model?.identity.baseName
    || path.basename(wvprojPath, path.extname(wvprojPath));
  return { status: "found", wvprojPath, projectName };
}

export async function openCurrentProjectInMounRiverStudio(): Promise<void> {
  const resolution = resolveCurrentMrsProject();
  if (resolution.status !== "found") {
    void vscode.window.showWarningMessage(getOpenProjectWarning(resolution.status));
    return;
  }

  await openProjectInMounRiverStudio(resolution.wvprojPath);
}

function getOpenProjectWarning(
  status: Exclude<CurrentMrsProjectResolution["status"], "found">,
): string {
  switch (status) {
    case "no-folder":
      return t("warning.openMrsProjectNoFolder");
    case "ambiguous":
      return t("warning.openMrsProjectAmbiguous");
    case "not-mrs":
      return t("warning.openMrsProjectNotMrs");
  }
}

// 优先使用当前文件所在的工作区；单工作区时直接使用该文件夹。
function resolveCurrentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === "file") {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  return workspaceFolders.length === 1 ? workspaceFolders[0] : undefined;
}

function getOrCreateHiddenTerminal(cwd: string): vscode.Terminal {
  if (hiddenMrsTerminal) {
    return hiddenMrsTerminal;
  }

  hiddenMrsTerminal = vscode.window.createTerminal({
    name: t("mrs2.terminalName"),
    shellPath: "cmd.exe",
    shellArgs: ["/Q"],
    cwd,
    hideFromUser: true,
    isTransient: true,
  });
  return hiddenMrsTerminal;
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
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
