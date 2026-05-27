import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DebugProtocol } from "@vscode/debugprotocol";
import {
  parseMiLine,
  getList,
  getString,
  getTuple,
  type MiRecord,
  type MiTuple,
  type MiValue,
} from "./miParser";

type DapMessage = DebugProtocol.Request;
type DapResponse = DebugProtocol.Response;

type LaunchArgs = {
  projectName: string;
  cwd: string;
  sourceRoots?: string[];
  elfPath: string;
  gdbPath: string;
  openOcdPath: string;
  openOcdCwd: string;
  openOcdArgs: string[];
  host: string;
  gdbPort: number;
  startupCommands?: string[];
  stopAt?: string;
  wvprojPath?: string;
};

type SourceBreakpoint = { line: number; column?: number };
type SourceBreakpointState = {
  sourcePath: string;
  requested: SourceBreakpoint[];
  gdbNumbersByLine: Map<number, string>;
};
type VariableReference =
  | { kind: "locals"; frameId: number }
  | { kind: "expression"; frameId?: number; expression: string };

type ResolvedSourceLocation = {
  sourcePath: string;
  line: number;
};

class WchRiscvDebugSession {
  private seq = 1;
  private nextGdbToken = 1;
  private nextFrameId = 1;
  private nextVariableReference = 1;
  private openOcd?: ChildProcessWithoutNullStreams;
  private gdb?: ChildProcessWithoutNullStreams;
  private gdbBuffer = "";
  private dapBuffer = Buffer.alloc(0);
  private launchArgs?: LaunchArgs;
  private readonly pendingCommands = new Map<
    number,
    {
      resolve(record: Extract<MiRecord, { kind: "result" }>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly miRecordWaiters = new Set<(record: MiRecord) => void>();
  private readonly breakpoints = new Map<string, SourceBreakpointState>();
  private readonly stackFrames = new Map<number, MiTuple>();
  private readonly variableReferences = new Map<number, VariableReference>();
  private readonly symbolSourceLocations = new Map<
    string,
    ResolvedSourceLocation | null
  >();
  private readonly symbolInstructionAddresses = new Map<string, number[]>();
  private stopAtBreakpointNumber: string | undefined;
  private configurationDone = false;
  private gdbReady = false;
  private targetRunning = false;
  private suppressNextStoppedEvent = false;
  private suppressedStoppedResults: MiTuple | undefined;
  private terminated = false;
  // 某些旧版 GDB 的 MI 栈帧可能缺少 file/fullname，需要从 stopped 事件或 console 输出中补位置。
  private lastStoppedLocation: { file: string; line: number } | undefined;
  private lastStoppedBreakpointNumber: string | undefined;

  public start(): void {
    process.stdin.on("data", (chunk: Buffer) => this.onDapData(chunk));
    process.stdin.resume();
  }

  private onDapData(chunk: Buffer): void {
    // DAP 走标准 Content-Length 分帧；这里按帧拆包后逐条分发请求。
    this.dapBuffer = Buffer.concat([this.dapBuffer, chunk]);
    while (true) {
      const headerEnd = this.dapBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }

      const header = this.dapBuffer.subarray(0, headerEnd).toString("utf8");
      const length = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!length) {
        return;
      }

      const contentLength = Number.parseInt(length, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.dapBuffer.length < messageEnd) {
        return;
      }

      const message = JSON.parse(
        this.dapBuffer.subarray(messageStart, messageEnd).toString("utf8"),
      ) as DapMessage;
      this.dapBuffer = this.dapBuffer.subarray(messageEnd);
      void this.dispatchRequest(message);
    }
  }

  private async dispatchRequest(request: DapMessage): Promise<void> {
    try {
      switch (request.command) {
        case "initialize":
          this.sendResponse(request, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: false,
            supportsStepBack: false,
          });
          break;
        case "launch":
          await this.handleLaunch(request);
          break;
        case "configurationDone":
          this.configurationDone = true;
          await this.applyAllBreakpoints();
          await this.applyStopAtBreakpoint();
          this.sendResponse(request);
          if (!(await this.stopIfCurrentLocationHasBreakpoint())) {
            await this.continueExecution();
          }
          break;
        case "setBreakpoints":
          await this.handleSetBreakpoints(request);
          break;
        case "threads":
          this.sendResponse(request, { threads: [createThread(1, "main")] });
          break;
        case "stackTrace":
          await this.handleStackTrace(request);
          break;
        case "scopes":
          this.handleScopes(request);
          break;
        case "variables":
          await this.handleVariables(request);
          break;
        case "evaluate":
          await this.handleEvaluate(request);
          break;
        case "continue":
          await this.continueExecution();
          this.sendResponse(request, { allThreadsContinued: true });
          break;
        case "next":
          await this.handleStepRequest(request, "next");
          break;
        case "stepIn":
          await this.handleStepRequest(request, "stepIn");
          break;
        case "stepOut":
          await this.handleStepOutRequest(request);
          break;
        case "pause":
          await this.pauseExecution();
          this.sendResponse(request);
          break;
        case "disconnect":
          await this.disconnect();
          this.sendResponse(request);
          process.exit(0);
          break;
        default:
          this.sendResponse(request);
          break;
      }
    } catch (error) {
      this.sendResponse(request, undefined, false, asErrorMessage(error));
      this.logDebugMessage(asErrorMessage(error), "error");
    }
  }

  private async handleLaunch(request: DapMessage): Promise<void> {
    this.launchArgs = request.arguments as LaunchArgs;
    this.validateLaunchArgs(this.launchArgs);
    this.launchArgs.stopAt = this.resolveCurrentStopAt(this.launchArgs);
    this.logDebugMessage(`Starting debug session: ${this.launchArgs.projectName}`);
    this.logDebugMessage(`Working directory: ${this.launchArgs.cwd}`);
    this.logDebugMessage(`ELF: ${this.launchArgs.elfPath}`);
    this.logDebugMessage(
      `StopAt: ${this.launchArgs.stopAt?.trim() || "<disabled>"}`,
    );

    try {
      await this.startOpenOcd(this.launchArgs);
      await this.startGdb(this.launchArgs);
      await this.initializeGdb(this.launchArgs);
      this.gdbReady = true;
      this.sendResponse(request);
      this.sendEvent("initialized");
    } catch (error) {
      this.sendResponse(request, undefined, false, asErrorMessage(error));
      await this.terminateDebugSession(
        formatOperationFailureMessage("Debug failed", asErrorMessage(error)),
      );
      return;
    }

    if (this.configurationDone) {
      await this.applyAllBreakpoints();
      await this.applyStopAtBreakpoint();
      if (!(await this.stopIfCurrentLocationHasBreakpoint())) {
        await this.continueExecution();
      }
    }
  }

  private resolveCurrentStopAt(args: LaunchArgs): string {
    const wvprojPath = args.wvprojPath?.trim();
    if (!wvprojPath) {
      return args.stopAt?.trim() ?? "";
    }

    try {
      const data = JSON.parse(fs.readFileSync(wvprojPath, "utf8")) as unknown;
      const root = asRecord(data);
      const debugConfigurations = asRecord(root?.debugConfigurations);
      const startup = asRecord(debugConfigurations?.startup);
      const runCommands = asRecord(startup?.runCommands);
      const _setBreak = getBoolean(runCommands?.setBreak);
      const _stopAt = getPlainString(runCommands?.setBreakAt);
      const stopAt = "";
      this.logDebugMessage(
        `Refreshed .wvproj StopAt: ${stopAt || "<disabled>"} (${wvprojPath})`,
      );
      return stopAt;
    } catch (error) {
      this.logDebugMessage(
        `Failed to refresh .wvproj StopAt; using launch configuration: ${asErrorMessage(error)}`,
        "warn",
      );
      return args.stopAt?.trim() ?? "";
    }
  }

  private async handleSetBreakpoints(request: DapMessage): Promise<void> {
    const args = request.arguments ?? {};
    const source = args.source as { path?: string } | undefined;
    const sourcePath = source?.path ?? "";
    const breakpointKey = this.toBreakpointKey(sourcePath);
    const sourceBreakpoints =
      (args.breakpoints as SourceBreakpoint[] | undefined) ?? [];
    const previousState = this.breakpoints.get(breakpointKey);
    this.breakpoints.set(breakpointKey, {
      sourcePath,
      requested: sourceBreakpoints,
      gdbNumbersByLine:
        previousState?.gdbNumbersByLine ?? new Map<number, string>(),
    });

    if (!this.gdbReady || !sourcePath) {
      this.sendResponse(request, {
        breakpoints: sourceBreakpoints.map((breakpoint) =>
          createBreakpoint(false, breakpoint.line),
        ),
      });
      return;
    }

    const wasRunning = this.targetRunning;
    if (wasRunning) {
      await this.pauseExecution(true);
    }

    // 运行中改断点时，先暂停目标，再只替换当前文件的断点。
    const responseBreakpoints = await this.setGdbBreakpoints(
      sourcePath,
      sourceBreakpoints,
    );
    if (wasRunning) {
      await this.continueExecution();
    }
    this.sendResponse(request, { breakpoints: responseBreakpoints });
  }

  private async handleStackTrace(request: DapMessage): Promise<void> {
    // 栈帧来自 GDB MI，先取原始 frame，再补齐 VS Code 需要的绝对路径信息。
    const record = await this.gdbCommand("-stack-list-frames");
    const rawFrames = getList(record.results.stack);
    this.stackFrames.clear();
    const frames: DebugProtocol.StackFrame[] = [];
    for (const rawFrame of rawFrames) {
      const tuple = getTuple(getTuple(rawFrame)?.frame ?? rawFrame);
      if (!tuple) {
        continue;
      }
      const id = this.nextFrameId++;
      this.stackFrames.set(id, tuple);
      const location = this.resolveFrameLocation(tuple);
      frames.push(this.buildStackFrame(id, tuple, location));
    }

    this.sendResponse(request, {
      stackFrames: frames,
      totalFrames: frames.length,
    });
  }

  private buildStackFrame(
    id: number,
    frame: MiTuple,
    location: ResolvedSourceLocation | undefined,
  ): DebugProtocol.StackFrame {
    const sourcePath = location?.sourcePath ?? "";
    const line = this.getDisplayLine(frame, sourcePath, location?.line);
    return {
      id,
      name: this.formatFrameName(frame, sourcePath, line),
      source: this.createSource(sourcePath),
      line,
      column: 1,
    };
  }

  private createSource(
    sourcePath: string,
  ): DebugProtocol.Source | undefined {
    if (!sourcePath) {
      return undefined;
    }

    return {
      name: path.basename(sourcePath),
      path: sourcePath,
      sourceReference: 0,
    };
  }

  private getDisplayLine(
    frame: MiTuple,
    sourcePath: string,
    rawLine =
      Number.parseInt(getString(frame.line), 10) ||
      this.lastStoppedLocation?.line ||
      1,
  ): number {
    if (!this.shouldDisplayStopAtLabelLine() || !sourcePath) {
      return rawLine;
    }

    return (
      this.findSymbolLabelLine(
        sourcePath,
        this.launchArgs?.stopAt?.trim() ?? "",
      ) ?? rawLine
    );
  }

  private formatFrameName(
    frame: MiTuple,
    sourcePath: string,
    line: number,
  ): string {
    const func = getString(frame.func);
    if (func && func !== "??") {
      return func;
    }

    if (sourcePath) {
      return `${path.basename(sourcePath)}:${line}`;
    }

    const address = getString(frame.addr);
    return address ? `<unknown> ${address}` : "<unknown>";
  }

  private resolveFrameSourcePath(frame: MiTuple): string {
    const location = this.resolveFrameLocation(frame);
    if (location?.sourcePath) {
      return location.sourcePath;
    }

    // 优先用 MI 返回的 fullname/file；缺失时再依赖最近一次 stopped 记录。
    const rawPath =
      getString(frame.fullname) ||
      getString(frame.file) ||
      this.lastStoppedLocation?.file ||
      "";
    if (!rawPath) {
      return "";
    }

    return this.resolveSourcePath(rawPath);
  }

  private resolveSourcePath(rawPath: string): string {
    // 相对路径优先按 ELF 所在目录解析，其次按工程根目录解析。
    const normalizedRawPath = path.normalize(rawPath);
    if (path.isAbsolute(normalizedRawPath)) {
      return normalizedRawPath;
    }

    const candidates = [
      path.resolve(
        path.dirname(this.launchArgs?.elfPath ?? ""),
        normalizedRawPath,
      ),
      path.resolve(this.launchArgs?.cwd ?? process.cwd(), normalizedRawPath),
    ];

    const existingPath = candidates.find((candidate) =>
      fs.existsSync(candidate),
    );
    return existingPath ?? candidates[0];
  }

  private handleScopes(request: DapMessage): void {
    const frameId = Number((request.arguments ?? {}).frameId);
    if (!this.stackFrames.has(frameId)) {
      this.sendResponse(request, { scopes: [] });
      return;
    }

    const variablesReference = this.nextVariableReference++;
    this.variableReferences.set(variablesReference, {
      kind: "locals",
      frameId,
    });
    this.sendResponse(request, {
      scopes: [createScope("Locals", variablesReference, false)],
    });
  }

  private async handleVariables(request: DapMessage): Promise<void> {
    const variablesReference = Number(
      (request.arguments ?? {}).variablesReference,
    );
    const reference = this.variableReferences.get(variablesReference);
    if (!reference) {
      this.sendResponse(request, { variables: [] });
      return;
    }

    if (reference.kind === "locals") {
      const record = await this.stackListVariables(reference.frameId);
      this.sendResponse(request, {
        variables: this.parseVariables(getList(record.results.variables)),
      });
      return;
    }

    if (reference.kind === "expression") {
      const record = await this.withSelectedFrame(reference.frameId, () =>
        this.gdbCommand(
          `-data-evaluate-expression ${quoteMiArgument(reference.expression)}`,
        ),
      );
      this.sendResponse(request, {
        variables: [
          createVariable(
            reference.expression,
            getString(record.results.value),
            0,
          ),
        ],
      });
      return;
    }

    this.sendResponse(request, { variables: [] });
  }

  private async handleEvaluate(request: DapMessage): Promise<void> {
    const args = request.arguments as
      | DebugProtocol.EvaluateArguments
      | undefined;
    const expression = args?.expression?.trim() ?? "";
    if (!expression) {
      this.sendResponse(request, { result: "", variablesReference: 0 });
      return;
    }

    try {
      const record = await this.withSelectedFrame(args?.frameId, () =>
        this.gdbCommand(
          `-data-evaluate-expression ${quoteMiArgument(expression)}`,
        ),
      );
      const result = getString(record.results.value);
      this.sendResponse(request, {
        result,
        variablesReference: 0,
      });
    } catch (error) {
      this.sendResponse(request, {
        result: `<${asErrorMessage(error)}>`,
        variablesReference: 0,
      });
    }
  }

  private parseVariables(values: MiValue[]): DebugProtocol.Variable[] {
    return values.flatMap((value) => {
      const tuple = getTuple(value);
      if (!tuple) {
        return [];
      }
      const name = getString(tuple.name);
      const type = getString(tuple.type);
      const variable = createVariable(
        name,
        getString(tuple.value) || type || "<unavailable>",
        0,
      ) as DebugProtocol.Variable;
      variable.type = type || undefined;
      variable.evaluateName = name || undefined;
      return [variable];
    });
  }

  private async withSelectedFrame<T>(
    frameId: number | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (frameId === undefined || !Number.isFinite(frameId)) {
      return action();
    }

    const frame = this.stackFrames.get(frameId);
    const level = getString(frame?.level);
    if (!level) {
      return action();
    }

    await this.gdbCommand(`-stack-select-frame ${level}`);
    return action();
  }

  private async stackListVariables(
    frameId: number,
  ): Promise<Extract<MiRecord, { kind: "result" }>> {
    const frame = this.stackFrames.get(frameId);
    const level = getString(frame?.level);
    if (!level) {
      return this.gdbCommand("-stack-list-variables --all-values");
    }

    try {
      return await this.gdbCommand(
        `-stack-list-variables --thread 1 --frame ${level} --all-values`,
      );
    } catch {
      return this.withSelectedFrame(frameId, () =>
        this.gdbCommand("-stack-list-variables --all-values"),
      );
    }
  }

  private async applyAllBreakpoints(): Promise<void> {
    for (const state of this.breakpoints.values()) {
      if (state.sourcePath) {
        await this.setGdbBreakpoints(state.sourcePath, state.requested);
      }
    }
  }

  private async applyStopAtBreakpoint(): Promise<void> {
    const stopAt = this.launchArgs?.stopAt?.trim();
    if (!stopAt || this.stopAtBreakpointNumber) {
      return;
    }

    this.logDebugMessage(`Setting startup breakpoint: ${stopAt}`);
    const record = await this.gdbCommand(
      `-break-insert -h ${quoteMiArgument(stopAt)}`,
    );
    this.stopAtBreakpointNumber = getString(
      getTuple(record.results.bkpt)?.number,
    );
    this.logDebugMessage(
      `Startup breakpoint number: ${this.stopAtBreakpointNumber || "<unknown>"}`,
    );
  }

  private async stopIfCurrentLocationHasBreakpoint(): Promise<boolean> {
    const record = await this.tryGdbCommandWithRecord("-stack-info-frame");
    const frame = getTuple(record?.results.frame);
    if (!frame) {
      return false;
    }

    const matchedStopAt = this.isCurrentStopAtFrame(frame);
    this.captureStoppedFrame(frame);
    const location = this.resolveFrameLocation(frame);
    const line = location?.line ?? Number.parseInt(getString(frame.line), 10);
    if (!Number.isFinite(line) && !matchedStopAt) {
      return false;
    }

    const sourcePath = location?.sourcePath ?? this.resolveFrameSourcePath(frame);
    const breakpointNumber = Number.isFinite(line)
      ? this.breakpoints
          .get(this.toBreakpointKey(sourcePath))
          ?.gdbNumbersByLine.get(line)
      : undefined;
    if (!breakpointNumber && !matchedStopAt) {
      return false;
    }

    this.lastStoppedBreakpointNumber =
      breakpointNumber || this.stopAtBreakpointNumber;
    const displayLine = this.getDisplayLine(frame, sourcePath, line || 1);
    this.targetRunning = false;
    this.sendEvent("stopped", {
      reason: "breakpoint",
      threadId: 1,
      allThreadsStopped: true,
      source: this.createSource(sourcePath),
      line: displayLine,
    });
    return true;
  }

  private isCurrentStopAtFrame(frame: MiTuple): boolean {
    const stopAt = this.launchArgs?.stopAt?.trim();
    if (!stopAt) {
      return false;
    }

    return getString(frame.func) === stopAt;
  }

  private shouldDisplayStopAtLabelLine(): boolean {
    return Boolean(
      this.stopAtBreakpointNumber &&
      this.lastStoppedBreakpointNumber &&
      this.lastStoppedBreakpointNumber === this.stopAtBreakpointNumber,
    );
  }

  private findSymbolLabelLine(
    sourcePath: string,
    symbol: string,
  ): number | undefined {
    if (!symbol) {
      return undefined;
    }

    try {
      const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
      const labelPattern = new RegExp(`^\\s*${escapeRegExp(symbol)}\\s*:`);
      const index = lines.findIndex((line) => labelPattern.test(line));
      return index >= 0 ? index + 1 : undefined;
    } catch {
      return undefined;
    }
  }

  private async setGdbBreakpoints(
    sourcePath: string,
    sourceBreakpoints: SourceBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    const response: DebugProtocol.Breakpoint[] = [];
    const breakpointKey = this.toBreakpointKey(sourcePath);
    const state = this.breakpoints.get(breakpointKey) ?? {
      sourcePath,
      requested: sourceBreakpoints,
      gdbNumbersByLine: new Map<number, string>(),
    };
    const previousGdbNumbers = [...state.gdbNumbersByLine.values()];
    if (previousGdbNumbers.length > 0) {
      await this.gdbCommand(`-break-delete ${previousGdbNumbers.join(" ")}`);
    }

    const nextGdbNumbersByLine = new Map<number, string>();
    for (const breakpoint of sourceBreakpoints) {
      try {
        const record = await this.gdbCommand(
          `-break-insert -h ${quoteMiArgument(`${sourcePath}:${breakpoint.line}`)}`,
        );
        const number = getString(getTuple(record.results.bkpt)?.number);
        if (number) {
          nextGdbNumbersByLine.set(breakpoint.line, number);
        }
        response.push(createBreakpoint(true, breakpoint.line));
      } catch (error) {
        const failedBreakpoint = createBreakpoint(false, breakpoint.line);
        failedBreakpoint.message = `Failed to set hardware breakpoint: ${asErrorMessage(error)}`;
        response.push(failedBreakpoint);
      }
    }
    this.breakpoints.set(breakpointKey, {
      sourcePath,
      requested: sourceBreakpoints,
      gdbNumbersByLine: nextGdbNumbersByLine,
    });
    return response;
  }

  private async continueExecution(): Promise<void> {
    try {
      await this.gdbCommand("-exec-continue");
      this.markTargetRunning();
      this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
    } catch (error) {
      if (!/running/i.test(asErrorMessage(error))) {
        throw error;
      }
    }
  }

  private async stepExecution(command: string): Promise<MiTuple | undefined> {
    // WCH/OpenOCD 硬件断点在单步时可能继续命中当前地址；删除比禁用更稳定。
    const deletedBreakpointNumbers =
      await this.deleteBreakpointsAtLastStoppedLocation();
    this.suppressNextStoppedEvent = true;
    const stopped = this.createMiRecordWaiter(
      (record) => record.kind === "exec" && record.asyncClass === "stopped",
      30000,
      `GDB step timed out: ${command}`,
    );
    try {
      await this.gdbCommand(command);
      this.markTargetRunning();
      this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
      await stopped.promise;
      const stoppedResults = this.suppressedStoppedResults;
      this.suppressedStoppedResults = undefined;
      return stoppedResults;
    } catch (error) {
      stopped.cancel();
      throw error;
    } finally {
      if (deletedBreakpointNumbers.length > 0) {
        await this.applyAllBreakpoints();
      }
    }
  }

  private async handleStepRequest(
    request: DapMessage,
    kind: "next" | "stepIn",
  ): Promise<void> {
    // VS Code 期望先收到单步请求响应，再收到 stopped 事件，否则可能提前拉取旧栈帧。
    const stoppedResults = await this.runStep(kind);
    this.sendResponse(request);
    if (stoppedResults) {
      this.sendStoppedEvent(stoppedResults);
    }
  }

  private async handleStepOutRequest(request: DapMessage): Promise<void> {
    const stack = await this.gdbCommand("-stack-list-frames");
    if (getList(stack.results.stack).length <= 1) {
      throw new Error("Cannot step out because the current frame is already the outermost frame");
    }

    const stoppedResults = await this.stepExecution("-exec-finish");
    this.sendResponse(request);
    if (stoppedResults) {
      this.sendStoppedEvent(stoppedResults);
    }
  }

  private async runStep(kind: "next" | "stepIn"): Promise<MiTuple | undefined> {
    const sourcePath = await this.resolveCurrentStoppedSourcePath();
    const useInstructionStep = sourcePath
      ? isAssemblySourcePath(sourcePath)
      : false;
    const command = useInstructionStep
      ? kind === "next"
        ? "-exec-next-instruction"
        : "-exec-step-instruction"
      : kind === "next"
        ? "-exec-next"
        : "-exec-step";
    this.logDebugMessage(
      `Step command: ${command}${sourcePath ? ` (${sourcePath})` : ""}`,
    );
    return this.stepExecution(command);
  }

  private async resolveCurrentStoppedSourcePath(): Promise<string> {
    if (this.lastStoppedLocation?.file) {
      return this.resolveSourcePath(this.lastStoppedLocation.file);
    }

    const record = await this.tryGdbCommandWithRecord("-stack-info-frame");
    const frame = getTuple(record?.results.frame);
    return frame ? this.resolveFrameSourcePath(frame) : "";
  }

  private async pauseExecution(suppressStoppedEvent = false): Promise<void> {
    if (!this.targetRunning) {
      return;
    }

    const stopped = this.createMiRecordWaiter(
      (record) => record.kind === "exec" && record.asyncClass === "stopped",
      10000,
      "GDB pause timed out",
    );
    try {
      this.suppressNextStoppedEvent = suppressStoppedEvent;
      await this.gdbCommand("-exec-interrupt");
      await stopped.promise;
    } catch (error) {
      stopped.cancel();
      throw error;
    }
  }

  private async startOpenOcd(args: LaunchArgs): Promise<void> {
    this.logDebugMessage(
      `OpenOCD: ${args.openOcdPath} ${args.openOcdArgs.join(" ")}`,
    );
    this.openOcd = spawn(args.openOcdPath, args.openOcdArgs, {
      cwd: args.openOcdCwd,
    });
    this.logDebugMessage(`OpenOCD PID: ${this.openOcd.pid ?? "<unknown>"}`);
    this.openOcd.stdout.on("data", (chunk: Buffer) =>
      this.sendOutput(chunk.toString("utf8")),
    );
    this.openOcd.stderr.on("data", (chunk: Buffer) =>
      this.sendOutput(chunk.toString("utf8")),
    );
    await new Promise<void>((resolve, reject) => {
      let startupSettled = false;
      const timer = setTimeout(() => {
        startupSettled = true;
        resolve();
      }, 1200);
      this.openOcd?.once("exit", (code) => {
        clearTimeout(timer);
        if (!startupSettled) {
          startupSettled = true;
          reject(new Error(`OpenOCD failed to start; exit code: ${formatExitCode(code)}`));
          return;
        }

        void this.terminateDebugSession(
          formatOperationFailureMessage(
            "Debug failed",
            `OpenOCD exited; exit code: ${formatExitCode(code)}`,
          ),
        );
      });
      this.openOcd?.once("error", (error) => {
        clearTimeout(timer);
        if (!startupSettled) {
          startupSettled = true;
          reject(error);
          return;
        }

        void this.terminateDebugSession(
          formatOperationFailureMessage(
            "Debug failed",
            `OpenOCD error: ${error.message}`,
          ),
        );
      });
    });
  }

  private async startGdb(args: LaunchArgs): Promise<void> {
    this.logDebugMessage(`GDB: ${args.gdbPath} --interpreter=mi2`);
    this.gdb = spawn(args.gdbPath, ["--interpreter=mi2"], { cwd: args.cwd });
    this.logDebugMessage(`GDB PID: ${this.gdb.pid ?? "<unknown>"}`);
    this.gdb.stdout.on("data", (chunk: Buffer) => this.onGdbData(chunk));
    this.gdb.stderr.on("data", (chunk: Buffer) =>
      this.sendOutput(chunk.toString("utf8")),
    );
    this.gdb.once("exit", (code) => {
      this.logDebugMessage(`GDB exited: ${formatExitCode(code)}`);
      if (!this.terminated) {
        this.sendEvent("terminated");
        this.terminated = true;
      }
    });
    await this.waitForMiRecord(
      (record) => record.kind === "prompt",
      15000,
      "GDB startup timed out",
    );
  }

  private async initializeGdb(args: LaunchArgs): Promise<void> {
    this.logDebugMessage("Initializing GDB: enabling target-async");
    await this.gdbCommand("-gdb-set target-async on");
    this.logDebugMessage("Initializing GDB: loading ELF symbols");
    await this.gdbCommand(
      `-file-exec-and-symbols ${quoteMiArgument(args.elfPath)}`,
    );
    this.logDebugMessage(`Initializing GDB: connecting to ${args.host}:${args.gdbPort}`);
    await this.gdbCommand(
      `-target-select extended-remote ${args.host}:${args.gdbPort}`,
    );
    this.logDebugMessage("Initializing GDB: reset halt");
    await this.gdbCommand(
      `-interpreter-exec console ${quoteMiArgument("monitor reset halt")}`,
    );
    this.logDebugMessage("Initializing GDB: downloading program to target");
    await this.gdbCommand("-target-download");
    for (const command of args.startupCommands ?? []) {
      if (command.trim()) {
        this.logDebugMessage(`Running startup command: ${command}`);
        await this.gdbCommand(
          `-interpreter-exec console ${quoteMiArgument(command)}`,
        );
      }
    }
  }

  private onGdbData(chunk: Buffer): void {
    // GDB MI 按行输出；先拆出完整行，再把残留的 (gdb) prompt 单独识别出来。
    this.gdbBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = this.gdbBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.gdbBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.gdbBuffer = this.gdbBuffer.slice(newlineIndex + 1);
      if (line) {
        this.onMiRecord(parseMiLine(line));
      }
    }

    if (this.gdbBuffer.trim() === "(gdb)") {
      this.gdbBuffer = "";
      this.onMiRecord({ kind: "prompt", raw: "(gdb)" });
    }
  }

  private onMiRecord(record: MiRecord): void {
    // 先让等待中的命令和事件监听器都看到这条记录，再按记录类型分类处理。
    for (const waiter of [...this.miRecordWaiters]) {
      waiter(record);
    }

    if (
      record.kind === "console" ||
      record.kind === "target" ||
      record.kind === "log"
    ) {
      this.captureStoppedLocation(record.text);
      this.sendOutput(record.text);
      return;
    }
    if (record.kind === "exec" && record.asyncClass === "running") {
      this.markTargetRunning();
      return;
    }
    if (record.kind === "exec" && record.asyncClass === "stopped") {
      this.sendStoppedEvent(record.results);
      return;
    }
    if (record.kind !== "result" || record.token === undefined) {
      return;
    }

    const pending = this.pendingCommands.get(record.token);
    if (!pending) {
      return;
    }

    this.pendingCommands.delete(record.token);
    clearTimeout(pending.timer);
    if (record.resultClass === "error") {
      pending.reject(new Error(getString(record.results.msg) || record.raw));
      return;
    }
    if (record.resultClass === "running") {
      this.markTargetRunning();
    }
    pending.resolve(record);
  }

  private waitForMiRecord(
    predicate: (record: MiRecord) => boolean,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    return this.createMiRecordWaiter(predicate, timeoutMs, timeoutMessage)
      .promise;
  }

  private createMiRecordWaiter(
    predicate: (record: MiRecord) => boolean,
    timeoutMs: number,
    timeoutMessage: string,
  ): { promise: Promise<void>; cancel(): void } {
    // 用于等待某类 MI 事件到达，比如 prompt、stopped 或某条命令的结束响应。
    let timer: NodeJS.Timeout | undefined;
    let waiter: ((record: MiRecord) => void) | undefined;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (waiter) {
        this.miRecordWaiters.delete(waiter);
      }
    };
    const promise = new Promise<void>((resolve, reject) => {
      waiter = (record: MiRecord) => {
        if (!predicate(record)) {
          return;
        }

        cancel();
        resolve();
      };
      timer = setTimeout(() => {
        if (waiter) {
          this.miRecordWaiters.delete(waiter);
        }
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.miRecordWaiters.add(waiter);
    });

    return { promise, cancel };
  }

  private sendStoppedEvent(results: MiTuple): void {
    this.targetRunning = false;
    this.lastStoppedBreakpointNumber =
      getString(results.bkptno) || this.lastStoppedBreakpointNumber;
    const frame = getTuple(results.frame);
    if (this.suppressNextStoppedEvent) {
      this.suppressNextStoppedEvent = false;
      this.suppressedStoppedResults = results;
      if (frame) {
        this.captureStoppedFrame(frame);
      }
      return;
    }

    const reason = getString(results.reason);
    if (frame) {
      this.captureStoppedFrame(frame);
    }
    const location = frame ? this.resolveFrameLocation(frame) : undefined;
    const sourcePath = location?.sourcePath ?? (frame ? this.resolveFrameSourcePath(frame) : "");
    const line = frame
      ? this.getDisplayLine(frame, sourcePath, location?.line ?? 1)
      : this.lastStoppedLocation?.line;
    this.sendEvent("stopped", {
      reason: toDapStoppedReason(reason),
      threadId: 1,
      allThreadsStopped: true,
      source: this.createSource(sourcePath),
      line,
    });
  }

  private markTargetRunning(): void {
    this.targetRunning = true;
    this.lastStoppedLocation = undefined;
    this.lastStoppedBreakpointNumber = undefined;
  }

  private async deleteBreakpointsAtLastStoppedLocation(): Promise<string[]> {
    if (this.lastStoppedBreakpointNumber) {
      this.logDebugMessage(
        `Deleting current breakpoint before step: ${this.lastStoppedBreakpointNumber}`,
      );
      await this.gdbCommand(
        `-break-delete ${this.lastStoppedBreakpointNumber}`,
      );
      if (this.lastStoppedBreakpointNumber === this.stopAtBreakpointNumber) {
        this.stopAtBreakpointNumber = undefined;
      }
      this.removeBreakpointNumberFromState(this.lastStoppedBreakpointNumber);
      return [this.lastStoppedBreakpointNumber];
    }

    if (!this.lastStoppedLocation) {
      return [];
    }

    const sourcePath = this.resolveSourcePath(this.lastStoppedLocation.file);
    const breakpointNumber = this.breakpoints
      .get(this.toBreakpointKey(sourcePath))
      ?.gdbNumbersByLine.get(this.lastStoppedLocation.line);
    if (!breakpointNumber) {
      return [];
    }

    this.logDebugMessage(
      `Deleting current breakpoint before step: ${breakpointNumber} ${sourcePath}:${this.lastStoppedLocation.line}`,
    );
    await this.gdbCommand(`-break-delete ${breakpointNumber}`);
    this.removeBreakpointNumberFromState(breakpointNumber);
    return [breakpointNumber];
  }

  private removeBreakpointNumberFromState(breakpointNumber: string): void {
    for (const state of this.breakpoints.values()) {
      for (const [line, number] of state.gdbNumbersByLine) {
        if (number === breakpointNumber) {
          state.gdbNumbersByLine.delete(line);
        }
      }
    }
  }

  private toBreakpointKey(sourcePath: string): string {
    // Windows 下路径大小写不敏感，统一 key 便于同一文件的断点状态复用。
    const normalizedPath = path.normalize(sourcePath);
    return process.platform === "win32"
      ? normalizedPath.toLowerCase()
      : normalizedPath;
  }

  private captureStoppedLocation(text: string): void {
    // console 流里常有 “Breakpoint 1, ... at ../User/main.c:65”，作为 MI 缺字段时的兜底。
    const breakpointMatch = /\bBreakpoint\s+(\d+)\b/.exec(text);
    if (breakpointMatch) {
      this.lastStoppedBreakpointNumber = breakpointMatch[1];
    }

    const atMatch = /\bat\s+(.+):(\d+)\s*$/m.exec(text);
    if (!atMatch) {
      return;
    }

    this.lastStoppedLocation = {
      file: atMatch[1].trim(),
      line: Number.parseInt(atMatch[2], 10),
    };
  }

  private captureStoppedFrame(frame: MiTuple): void {
    // stopped 事件里如果带了 frame，就用它覆盖 console 兜底位置，精度更高。
    const location = this.resolveFrameLocation(frame, false);
    if (!location) {
      return;
    }

    this.lastStoppedLocation = {
      file: location.sourcePath,
      line: location.line,
    };
  }

  private resolveFrameLocation(
    frame: MiTuple,
    allowLastStoppedFallback = true,
  ): ResolvedSourceLocation | undefined {
    const rawPath = getString(frame.fullname) || getString(frame.file);
    const line = Number.parseInt(getString(frame.line), 10);
    if (rawPath && Number.isFinite(line)) {
      return {
        sourcePath: this.resolveSourcePath(rawPath),
        line,
      };
    }

    const func = getString(frame.func);
    const address = getString(frame.addr);
    if (func && func !== "??") {
      const resolvedFromSymbol = this.resolveSourceLocationFromSymbol(
        func,
        address,
      );
      if (resolvedFromSymbol) {
        return resolvedFromSymbol;
      }
    }

    if (!allowLastStoppedFallback || !this.lastStoppedLocation) {
      return undefined;
    }

    return {
      sourcePath: this.resolveSourcePath(this.lastStoppedLocation.file),
      line: this.lastStoppedLocation.line,
    };
  }

  private resolveSourceLocationFromSymbol(
    symbol: string,
    address = "",
  ): ResolvedSourceLocation | undefined {
    const normalizedSymbol = symbol.trim();
    if (!normalizedSymbol) {
      return undefined;
    }

    if (this.symbolSourceLocations.has(normalizedSymbol)) {
      return this.symbolSourceLocations.get(normalizedSymbol) ?? undefined;
    }

    const sourceRoots = this.getSourceRoots();
    if (sourceRoots.length === 0) {
      this.symbolSourceLocations.set(normalizedSymbol, null);
      return undefined;
    }

    const sourcePath = sourceRoots
      .map((rootPath) => this.findSourceFileContainingSymbol(rootPath, normalizedSymbol))
      .find((value): value is string => Boolean(value));
    if (!sourcePath) {
      this.symbolSourceLocations.set(normalizedSymbol, null);
      return undefined;
    }

    const line = this.resolveSourceLineFromAssemblyAddress(
      sourcePath,
      normalizedSymbol,
      address,
    ) ?? this.findSymbolLabelLine(sourcePath, normalizedSymbol);
    if (!line) {
      this.symbolSourceLocations.set(normalizedSymbol, null);
      return undefined;
    }

    const location = { sourcePath, line };
    this.symbolSourceLocations.set(normalizedSymbol, location);
    return location;
  }

  private findSourceFileContainingSymbol(
    rootPath: string,
    symbol: string,
  ): string | undefined {
    const pending = [rootPath];
    while (pending.length > 0) {
      const currentPath = pending.pop();
      if (!currentPath) {
        continue;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          if (!shouldScanSourceDirectory(entry.name)) {
            continue;
          }
          pending.push(fullPath);
          continue;
        }

        if (!entry.isFile() || !isSourceLookupCandidate(fullPath)) {
          continue;
        }

        if (this.findSymbolLabelLine(fullPath, symbol)) {
          return fullPath;
        }
      }
    }

    return undefined;
  }

  private getSourceRoots(): string[] {
    const configuredRoots = this.launchArgs?.sourceRoots ?? [];
    const roots = configuredRoots.length > 0
      ? configuredRoots
      : [this.launchArgs?.cwd ?? process.cwd()];
    return Array.from(new Set(
      roots
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && fs.existsSync(value)),
    ));
  }

  private resolveSourceLineFromAssemblyAddress(
    sourcePath: string,
    symbol: string,
    address: string,
  ): number | undefined {
    if (!address || !isAssemblySourcePath(sourcePath)) {
      return undefined;
    }

    const instructionAddresses = this.resolveSymbolInstructionAddresses(symbol);
    if (!instructionAddresses || instructionAddresses.length === 0) {
      return undefined;
    }

    const currentAddress = parseHexAddress(address);
    if (currentAddress === undefined) {
      return undefined;
    }

    const instructionIndex = instructionAddresses.findIndex(
      (value) => value === currentAddress,
    );
    if (instructionIndex < 0) {
      return undefined;
    }

    const instructionLines = this.buildAssemblyInstructionLineMap(
      sourcePath,
      symbol,
    );
    if (instructionLines.length === 0) {
      return undefined;
    }

    return instructionLines[
      Math.min(instructionIndex, instructionLines.length - 1)
    ];
  }

  private resolveSymbolInstructionAddresses(symbol: string): number[] | undefined {
    const cached = this.symbolInstructionAddresses.get(symbol);
    if (cached) {
      return cached;
    }

    const gdbPath = this.launchArgs?.gdbPath ?? "";
    const elfPath = this.launchArgs?.elfPath ?? "";
    if (!gdbPath || !elfPath) {
      return undefined;
    }

    const result = spawnSync(
      gdbPath,
      ["-batch", elfPath, "-ex", `disassemble ${symbol}`],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) {
      return undefined;
    }

    const addresses = result.stdout
      .split(/\r?\n/)
      .map((line) => /0x([0-9a-fA-F]+)/.exec(line)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number.parseInt(value, 16));
    if (addresses.length === 0) {
      return undefined;
    }

    this.symbolInstructionAddresses.set(symbol, addresses);
    return addresses;
  }

  private buildAssemblyInstructionLineMap(
    sourcePath: string,
    symbol: string,
  ): number[] {
    try {
      const lines = fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
      const labelLine = this.findSymbolLabelLine(sourcePath, symbol);
      if (!labelLine) {
        return [];
      }

      const instructionLines: number[] = [];
      for (let index = labelLine; index < lines.length; index++) {
        const currentLineNumber = index + 1;
        const currentLine = lines[index].trim();
        if (currentLineNumber > labelLine && /^[A-Za-z_.$][\w.$]*\s*:$/.test(currentLine)) {
          break;
        }

        const instructionCount = estimateAssemblyInstructionCount(currentLine);
        for (let count = 0; count < instructionCount; count++) {
          instructionLines.push(currentLineNumber);
        }
      }

      return instructionLines;
    } catch {
      return [];
    }
  }

  private gdbCommand(
    command: string,
  ): Promise<Extract<MiRecord, { kind: "result" }>> {
    if (!this.gdb) {
      return Promise.reject(new Error("GDB has not started"));
    }

    const token = this.nextGdbToken++;
    this.gdb.stdin.write(`${token}${command}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommands.delete(token)) {
          reject(new Error(`GDB command timed out: ${command}`));
        }
      }, 30000);
      this.pendingCommands.set(token, { resolve, reject, timer });
    });
  }

  private async disconnect(): Promise<void> {
    this.terminated = true;
    try {
      if (this.gdb && !this.gdb.killed) {
        // VS Code 停止调试时，先把 MCU 从调试态恢复到上电运行态，再退出 GDB。
        await this.resetTargetBeforeDisconnect();
        await this.gdbCommand("-gdb-exit");
      }
    } catch {
      this.gdb?.kill();
    }
    if (this.openOcd && !this.openOcd.killed) {
      this.openOcd.kill();
    }
  }

  private async terminateDebugSession(message: string): Promise<void> {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.logDebugMessage(message, "error");
    if (this.gdb && !this.gdb.killed) {
      this.gdb.kill();
    }
    if (this.openOcd && !this.openOcd.killed) {
      this.openOcd.kill();
    }
    this.sendEvent("terminated");
  }

  private async resetTargetBeforeDisconnect(): Promise<void> {
    // 先清掉本次会话插入的硬件断点，否则复位后可能立刻再次停在用户断点。
    await this.tryGdbCommand("-break-delete");

    // WCH OpenOCD 对 reset run 的行为不够稳定，因此采用 reset halt 再 resume 的组合。
    if (
      await this.tryGdbCommand(
        `-interpreter-exec console ${quoteMiArgument("monitor reset halt")}`,
      )
    ) {
      await this.tryGdbCommand(
        `-interpreter-exec console ${quoteMiArgument("monitor resume")}`,
      );
      this.markTargetRunning();
      return;
    }

    // 老配置如果不支持 reset halt，则退回普通 reset 再继续运行。
    await this.tryGdbCommand(
      `-interpreter-exec console ${quoteMiArgument("monitor reset")}`,
    );
    if (await this.tryGdbCommand("-exec-continue")) {
      this.markTargetRunning();
    }
  }

  private async tryGdbCommand(command: string): Promise<boolean> {
    try {
      await this.gdbCommand(command);
      return true;
    } catch (error) {
      // 目标已经在运行时，GDB 可能回报 running；对恢复运行流程来说这仍然算成功。
      if (/running/i.test(asErrorMessage(error))) {
        return true;
      }
      return false;
    }
  }

  private async tryGdbCommandWithRecord(
    command: string,
  ): Promise<Extract<MiRecord, { kind: "result" }> | undefined> {
    try {
      return await this.gdbCommand(command);
    } catch {
      return undefined;
    }
  }

  private validateLaunchArgs(args: LaunchArgs): void {
    for (const key of [
      "elfPath",
      "gdbPath",
      "openOcdPath",
      "cwd",
      "openOcdCwd",
      "host",
    ] as const) {
      if (!args[key]) {
        throw new Error(`Debug configuration is missing ${key}`);
      }
    }
    if (!Number.isFinite(args.gdbPort) || args.gdbPort <= 0) {
      throw new Error("Debug configuration is missing a valid GDB port");
    }
  }

  private sendResponse(
    request: DapMessage,
    body?: unknown,
    success = true,
    message?: string,
  ): void {
    const response: DapResponse = {
      type: "response",
      seq: this.seq++,
      request_seq: request.seq,
      success,
      command: request.command,
      message,
      body,
    };
    this.send(response);
  }

  private sendEvent(event: string, body?: unknown): void {
    this.send({ type: "event", seq: this.seq++, event, body });
  }

  private sendOutput(output: string): void {
    if (!output) {
      return;
    }
    const normalizedOutput =
      output.endsWith("\n") || output.endsWith("\r") ? output : `${output}\n`;
    this.sendEvent("output", { category: "console", output: normalizedOutput });
  }

  private logDebugMessage(
    message: string,
    level: "info" | "warn" | "error" = "info",
  ): void {
    const levelPrefix = level === "info" ? "" : `[${level.toUpperCase()}] `;
    this.sendOutput(`[WCH Debug] ${levelPrefix}${message}`);
  }

  private send(message: unknown): void {
    const json = JSON.stringify(message);
    process.stdout.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }
}

function quoteMiArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function normalizeStopAt(value: string): string {
  const normalizedValue = value.trim();
  return normalizedValue === "handle_reset" ? "" : normalizedValue;
}

function createThread(id: number, name: string): DebugProtocol.Thread {
  return { id, name };
}

function createBreakpoint(
  verified: boolean,
  line: number,
): DebugProtocol.Breakpoint {
  return { verified, line };
}

function createScope(
  name: string,
  variablesReference: number,
  expensive: boolean,
): DebugProtocol.Scope {
  return { name, variablesReference, expensive };
}

function createVariable(
  name: string | null,
  value: string | null,
  variablesReference: number,
): DebugProtocol.Variable {
  return {
    name: name ?? "",
    value: value ?? "",
    variablesReference,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAssemblySourcePath(sourcePath: string): boolean {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension === ".s" || extension === ".asm";
}

function parseHexAddress(value: string): number | undefined {
  const match = /^0x([0-9a-fA-F]+)$/.exec(value.trim());
  return match ? Number.parseInt(match[1], 16) : undefined;
}

function estimateAssemblyInstructionCount(line: string): number {
  const trimmedLine = line
    .replace(/\/\*.*?\*\//g, "")
    .replace(/[#;].*$/g, "")
    .trim();
  if (!trimmedLine) {
    return 0;
  }

  if (
    trimmedLine.startsWith(".") ||
    /^[A-Za-z_.$][\w.$]*\s*:$/.test(trimmedLine)
  ) {
    return 0;
  }

  const opcode = trimmedLine.split(/\s+/, 1)[0].toLowerCase();
  switch (opcode) {
    case "la":
    case "call":
    case "tail":
      return 2;
    default:
      return 1;
  }
}

function isSourceLookupCandidate(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".s" || extension === ".asm" || extension === ".S".toLowerCase();
}

function shouldScanSourceDirectory(directoryName: string): boolean {
  const normalizedName = directoryName.toLowerCase();
  return normalizedName !== ".git" &&
    normalizedName !== ".vscode" &&
    normalizedName !== "obj" &&
    normalizedName !== "bin" &&
    normalizedName !== "out";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function getPlainString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExitCode(code: number | null): string {
  return code === null ? "unknown" : String(code);
}

function formatOperationFailureMessage(
  operation: string,
  detail: string,
): string {
  const hint = /OpenOCD/i.test(detail)
    ? ". Check whether the debugger is already in use and verify the WCH-Link and target board connection."
    : "";
  return `${operation}: ${detail}${hint}`;
}

function toDapStoppedReason(gdbReason: string): string {
  switch (gdbReason) {
    case "breakpoint-hit":
      return "breakpoint";
    case "end-stepping-range":
    case "function-finished":
      return "step";
    case "signal-received":
      return "exception";
    default:
      return gdbReason || "pause";
  }
}

new WchRiscvDebugSession().start();
