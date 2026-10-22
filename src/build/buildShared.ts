import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { WchProjectModel } from "../models/WchProjectModel";

export const MOUN_RIVER_STUDIO_PATH_SETTING = "mounRiverStudioPath";

const TOOLCHAIN_ROOT_SEGMENTS = [
  "resources",
  "app",
  "resources",
  "win32",
  "components",
  "WCH",
  "Toolchain",
] as const;

const MAKE_EXECUTABLE_SEGMENTS = [
  "resources",
  "app",
  "resources",
  "win32",
  "others",
  "Build_Tools",
  "Make",
  "bin",
  "make.exe",
] as const;

const OPENOCD_ROOT_SEGMENTS = [
  "resources",
  "app",
  "resources",
  "win32",
  "components",
  "WCH",
  "OpenOCD",
  "OpenOCD",
] as const;

const OPENOCD_BIN_SEGMENTS = [...OPENOCD_ROOT_SEGMENTS, "bin"] as const;

export type ResolvedToolchainPaths = {
  rootPath: string;
  make: string;
  gcc: string;
  gpp: string;
  gdb: string;
  objcopy: string;
  objdump: string;
  size: string;
};

export type ResolvedOpenOcdPaths = {
  root: string;
  executable: string;
  config: string;
  scripts: string;
};

// MRS2 与 MRS3 的主程序文件名不同，同一安装目录只会存在其中一个。
const MOUN_RIVER_STUDIO_3_EXECUTABLE = "MounRiver Studio 3.exe";
const MOUN_RIVER_STUDIO_2_EXECUTABLE = "MounRiver Studio 2.exe";

export function resolveMounRiverStudioExecutable(
  rootPath: string,
  exists: (candidatePath: string) => boolean = existsSync,
): string | undefined {
  if (!rootPath) {
    return undefined;
  }

  const executableName = exists(
    path.join(rootPath, MOUN_RIVER_STUDIO_3_EXECUTABLE),
  )
    ? MOUN_RIVER_STUDIO_3_EXECUTABLE
    : MOUN_RIVER_STUDIO_2_EXECUTABLE;
  return path.join(rootPath, executableName);
}

export function getConfiguredMounRiverStudioPath(): string {
  return vscode.workspace
    .getConfiguration("wchVscode")
    .get<string>(MOUN_RIVER_STUDIO_PATH_SETTING, "")
    .trim();
}

// 扩展宿主带有 Electron/VS Code 专用环境变量，直接传给 MRS 会改变其启动模式，
// 例如继承 ELECTRON_RUN_AS_NODE 后 MRS 会以 Node 模式启动并立即退出。
export function createMounRiverStudioEnvironment(
  portableDataPath?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key === "ELECTRON_RUN_AS_NODE" ||
      key === "ELECTRON_NO_ATTACH_CONSOLE" ||
      key.startsWith("VSCODE_")
    ) {
      delete environment[key];
    }
  }
  // MRS 3 安装目录带 data 时会自动进入 portable 模式，--user-data-dir 会被忽略。
  // 静默构建必须通过 VSCODE_PORTABLE 指定独立数据目录，避免复用用户已打开的 MRS 实例。
  if (portableDataPath) {
    environment.VSCODE_PORTABLE = portableDataPath;
  }
  return environment;
}

export function resolveCompilerPathFromSetting(
  model: WchProjectModel,
): string | undefined {
  const rootPath = getConfiguredMounRiverStudioPath();
  return resolveToolchainPaths(rootPath, model)?.gcc;
}

export function resolveToolchainPaths(
  rootPath: string,
  model: WchProjectModel,
): ResolvedToolchainPaths | undefined {
  if (!rootPath) {
    return undefined;
  }

  const resolvedToolchain = model.build.toolchain;
  if (!resolvedToolchain.directoryName) {
    return undefined;
  }

  const binPath = path.join(
    rootPath,
    ...TOOLCHAIN_ROOT_SEGMENTS,
    resolvedToolchain.directoryName,
    "bin",
  );
  return {
    rootPath,
    make: path.join(rootPath, ...MAKE_EXECUTABLE_SEGMENTS),
    gcc: path.join(binPath, resolvedToolchain.executables.gcc),
    gpp: path.join(binPath, resolvedToolchain.executables.gpp),
    gdb: path.join(binPath, `${resolvedToolchain.executablePrefix}gdb.exe`),
    objcopy: path.join(binPath, resolvedToolchain.executables.objcopy),
    objdump: path.join(binPath, resolvedToolchain.executables.objdump),
    size: path.join(binPath, resolvedToolchain.executables.size),
  };
}

export function resolveOpenOcdPaths(
  rootPath: string,
): ResolvedOpenOcdPaths | undefined {
  if (!rootPath) {
    return undefined;
  }

  const openOcdRootPath = path.join(rootPath, ...OPENOCD_ROOT_SEGMENTS);
  const binPath = path.join(rootPath, ...OPENOCD_BIN_SEGMENTS);
  return {
    root: openOcdRootPath,
    executable: path.join(binPath, "openocd.exe"),
    config: path.join(binPath, "wch-riscv.cfg"),
    scripts: path.join(openOcdRootPath, "share", "openocd", "scripts"),
  };
}

export function appendOpenOcdChipIdArgs(args: string[], mcuType: string): void {
  if (hasOpenOcdChipIdArg(args)) {
    return;
  }

  const chipId = normalizeOpenOcdChipId(mcuType);
  if (chipId) {
    args.push("-c", `chip_id ${chipId}`);
  }
}

// .wvproj 中保存的接口模式值，2-wire 需要 OpenOCD 在 init 前切换。
export const TWO_WIRE_DEBUG_INTERFACE_MODE = "2-wires serial";

// 避免与工程里已有的 OpenOCD 配置重复，例如 configOptions 中已经写了 init。
export function appendOpenOcdCommandArg(args: string[], command: string): void {
  if (!hasOpenOcdCommandArg(args, command)) {
    args.push("-c", command);
  }
}

export function hasOpenOcdCommandArg(args: string[], command: string): boolean {
  const normalizedCommand = command.toLowerCase();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "-c") {
      continue;
    }
    const value = args[index + 1].trim().toLowerCase();
    if (
      value === normalizedCommand ||
      value.startsWith(`${normalizedCommand} `)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeOpenOcdChipId(mcuType: string): string {
  const normalizedMcuType = normalizeMounRiverArgument(mcuType);
  switch (normalizedMcuType.toUpperCase()) {
    case "CH32V00X":
      return "CH32V003";
    case "CH56X":
      return "CH565/9";
    default:
      return normalizedMcuType;
  }
}

function hasOpenOcdChipIdArg(args: string[]): boolean {
  return args.some((arg) => /(?:^|\s)chip_id(?:\s|$)/i.test(arg));
}

export function resolveMounRiverOpenOcdExecutable(
  openOcdPaths: ResolvedOpenOcdPaths,
  configuredExecutable: string,
): string | undefined {
  const value = normalizeMounRiverArgument(configuredExecutable);
  if (!value || isWchOpenOcdDefaultVariable(value)) {
    return openOcdPaths.executable;
  }

  const variablePath = resolveWchOpenOcdVariablePath(value, openOcdPaths.root);
  if (variablePath) {
    return variablePath;
  }

  return path.isAbsolute(value) ? value : undefined;
}

export function resolveMounRiverOpenOcdValue(
  openOcdPaths: ResolvedOpenOcdPaths,
  value: string,
): string {
  const normalizedValue = normalizeMounRiverArgument(value);
  if (isWchOpenOcdDefaultVariable(normalizedValue)) {
    return openOcdPaths.root;
  }

  return (
    resolveWchOpenOcdVariablePath(normalizedValue, openOcdPaths.root) ??
    normalizedValue
  );
}

export function normalizeMounRiverArgument(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length < 2) {
    return trimmedValue;
  }

  const firstChar = trimmedValue[0];
  const lastChar = trimmedValue[trimmedValue.length - 1];
  if (
    (firstChar === '"' && lastChar === '"') ||
    (firstChar === "'" && lastChar === "'")
  ) {
    return trimmedValue.slice(1, -1).trim();
  }

  return trimmedValue;
}

function isWchOpenOcdDefaultVariable(value: string): boolean {
  return /^\$\{WCH:OpenOCD:[^}]+}$/.test(value);
}

function resolveWchOpenOcdVariablePath(
  value: string,
  openOcdRootPath: string,
): string | undefined {
  const match = /^\$\{WCH:OpenOCD:[^}]+}[/\\](.+)$/.exec(value);
  if (!match) {
    return undefined;
  }

  return path.join(openOcdRootPath, match[1]);
}

export function resolveToolchainDirectoryName(
  gdbExecutable: string,
): string | undefined {
  const matchedToolchainName = /\$\{WCH:Toolchain:([^}]+)\}/
    .exec(gdbExecutable)?.[1]
    ?.trim();
  if (!matchedToolchainName) {
    return undefined;
  }

  switch (matchedToolchainName.toUpperCase()) {
    case "GCC":
    case "GCC8":
      return "RISC-V Embedded GCC";
    case "GCC12":
      return "RISC-V Embedded GCC12";
    case "GCC15":
      return "RISC-V Embedded GCC15";
    default:
      return undefined;
  }
}

export function resolveCompilerExecutableName(
  gdbExecutable: string,
): string | undefined {
  const toolExecutablePrefix = resolveToolExecutablePrefix(gdbExecutable);
  return toolExecutablePrefix ? `${toolExecutablePrefix}gcc.exe` : undefined;
}

export function resolveGdbExecutableName(
  gdbExecutable: string,
): string | undefined {
  const toolExecutablePrefix = resolveToolExecutablePrefix(gdbExecutable);
  return toolExecutablePrefix ? `${toolExecutablePrefix}gdb.exe` : undefined;
}

export function resolveToolExecutablePrefix(
  gdbExecutable: string,
): string | undefined {
  const matchedToolchainName = /\$\{WCH:Toolchain:([^}]+)\}/
    .exec(gdbExecutable)?.[1]
    ?.trim();
  if (!matchedToolchainName) {
    return undefined;
  }

  switch (matchedToolchainName.toUpperCase()) {
    case "GCC":
    case "GCC8":
      return "riscv-none-embed-";
    case "GCC12":
      return "riscv-wch-elf-";
    case "GCC15":
      return "riscv32-wch-elf-";
    default:
      return undefined;
  }
}

export function buildMarch(model: WchProjectModel): string {
  const exts = model.build.riscvExtensions;
  const base = model.build.targetArchitecture || "rv32i";

  // Single-letter standard extensions in fixed order
  let single = "";
  if (exts.includes("M")) {
    single += "m";
  }
  if (exts.includes("A")) {
    single += "a";
  }
  if (exts.includes("C")) {
    single += "c";
  }

  // Multi-letter extensions as underscore-prefixed tokens; XW goes last
  const hasXW = exts.includes("XW");
  const multiTokens: string[] = [];
  if (exts.includes("B")) {
    multiTokens.push("_zba", "_zbb", "_zbc", "_zbs");
  }
  if (exts.includes("Zmmul")) {
    multiTokens.push("_zmmul");
  }
  const hasZExts = multiTokens.length > 0;
  if (hasXW && hasZExts) {
    multiTokens.push("_xw");
  }

  const multiSuffix = multiTokens.join("");
  const xwDirect = hasXW && !hasZExts ? "xw" : "";

  return `${base}${single}${multiSuffix}${xwDirect}`;
}

export function isAbsoluteOrVariablePath(value: string): boolean {
  return (
    /^[A-Za-z]:\//.test(value) ||
    value.startsWith("//") ||
    value.startsWith("/") ||
    value.startsWith("${")
  );
}
