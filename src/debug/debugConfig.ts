import * as path from "node:path";
import * as vscode from "vscode";
import type { ResolvedBuildProject } from "../build/buildProjectResolver";
import { resolveProjectFileSystemPath } from "../build/buildProjectResolver";
import {
  getConfiguredMounRiverStudioPath,
  resolveOpenOcdPaths,
  type ResolvedOpenOcdPaths,
} from "../build/buildShared";
import { logDebug } from "./debugLog";

export type WchRiscvDebugLaunchConfig = {
  type: "wch-riscv";
  request: "launch";
  name: string;
  projectName: string;
  cwd: string;
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
    throw new Error("请先配置 wchVscode.mounRiverStudioPath");
  }

  const gdbPath = project.toolchainPaths.gdb;
  const openOcdPath = resolveConfiguredOpenOcdExecutable(project, openOcdPaths);
  const openOcdArgs = buildOpenOcdServerArgs(project, openOcdPaths);
  const elfPath = project.elfPath;
  const projectName = project.model.identity.name || project.model.identity.baseName;

  logDebug(`Building debug launch config for ${projectName}`);
  logDebug(`GDB path: ${gdbPath}`);
  logDebug(`OpenOCD path: ${openOcdPath}`);
  logDebug(`OpenOCD args: ${openOcdArgs.join(" ")}`);
  logDebug(`GDB endpoint: ${project.model.debug.host || "localhost"}:${project.model.debug.gdbPort || 3333}`);
  logDebug(`Stop at: ${project.model.debug.stopAt || "<disabled>"}`);
  logDebug(`WVProj path: ${project.model.identity.files.wvproj}`);

  await assertFileExists(gdbPath, `MRS 安装路径无效，未找到 gdb.exe：${gdbPath}`);
  await assertFileExists(openOcdPath, `MRS 安装路径无效，未找到 openocd.exe：${openOcdPath}`);
  await assertFileExists(elfPath, `未找到 ELF 文件：${elfPath}`);

  return {
    type: "wch-riscv",
    request: "launch",
    name: `Debug ${projectName}`,
    projectName,
    cwd: project.model.identity.folderPath,
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
): string[] {
  const args = project.model.debug.openOcdConfigOptions.length > 0
    ? [...project.model.debug.openOcdConfigOptions]
    : ["-f", openOcdPaths.config];

  const gdbPort = project.model.debug.gdbPort || 3333;
  const telnetPort = project.model.debug.telnetPort || 4444;
  const tclPort = project.model.debug.tclPort || 6666;
  args.push(
    "-c",
    `gdb_port ${gdbPort}`,
    "-c",
    `telnet_port ${telnetPort}`,
    "-c",
    `tcl_port ${tclPort}`,
  );
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
