import * as vscode from "vscode";
import { t } from "../i18n";

export interface OpenOcdTerminalWriter {
  write(chunk: string): void;
  writeLine(line: string): void;
  flush(): void;
}

let terminal: vscode.Terminal | undefined;
let terminalWriter: TerminalWriter | undefined;

export function createOpenOcdTerminalWriter(): OpenOcdTerminalWriter {
  terminal?.dispose();
  const writeEmitter = new vscode.EventEmitter<string>();
  terminal = vscode.window.createTerminal({
    name: t("download.outputChannel"),
    pty: {
      onDidWrite: writeEmitter.event,
      open: () => undefined,
      close: () => undefined,
      handleInput: () => undefined,
    },
  });
  terminalWriter = new TerminalWriter(writeEmitter);
  terminal.show(true);
  return terminalWriter;
}

export function disposeOpenOcdTerminal(): void {
  terminalWriter?.flush();
  terminalWriter = undefined;
  terminal?.dispose();
  terminal = undefined;
}

class TerminalWriter implements OpenOcdTerminalWriter {
  private buffer = "";

  constructor(private readonly writeEmitter: vscode.EventEmitter<string>) {}

  write(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.writeLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  writeLine(line: string): void {
    this.writeEmitter.fire(`${line.replace(/\r$/, "")}\r\n`);
  }

  flush(): void {
    if (!this.buffer) {
      return;
    }
    const line = this.buffer;
    this.buffer = "";
    this.writeLine(line);
  }
}
