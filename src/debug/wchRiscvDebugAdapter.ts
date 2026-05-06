import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Breakpoint, Scope, Thread, Variable } from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { parseMiLine, getList, getString, getTuple, type MiRecord, type MiTuple, type MiValue } from "./miParser";

type DapMessage = DebugProtocol.Request;
type DapResponse = DebugProtocol.Response;

type LaunchArgs = {
  projectName: string;
  cwd: string;
  elfPath: string;
  gdbPath: string;
  openOcdPath: string;
  openOcdCwd: string;
  openOcdArgs: string[];
  host: string;
  gdbPort: number;
  startupCommands?: string[];
};

type SourceBreakpoint = { line: number; column?: number };
type SourceBreakpointState = {
  sourcePath: string;
  requested: SourceBreakpoint[];
  gdbNumbersByLine: Map<number, string>;
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
  private readonly pendingCommands = new Map<number, {
    resolve(record: Extract<MiRecord, { kind: "result" }>): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private readonly miRecordWaiters = new Set<(record: MiRecord) => void>();
  private readonly breakpoints = new Map<string, SourceBreakpointState>();
  private readonly stackFrames = new Map<number, MiTuple>();
  private readonly variableReferences = new Map<number, { frameId?: number; expression?: string; locals?: boolean }>();
  private configurationDone = false;
  private gdbReady = false;
  private targetRunning = false;
  private suppressNextStoppedEvent = false;
  private suppressedStoppedResults: MiTuple | undefined;
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

      const message = JSON.parse(this.dapBuffer.subarray(messageStart, messageEnd).toString("utf8")) as DapMessage;
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
          await this.continueExecution();
          this.sendResponse(request);
          break;
        case "setBreakpoints":
          await this.handleSetBreakpoints(request);
          break;
        case "threads":
          this.sendResponse(request, { threads: [new Thread(1, "main")] });
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
        case "continue":
          await this.continueExecution();
          this.sendResponse(request, { allThreadsContinued: true });
          break;
        case "next":
          await this.handleStepRequest(request, "-exec-next");
          break;
        case "stepIn":
          await this.handleStepRequest(request, "-exec-step");
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
      this.sendOutput(asErrorMessage(error));
    }
  }

  private async handleLaunch(request: DapMessage): Promise<void> {
    this.launchArgs = request.arguments as LaunchArgs;
    this.validateLaunchArgs(this.launchArgs);
    this.sendResponse(request);

    await this.startOpenOcd(this.launchArgs);
    await this.startGdb(this.launchArgs);
    await this.initializeGdb(this.launchArgs);
    this.gdbReady = true;
    this.sendEvent("initialized");

    if (this.configurationDone) {
      await this.applyAllBreakpoints();
      await this.continueExecution();
    }
  }

  private async handleSetBreakpoints(request: DapMessage): Promise<void> {
    const args = request.arguments ?? {};
    const source = args.source as { path?: string } | undefined;
    const sourcePath = source?.path ?? "";
    const breakpointKey = this.toBreakpointKey(sourcePath);
    const sourceBreakpoints = (args.breakpoints as SourceBreakpoint[] | undefined) ?? [];
    const previousState = this.breakpoints.get(breakpointKey);
    this.breakpoints.set(breakpointKey, {
      sourcePath,
      requested: sourceBreakpoints,
      gdbNumbersByLine: previousState?.gdbNumbersByLine ?? new Map<number, string>(),
    });

    if (!this.gdbReady || !sourcePath) {
      this.sendResponse(request, {
        breakpoints: sourceBreakpoints.map((breakpoint) => new Breakpoint(false, breakpoint.line)),
      });
      return;
    }

    const wasRunning = this.targetRunning;
    if (wasRunning) {
      await this.pauseExecution(true);
    }

    // 运行中改断点时，先暂停目标，再只替换当前文件的断点。
    const responseBreakpoints = await this.setGdbBreakpoints(sourcePath, sourceBreakpoints);
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
      const sourcePath = this.resolveFrameSourcePath(tuple);
      frames.push(this.buildStackFrame(id, tuple, sourcePath));
    }

    this.sendResponse(request, { stackFrames: frames, totalFrames: frames.length });
  }

  private buildStackFrame(
    id: number,
    frame: MiTuple,
    sourcePath: string,
  ): DebugProtocol.StackFrame {
    return {
      id,
      name: getString(frame.func) || "<unknown>",
      source: sourcePath
        ? {
            name: path.basename(sourcePath),
            path: sourcePath,
            sourceReference: 0,
          }
        : undefined,
      line: Number.parseInt(getString(frame.line), 10) || this.lastStoppedLocation?.line || 1,
      column: 1,
    };
  }

  private resolveFrameSourcePath(frame: MiTuple): string {
    // 优先用 MI 返回的 fullname/file；缺失时再依赖最近一次 stopped 记录。
    const rawPath = getString(frame.fullname) || getString(frame.file) || this.lastStoppedLocation?.file || "";
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
      path.resolve(path.dirname(this.launchArgs?.elfPath ?? ""), normalizedRawPath),
      path.resolve(this.launchArgs?.cwd ?? process.cwd(), normalizedRawPath),
    ];

    const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
    return existingPath ?? candidates[0];
  }

  private handleScopes(request: DapMessage): void {
    const frameId = Number((request.arguments ?? {}).frameId);
    const variablesReference = this.nextVariableReference++;
    this.variableReferences.set(variablesReference, { frameId, locals: true });
    this.sendResponse(request, {
      scopes: [new Scope("Locals", variablesReference, false)],
    });
  }

  private async handleVariables(request: DapMessage): Promise<void> {
    const variablesReference = Number((request.arguments ?? {}).variablesReference);
    const reference = this.variableReferences.get(variablesReference);
    if (!reference) {
      this.sendResponse(request, { variables: [] });
      return;
    }

    if (reference.locals) {
      const record = await this.gdbCommand("-stack-list-variables --simple-values");
      this.sendResponse(request, { variables: this.parseVariables(getList(record.results.variables)) });
      return;
    }

    if (reference.expression) {
      const record = await this.gdbCommand(`-data-evaluate-expression ${quoteMiArgument(reference.expression)}`);
      this.sendResponse(request, {
        variables: [new Variable(reference.expression, getString(record.results.value), 0)],
      });
      return;
    }

    this.sendResponse(request, { variables: [] });
  }

  private parseVariables(values: MiValue[]): DebugProtocol.Variable[] {
    return values.flatMap((value) => {
      const tuple = getTuple(value);
      if (!tuple) {
        return [];
      }
      return [new Variable(
        getString(tuple.name),
        getString(tuple.value) || getString(tuple.type),
        0,
      )];
    });
  }

  private async applyAllBreakpoints(): Promise<void> {
    for (const state of this.breakpoints.values()) {
      if (state.sourcePath) {
        await this.setGdbBreakpoints(state.sourcePath, state.requested);
      }
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
        const record = await this.gdbCommand(`-break-insert -h ${quoteMiArgument(`${sourcePath}:${breakpoint.line}`)}`);
        const number = getString(getTuple(record.results.bkpt)?.number);
        if (number) {
          nextGdbNumbersByLine.set(breakpoint.line, number);
        }
        response.push(new Breakpoint(true, breakpoint.line));
      } catch (error) {
        const failedBreakpoint = new Breakpoint(false, breakpoint.line) as DebugProtocol.Breakpoint;
        failedBreakpoint.message = `硬件断点设置失败：${asErrorMessage(error)}`;
        response.push(failedBreakpoint);
      }
    }
    this.breakpoints.set(breakpointKey, { sourcePath, requested: sourceBreakpoints, gdbNumbersByLine: nextGdbNumbersByLine });
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

  private async stepExecution(command: string): Promise<void> {
    // WCH/OpenOCD 硬件断点在单步时可能继续命中当前地址；删除比禁用更稳定。
    const deletedBreakpointNumbers = await this.deleteBreakpointsAtLastStoppedLocation();
    this.suppressNextStoppedEvent = true;
    const stopped = this.createMiRecordWaiter(
      (record) => record.kind === "exec" && record.asyncClass === "stopped",
      30000,
      `GDB 单步超时：${command}`,
    );
    try {
      await this.gdbCommand(command);
      this.markTargetRunning();
      this.sendEvent("continued", { threadId: 1, allThreadsContinued: true });
      await stopped.promise;
    } catch (error) {
      stopped.cancel();
      throw error;
    } finally {
      if (deletedBreakpointNumbers.length > 0) {
        await this.applyAllBreakpoints();
      }
    }
  }

  private async handleStepRequest(request: DapMessage, command: string): Promise<void> {
    // VS Code 期望先收到单步请求响应，再收到 stopped 事件，否则可能提前拉取旧栈帧。
    await this.stepExecution(command);
    this.sendResponse(request);
    const stoppedResults = this.suppressedStoppedResults;
    this.suppressedStoppedResults = undefined;
    if (stoppedResults) {
      this.sendStoppedEvent(stoppedResults);
    }
  }

  private async handleStepOutRequest(request: DapMessage): Promise<void> {
    const stack = await this.gdbCommand("-stack-list-frames");
    if (getList(stack.results.stack).length <= 1) {
      throw new Error("当前已经在最外层栈帧，无法单步跳出");
    }

    await this.handleStepRequest(request, "-exec-finish");
  }

  private async pauseExecution(suppressStoppedEvent = false): Promise<void> {
    if (!this.targetRunning) {
      return;
    }

    const stopped = this.createMiRecordWaiter(
      (record) => record.kind === "exec" && record.asyncClass === "stopped",
      10000,
      "GDB 暂停超时",
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
    this.sendOutput(`OpenOCD: ${args.openOcdPath} ${args.openOcdArgs.join(" ")}`);
    this.openOcd = spawn(args.openOcdPath, args.openOcdArgs, { cwd: args.openOcdCwd });
    this.openOcd.stdout.on("data", (chunk: Buffer) => this.sendOutput(chunk.toString("utf8")));
    this.openOcd.stderr.on("data", (chunk: Buffer) => this.sendOutput(chunk.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1200);
      this.openOcd?.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`OpenOCD 启动失败，退出码：${code ?? "未知"}`));
      });
      this.openOcd?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async startGdb(args: LaunchArgs): Promise<void> {
    this.sendOutput(`GDB: ${args.gdbPath} --interpreter=mi2`);
    this.gdb = spawn(args.gdbPath, ["--interpreter=mi2"], { cwd: args.cwd });
    this.gdb.stdout.on("data", (chunk: Buffer) => this.onGdbData(chunk));
    this.gdb.stderr.on("data", (chunk: Buffer) => this.sendOutput(chunk.toString("utf8")));
    this.gdb.once("exit", (code) => {
      this.sendOutput(`GDB 已退出：${code ?? "未知"}`);
      this.sendEvent("terminated");
    });
    await this.waitForMiRecord((record) => record.kind === "prompt", 15000, "GDB 启动超时");
  }

  private async initializeGdb(args: LaunchArgs): Promise<void> {
    await this.gdbCommand("-gdb-set target-async on");
    await this.gdbCommand(`-file-exec-and-symbols ${quoteMiArgument(args.elfPath)}`);
    await this.gdbCommand(`-target-select extended-remote ${args.host}:${args.gdbPort}`);
    await this.gdbCommand(`-interpreter-exec console ${quoteMiArgument("monitor reset halt")}`);
    await this.gdbCommand("-target-download");
    for (const command of args.startupCommands ?? []) {
      if (command.trim()) {
        await this.gdbCommand(`-interpreter-exec console ${quoteMiArgument(command)}`);
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

    if (record.kind === "console" || record.kind === "target" || record.kind === "log") {
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
    return this.createMiRecordWaiter(predicate, timeoutMs, timeoutMessage).promise;
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
    this.lastStoppedBreakpointNumber = getString(results.bkptno) || this.lastStoppedBreakpointNumber;
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
    this.sendEvent("stopped", {
      reason: toDapStoppedReason(reason),
      threadId: 1,
      allThreadsStopped: true,
      line: frame
        ? Number.parseInt(getString(frame.line), 10) || this.lastStoppedLocation?.line || undefined
        : this.lastStoppedLocation?.line,
    });
  }

  private markTargetRunning(): void {
    this.targetRunning = true;
    this.lastStoppedLocation = undefined;
    this.lastStoppedBreakpointNumber = undefined;
  }

  private async deleteBreakpointsAtLastStoppedLocation(): Promise<string[]> {
    if (this.lastStoppedBreakpointNumber) {
      this.sendOutput(`单步前删除当前断点：${this.lastStoppedBreakpointNumber}`);
      await this.gdbCommand(`-break-delete ${this.lastStoppedBreakpointNumber}`);
      this.removeBreakpointNumberFromState(this.lastStoppedBreakpointNumber);
      return [this.lastStoppedBreakpointNumber];
    }

    if (!this.lastStoppedLocation) {
      return [];
    }

    const sourcePath = this.resolveSourcePath(this.lastStoppedLocation.file);
    const breakpointNumber = this.breakpoints.get(this.toBreakpointKey(sourcePath))?.gdbNumbersByLine.get(this.lastStoppedLocation.line);
    if (!breakpointNumber) {
      this.sendOutput(`单步前未找到当前断点：${sourcePath}:${this.lastStoppedLocation.line}`);
      return [];
    }

    this.sendOutput(`单步前删除当前断点：${breakpointNumber} ${sourcePath}:${this.lastStoppedLocation.line}`);
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
    return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
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
    const file = getString(frame.fullname) || getString(frame.file);
    const line = Number.parseInt(getString(frame.line), 10);
    if (!file || !Number.isFinite(line)) {
      return;
    }

    this.lastStoppedLocation = { file, line };
  }

  private gdbCommand(command: string): Promise<Extract<MiRecord, { kind: "result" }>> {
    if (!this.gdb) {
      return Promise.reject(new Error("GDB 尚未启动"));
    }

    const token = this.nextGdbToken++;
    this.gdb.stdin.write(`${token}${command}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommands.delete(token)) {
          reject(new Error(`GDB 命令超时：${command}`));
        }
      }, 30000);
      this.pendingCommands.set(token, { resolve, reject, timer });
    });
  }

  private async disconnect(): Promise<void> {
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

  private async resetTargetBeforeDisconnect(): Promise<void> {
    // 先清掉本次会话插入的硬件断点，否则复位后可能立刻再次停在用户断点。
    await this.tryGdbCommand("-break-delete");

    // WCH OpenOCD 对 reset run 的行为不够稳定，因此采用 reset halt 再 resume 的组合。
    if (await this.tryGdbCommand(`-interpreter-exec console ${quoteMiArgument("monitor reset halt")}`)) {
      await this.tryGdbCommand(`-interpreter-exec console ${quoteMiArgument("monitor resume")}`);
      this.markTargetRunning();
      return;
    }

    // 老配置如果不支持 reset halt，则退回普通 reset 再继续运行。
    await this.tryGdbCommand(`-interpreter-exec console ${quoteMiArgument("monitor reset")}`);
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

  private validateLaunchArgs(args: LaunchArgs): void {
    for (const key of ["elfPath", "gdbPath", "openOcdPath", "cwd", "openOcdCwd", "host"] as const) {
      if (!args[key]) {
        throw new Error(`调试配置缺少 ${key}`);
      }
    }
    if (!Number.isFinite(args.gdbPort) || args.gdbPort <= 0) {
      throw new Error("调试配置缺少有效 GDB 端口");
    }
  }

  private sendResponse(request: DapMessage, body?: unknown, success = true, message?: string): void {
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
    this.sendEvent("output", { category: "console", output });
  }

  private send(message: unknown): void {
    const json = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }
}

function quoteMiArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
