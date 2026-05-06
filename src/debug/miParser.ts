export type MiValue = string | MiTuple | MiValue[];
export type MiTuple = { [key: string]: MiValue };

export type MiRecord =
  | { kind: "result"; token?: number; resultClass: string; results: MiTuple; raw: string }
  | { kind: "exec"; asyncClass: string; results: MiTuple; raw: string }
  | { kind: "notify"; asyncClass: string; results: MiTuple; raw: string }
  | { kind: "console" | "target" | "log"; text: string; raw: string }
  | { kind: "prompt"; raw: string }
  | { kind: "unknown"; raw: string };

export function parseMiLine(line: string): MiRecord {
  const raw = line;
  const trimmed = line.trim();
  if (trimmed === "(gdb)") {
    return { kind: "prompt", raw };
  }

  const streamPrefix = trimmed[0];
  if (streamPrefix === "~" || streamPrefix === "@" || streamPrefix === "&") {
    return {
      kind: streamPrefix === "~" ? "console" : streamPrefix === "@" ? "target" : "log",
      text: parseCString(trimmed.slice(1)),
      raw,
    };
  }

  const resultMatch = /^(\d*)\^([A-Za-z-]+)(?:,(.*))?$/.exec(trimmed);
  if (resultMatch) {
    return {
      kind: "result",
      token: resultMatch[1] ? Number.parseInt(resultMatch[1], 10) : undefined,
      resultClass: resultMatch[2],
      results: parseResults(resultMatch[3] ?? ""),
      raw,
    };
  }

  const asyncMatch = /^([*=])([A-Za-z-]+)(?:,(.*))?$/.exec(trimmed);
  if (asyncMatch) {
    return {
      kind: asyncMatch[1] === "*" ? "exec" : "notify",
      asyncClass: asyncMatch[2],
      results: parseResults(asyncMatch[3] ?? ""),
      raw,
    };
  }

  return { kind: "unknown", raw };
}

export function parseResults(text: string): MiTuple {
  const parser = new MiValueParser(text);
  return parser.parseTupleBody();
}

export function getTuple(value: MiValue | undefined): MiTuple | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function getList(value: MiValue | undefined): MiValue[] {
  return Array.isArray(value) ? value : [];
}

export function getString(value: MiValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function parseCString(text: string): string {
  if (!text.startsWith("\"")) {
    return text;
  }

  return new MiValueParser(text).parseCString();
}

class MiValueParser {
  private index = 0;

  public constructor(private readonly text: string) {}

  public parseTupleBody(): MiTuple {
    const result: MiTuple = {};
    while (!this.isAtEnd()) {
      const name = this.parseName();
      if (!name) {
        break;
      }
      this.consume("=");
      result[name] = this.parseValue();
      if (!this.consume(",")) {
        break;
      }
    }
    return result;
  }

  public parseCString(): string {
    let output = "";
    this.consume("\"");
    while (!this.isAtEnd()) {
      const char = this.text[this.index++];
      if (char === "\"") {
        break;
      }
      if (char !== "\\") {
        output += char;
        continue;
      }

      const escaped = this.text[this.index++];
      switch (escaped) {
        case "n":
          output += "\n";
          break;
        case "t":
          output += "\t";
          break;
        case "r":
          output += "\r";
          break;
        default:
          output += escaped ?? "";
          break;
      }
    }
    return output;
  }

  private parseValue(): MiValue {
    const char = this.text[this.index];
    if (char === "\"") {
      return this.parseCString();
    }
    if (char === "{") {
      this.index++;
      const tuple = this.parseTupleBody();
      this.consume("}");
      return tuple;
    }
    if (char === "[") {
      return this.parseList();
    }
    return this.parseBareValue();
  }

  private parseList(): MiValue[] {
    const values: MiValue[] = [];
    this.consume("[");
    while (!this.isAtEnd() && this.text[this.index] !== "]") {
      const start = this.index;
      const name = this.parseName();
      if (name && this.text[this.index] === "=") {
        this.consume("=");
        values.push({ [name]: this.parseValue() });
      } else {
        this.index = start;
        values.push(this.parseValue());
      }
      if (!this.consume(",")) {
        break;
      }
    }
    this.consume("]");
    return values;
  }

  private parseBareValue(): string {
    const start = this.index;
    while (!this.isAtEnd() && ![",", "}", "]"].includes(this.text[this.index])) {
      this.index++;
    }
    return this.text.slice(start, this.index);
  }

  private parseName(): string {
    const start = this.index;
    while (!this.isAtEnd() && /[A-Za-z0-9_-]/.test(this.text[this.index])) {
      this.index++;
    }
    return this.text.slice(start, this.index);
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) {
      return false;
    }
    this.index++;
    return true;
  }

  private isAtEnd(): boolean {
    return this.index >= this.text.length;
  }
}
