import * as path from "node:path";
import * as vscode from "vscode";
import type { ResolvedBuildProject } from "../build/buildProjectResolver";
import { resolveProjectFileSystemPath } from "../build/buildProjectResolver";
import {
  appendOpenOcdChipIdArgs,
  appendOpenOcdCommandArg,
  getConfiguredMounRiverStudioPath,
  resolveOpenOcdPaths,
  TWO_WIRE_DEBUG_INTERFACE_MODE,
  type ResolvedOpenOcdPaths,
} from "../build/buildShared";
import {
  getPowerOutput,
  getResetMode,
  type PowerOutput,
} from "../build/powerOffReset";
import { t } from "../i18n";
import { logDebug } from "./debugLog";

export type WchRiscvDebugLaunchConfig = {
  type: "wch-riscv";
  request: "launch";
  name: string;
  projectName: string;
  cwd: string;
  sourceRoots: string[];
  elfPath: string;
  gdbPath: string;
  openOcdPath: string;
  openOcdCwd: string;
  openOcdArgs: string[];
  host: string;
  gdbPort: number;
  startupCommands: string[];
  stopAt: string;
  wvprojPath: string;
};

export async function buildWchRiscvDebugLaunchConfig(
  project: ResolvedBuildProject,
): Promise<WchRiscvDebugLaunchConfig> {
  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  const openOcdPaths = resolveOpenOcdPaths(mounRiverStudioPath);
  if (!openOcdPaths) {
    throw new Error(t("setting.mounRiverStudioPathRequired"));
  }

  const gdbPath = project.toolchainPaths.gdb;
  const openOcdPath = resolveConfiguredOpenOcdExecutable(project, openOcdPaths);
  const openOcdArgs = buildOpenOcdServerArgs(project, openOcdPaths);
  const elfPath = project.elfPath;
  const projectName = project.model.identity.name || project.model.identity.baseName;

  logDebug(`Building debug launch config for ${projectName}`);
  logDebug(`GDB path: ${gdbPath}`);
  logDebug(`OpenOCD path: ${openOcdPath}`);
  logDebug(`GDB endpoint: ${project.model.debug.host || "localhost"}:${project.model.debug.gdbPort || 3333}`);
  logDebug(`Stop at: ${project.model.debug.stopAt || "<disabled>"}`);
  logDebug(`WVProj path: ${project.model.identity.files.wvproj}`);

  const sourceRoots = Array.from(new Set([
    project.model.identity.folderPath,
    ...project.model.target.linkedFolders.map((linkedFolder) =>
      resolveProjectFileSystemPath(project.model, linkedFolder.location),
    ),
  ]));
  await assertFileExists(gdbPath, t("debugConfig.gdbMissing", { filePath: gdbPath }));
  await assertFileExists(openOcdPath, t("debugConfig.openOcdMissing", { filePath: openOcdPath }));
  await assertFileExists(elfPath, t("debugConfig.elfMissing", { filePath: elfPath }));

  return {
    type: "wch-riscv",
    request: "launch",
    name: t("debugConfig.launchName", { projectName }),
    projectName,
    cwd: project.model.identity.folderPath,
    sourceRoots,
    elfPath,
    gdbPath,
    openOcdPath,
    openOcdCwd: path.dirname(openOcdPath),
    openOcdArgs,
    host: project.model.debug.host || "localhost",
    gdbPort: project.model.debug.gdbPort || 3333,
    startupCommands: project.model.debug.startupCommands,
    stopAt: project.model.debug.stopAt,
    wvprojPath: project.model.identity.files.wvproj,
  };
}

export function buildOpenOcdServerArgs(
  project: ResolvedBuildProject,
  openOcdPaths: ResolvedOpenOcdPaths,
  powerOn?: PowerOutput,
): string[] {
  const gdbPort = project.model.debug.gdbPort || 3333;
  const telnetPort = project.model.debug.telnetPort || 4444;
  const tclPort = project.model.debug.tclPort || 6666;

  // 单核 RISC-V：固定使用 wch-riscv.cfg，端口和脚本目录需在 init 之前设置。
  const args: string[] = [
    "-c", `gdb_port ${gdbPort}`,
    "-c", `telnet_port ${telnetPort}`,
    "-c", `tcl_port ${tclPort}`,
    "-s", path.dirname(openOcdPaths.executable),
  ];

  const configOptions = project.model.debug.openOcdConfigOptions;
  if (configOptions.length > 0) {
    args.push(...configOptions);
  } else {
    args.push("-f", openOcdPaths.config);
  }

  appendOpenOcdChipIdArgs(args, project.model.flash.mcuType);
  appendOpenOcdCommandArg(args, "dbgtool");

  // 2-wire 必须在 init 之前执行，否则 OpenOCD 会直接报错。
  if (project.model.flash.debugInterfaceMode === TWO_WIRE_DEBUG_INTERFACE_MODE) {
    appendOpenOcdCommandArg(args, "two_wires");
  }

  // 掉电复位模式下，上电和调试必须在同一个 OpenOCD 会话里，避免中间让 CPU 运行。
  const effectivePowerOn =
    powerOn ?? (getResetMode() === "powerOff" ? getPowerOutput() : undefined);
  if (effectivePowerOn) {
    args.push("-c", `${effectivePowerOn === "5v" ? "pow5v" : "pow3v3"} on`);
  }

  appendOpenOcdCommandArg(args, "init");
  appendOpenOcdCommandArg(args, "halt");
  return args;
}

export function resolveConfiguredOpenOcdExecutable(
  project: ResolvedBuildProject,
  openOcdPaths: ResolvedOpenOcdPaths,
): string {
  const configuredExecutable = project.model.debug.openOcdExecutable.trim();
  if (!configuredExecutable) {
    return openOcdPaths.executable;
  }

  return path.isAbsolute(configuredExecutable)
    ? configuredExecutable
    : resolveProjectFileSystemPath(project.model, configuredExecutable);
}

async function assertFileExists(filePath: string, message: string): Promise<void> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
  } catch {
    throw new Error(message);
  }
}
