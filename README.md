# wch-vscode README

This is the README for your extension "wch-vscode". After writing up a brief description, we recommend including the following sections.

## Features

- Detects WCH MounRiver Studio projects in the current workspace.
- Generates cpptools configuration from parsed WCH project models.
- Shows a `$(tools) Build` status bar button for supported RISC-V projects and runs builds through the bundled MRS `make.exe`.

## Requirements

Configure `wchVscode.mounRiverStudioPath` before using Build or generated C/C++ toolchain paths.

## Extension Settings

This extension contributes the following settings:

* `wchVscode.mounRiverStudioPath`: MounRiver Studio 安装根目录。扩展会基于这个路径解析 WCH 工具链和固定位置的 `make.exe`。

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
