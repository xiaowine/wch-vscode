import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ResolvedBuildProject } from "./buildProjectResolver";
import {
  appendOpenOcdChipIdArgs,
  appendOpenOcdCommandArg,
  getConfiguredMounRiverStudioPath,
  resolveOpenOcdPaths,
  TWO_WIRE_DEBUG_INTERFACE_MODE,
  type ResolvedOpenOcdPaths,
} from "./buildShared";
import { t } from "../i18n";

export const RESET_MODE_SETTING = "resetMode";
export const POWER_OFF_DELAY_SETTING = "powerOffDelayMs";
export const POWER_OUTPUT_SETTING = "powerOutput";

export type ResetMode = "nrst" | "powerOff";

export type PowerOutput = "3v3" | "5v";

export type PowerCycleState = "off" | "on";

export type PowerCycleOptions = {
  // 调试前需要保持 halt，下载完成后的重新上电则应该让目标直接运行。
  halt?: boolean;
  log?: (message: string) => void;
};

type PowerPassResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

const POWER_PASS_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_OUTPUT = 200_000;

export function getResetMode(): ResetMode {
  const value = vscode.workspace
    .getConfiguration("wchVscode")
    .get<string>(RESET_MODE_SETTING, "nrst");
  return value === "powerOff" ? "powerOff" : "nrst";
}

export function getPowerOffDelayMs(): number {
  const value = vscode.workspace
    .getConfiguration("wchVscode")
    .get<number>(POWER_OFF_DELAY_SETTING, 100);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 100;
  }

  return Math.min(10_000, Math.max(0, Math.round(value)));
}

export function getPowerOutput(): PowerOutput {
  const value = vscode.workspace
    .getConfiguration("wchVscode")
    .get<string>(POWER_OUTPUT_SETTING, "3v3");
  return value === "5v" ? "5v" : "3v3";
}

export function buildOpenOcdPowerCycleArgs(
  project: ResolvedBuildProject,
  configPath: string,
  state: PowerCycleState,
  haltAfterPowerOn: boolean,
  powerOutput: PowerOutput = getPowerOutput(),
): string[] {
  // 掉电复位固定使用 MRS 默认配置，避免工程 configOptions 中的 init 排到电源命令之前。
  // 这两次 OpenOCD 只做电源切换，不需要 GDB/Telnet/Tcl 端口，禁用后可避免端口占用。
  const args = [
    "-c",
    "gdb_port disabled",
    "-c",
    "telnet_port disabled",
    "-c",
    "tcl_port disabled",
    "-f",
    configPath,
  ];
  appendOpenOcdChipIdArgs(args, project.model.flash.mcuType);
  appendOpenOcdCommandArg(args, "dbgtool");

  if (project.model.flash.debugInterfaceMode === TWO_WIRE_DEBUG_INTERFACE_MODE) {
    appendOpenOcdCommandArg(args, "two_wires");
  }

  // pow3v3 与 pow5v 共用同一个电源状态，后一条会覆盖前一条。
  // 必须只发送目标实际使用的供电电源，否则会变成只切换另一路。
  const powerCommand = powerOutput === "5v" ? "pow5v" : "pow3v3";
  args.push("-c", `${powerCommand} ${state}`);

  appendOpenOcdCommandArg(args, "init");
  if (state === "on" && haltAfterPowerOn) {
    appendOpenOcdCommandArg(args, "halt");
  }
  appendOpenOcdCommandArg(args, "shutdown");
  return args;
}

export async function powerCycleProject(
  project: ResolvedBuildProject,
  options: PowerCycleOptions = {},
): Promise<void> {
  const openOcdPaths = await resolvePowerCyclePaths();
  await powerCycleProjectWithPaths(project, openOcdPaths, options);
}

export async function powerOffProject(
  project: ResolvedBuildProject,
  options: PowerCycleOptions = {},
): Promise<void> {
  const openOcdPaths = await resolvePowerCyclePaths();
  await powerOffProjectWithPaths(project, openOcdPaths, options);
}

async function resolvePowerCyclePaths(): Promise<ResolvedOpenOcdPaths> {
  const openOcdPaths = resolveOpenOcdPaths(getConfiguredMounRiverStudioPath());
  if (!openOcdPaths) {
    throw new Error(t("setting.mounRiverStudioPathRequired"));
  }

  await assertFileExists(
    openOcdPaths.executable,
    t("error.mrsOpenOcdExecutableMissing", { filePath: openOcdPaths.executable }),
  );
  await assertFileExists(
    openOcdPaths.config,
    t("error.mrsOpenOcdConfigMissing", { filePath: openOcdPaths.config }),
  );
  return openOcdPaths;
}

export async function powerOffProjectWithPaths(
  project: ResolvedBuildProject,
  openOcdPaths: Pick<ResolvedOpenOcdPaths, "executable" | "config">,
  options: PowerCycleOptions = {},
): Promise<void> {
  const log = createPowerCycleLogger(options);
  const projectName =
    project.model.identity.name || project.model.identity.baseName;

  log(t("powerReset.start", { projectName }));
  const powerOutput = getPowerOutput();

  await runPowerPass(project, openOcdPaths, "off", false, log, powerOutput, 0);
  const delay = getPowerOffDelayMs();
  log(t("powerReset.delay", { delay }));
  await delayMs(delay);
  log(t("powerReset.offCompleted"));
}

export async function powerCycleProjectWithPaths(
  project: ResolvedBuildProject,
  openOcdPaths: Pick<ResolvedOpenOcdPaths, "executable" | "config">,
  options: PowerCycleOptions = {},
): Promise<void> {
  const log = createPowerCycleLogger(options);
  const projectName =
    project.model.identity.name || project.model.identity.baseName;

  log(t("powerReset.start", { projectName }));
  const powerOutput = getPowerOutput();

  await runPowerPass(project, openOcdPaths, "off", false, log, powerOutput, 0);
  const delay = getPowerOffDelayMs();
  log(t("powerReset.delay", { delay }));
  await delayMs(delay);
  await runPowerPass(
    project,
    openOcdPaths,
    "on",
    options.halt ?? false,
    log,
    powerOutput,
    0,
  );

  log(t("powerReset.succeeded"));
}

async function runPowerPass(
  project: ResolvedBuildProject,
  openOcdPaths: Pick<ResolvedOpenOcdPaths, "executable" | "config">,
  state: PowerCycleState,
  haltAfterPowerOn: boolean,
  log: (message: string) => void,
  powerOutput: PowerOutput,
  attempt = 0,
): Promise<void> {
  const args = buildOpenOcdPowerCycleArgs(
    project,
    openOcdPaths.config,
    state,
    haltAfterPowerOn,
    powerOutput,
  );
  const voltage = powerOutput === "5v" ? "5V" : "3.3V";
  log(
    t(state === "off" ? "powerReset.offPhase" : "powerReset.onPhase", {
      voltage,
    }),
  );

  const result = await spawnOpenOcdPass(
    openOcdPaths.executable,
    args,
    path.dirname(openOcdPaths.executable),
  );

  if (result.output) {
    for (const line of result.output.split(/\r?\n/)) {
      if (line.trim()) {
        log(`[${state}] ${line}`);
      }
    }
  }

  if (result.timedOut) {
    throw new Error(
      t("powerReset.timeout", { state, timeout: POWER_PASS_TIMEOUT_MS }),
    );
  }

  if (state === "off") {
    // 目标断电后 init 可能无法连接芯片，这是预期结果；只拦截真正的命令/适配器错误。
    if (isFatalPowerOffError(result.output)) {
      throw new Error(
        t("powerReset.passFailed", {
          state,
          exitCode: result.exitCode ?? t("value.unknown"),
          output: truncateOutput(result.output),
        }),
      );
    }

    if (result.exitCode !== 0) {
      log(
        t("powerReset.offExpectedFailure", {
          exitCode: result.exitCode ?? t("value.unknown"),
        }),
      );
    }
    return;
  }

  if (result.exitCode !== 0) {
    if (attempt < 2 && isTransientPowerOnError(result.output)) {
      const retryDelay = 500;
      log(
        t("powerReset.retry", {
          attempt: attempt + 1,
          delay: retryDelay,
        }),
      );
      await delayMs(retryDelay);
      await runPowerPass(
        project,
        openOcdPaths,
        state,
        haltAfterPowerOn,
        log,
        powerOutput,
        attempt + 1,
      );
      return;
    }

    throw new Error(
      t("powerReset.passFailed", {
        state,
        exitCode: result.exitCode ?? t("value.unknown"),
        output: truncateOutput(result.output),
      }),
    );
  }
}

function spawnOpenOcdPass(
  executable: string,
  args: string[],
  cwd: string,
): Promise<PowerPassResult> {
  const { promise, resolve, reject } = Promise.withResolvers<PowerPassResult>();
  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let timedOut = false;
  let settled = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, POWER_PASS_TIMEOUT_MS);

  const appendOutput = (chunk: Buffer | string): void => {
    if (output.length >= MAX_CAPTURED_OUTPUT) {
      return;
    }
    output += chunk.toString();
    if (output.length > MAX_CAPTURED_OUTPUT) {
      output = output.slice(0, MAX_CAPTURED_OUTPUT);
    }
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  child.on("error", (error) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    reject(error);
  });

  child.on("close", (exitCode) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve({ exitCode, output, timedOut });
  });

  return promise;
}

function createPowerCycleLogger(
  options: PowerCycleOptions,
): (message: string) => void {
  return (message: string) => {
    options.log?.(message);
  };
}

async function assertFileExists(
  filePath: string,
  message: string,
): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.isFile()) {
      return;
    }
  } catch {
    // 统一使用调用方提供的本地化错误。
  }
  throw new Error(message);
}

function isFatalPowerOffError(output: string): boolean {
  return /invalid command name|wlink open error|unable to open|couldn't open|cannot open|no such file/i.test(
    output,
  );
}

function isTransientPowerOnError(output: string): boolean {
  // WCH-Link 刚关闭电源后可能还没重新枚举完成，稍等重试即可。
  return /unknown wch-link|wlink open error/i.test(output);
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 2_000 ? trimmed.slice(-2_000) : trimmed;
}

function delayMs(delay: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, delay);
  return promise;
}
