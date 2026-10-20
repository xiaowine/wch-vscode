import * as path from "node:path";

// Windows 版 GDB 按 ANSI 代码页打开文件，含中文等非 ASCII 字符的绝对路径会报
// “No such file or directory”。GDB 进程的 cwd 由 Node 以 Unicode 设置，传入相对
// 于 cwd 的路径即可绕过绝对路径中的中文目录。
export function resolveGdbFilePath(cwd: string, filePath: string): string {
    if (process.platform !== "win32" || !cwd || !filePath) {
        return filePath;
    }

    const relativePath = path.relative(cwd, filePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return filePath;
    }
    return relativePath;
}

// GDB 的 MI 输出把无法直接显示的字节写成 \ooo；中文 Windows 上这些字节是 GBK。
export function decodeGdbPath(value: string): string {
    if (!value || !/[\u0080-\u00ff]/.test(value)) {
        return value;
    }

    try {
        const decoder = process.platform === "win32" ? "gbk" : "utf-8";
        return new TextDecoder(decoder).decode(Buffer.from(value, "latin1"));
    } catch {
        return value;
    }
}

// 断点路径：工程内用相对路径；工程外的中文路径 GDB 无法匹配，退回文件名。
export function resolveGdbBreakpointFile(cwd: string, filePath: string): string {
    if (process.platform !== "win32" || !cwd || !filePath) {
        return filePath;
    }

    const relativePath = path.relative(cwd, filePath);
    if (
        relativePath
        && !relativePath.startsWith("..")
        && !path.isAbsolute(relativePath)
        && !/[^\x00-\x7F]/.test(relativePath)
    ) {
        return relativePath;
    }

    if (/[^\x00-\x7F]/.test(filePath)) {
        return path.basename(filePath);
    }
    return filePath;
}
