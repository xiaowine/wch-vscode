# WCH VS Code Extension

[中文](README.md) | [English](README.en.md)

> **Important: This is a community-developed third-party VS Code extension. It is not affiliated with or endorsed by WCH or MounRiver Studio.**
>
> This extension only provides VS Code integration for MounRiver Studio projects. The toolchain, project configuration, and related software are still provided by MounRiver Studio.

A VS Code extension for MounRiver Studio RISC-V projects.

Its goal is simple: keep using the VS Code you are familiar with, while bringing MRS project build, download, and debug configuration into VS Code. You do not need to migrate the project into a new structure, and you do not need to stay in MRS just to write code.

## Why This Extension Exists

MounRiver Studio can create and maintain WCH projects, and it includes the toolchain, OpenOCD, download configuration, and debug configuration. But many developers prefer VS Code for everyday coding:

- The editor is lighter and the extension ecosystem is familiar;
- File search, Git, terminal, shortcuts, and multi-window workflows are more convenient;
- You may not want to switch between MRS and VS Code just to edit, build, or download firmware.

This extension is built for that workflow. It reads MRS project files from the current workspace, reuses existing MRS project information as much as possible, and exposes common actions directly in VS Code.

## Why Not Use an MRS Build Based on VS Code

MRS is an independent IDE. It is complete, official, and works out of the box, but it also means accepting its full workflow.

This extension takes a different approach:

- Keep using the original VS Code instead of replacing your editor;
- Do not take over the whole development environment, only add the common WCH build, download, and debug entry points;
- Reuse the toolchain and configuration from MRS to avoid duplicate setup;
- Work with your existing VS Code extensions, themes, shortcuts, and Git workflow;
- Keep the project compatible with MRS, instead of converting it into a plugin-only format.

In short: MRS creates and stores the project configuration, VS Code handles daily coding, and this extension connects the missing part between them.

## Features

- Automatically detects WCH MounRiver Studio projects in the workspace root and parses project configuration;
- Supports building WCH projects in VS Code;
- Supports downloading firmware to the target board;
- Supports starting a VS Code debug session with breakpoint debugging;
- Supports C/C++ IntelliSense by automatically generating the required `.vscode/c_cpp_properties.json` configuration.

## Installation And Configuration

Before using this extension, you only need:

- Windows;
- MRS 2 or MRS 3 installed (MRS 1 is not supported).

After installing the extension, search for `wchVscode.mounRiverStudioPath` in VS Code settings and fill in the MRS installation directory:

```json
{
  "wchVscode.mounRiverStudioPath": "F:\\MounRiver\\MounRiver_Studio2"
}
```

This path is the MounRiver Studio installation directory required by the extension.

### Choosing A Build Method

The extension supports two side-by-side build methods. Search for `wchVscode.buildMethod` in VS Code settings and choose:

- `make` (default, plugin parses parameters): the extension parses the project configuration, generates makefiles, and calls `make` from the MRS toolchain directly;
- `mrs-cli` (MRS parses parameters): MRS parses the project configuration and builds itself, exactly like building inside MRS.

In `mrs-cli` mode, build, clean, clean and build, build and download, and the build before debugging are all handled by MRS parsing the project parameters. MRS always exits with code 0, so success is determined by the "Build Finished"/"Build Failed" markers in the log. If an MRS instance is already running, the parameters may be forwarded without returning a log; close MRS first.

## Commands And Shortcuts

After opening a folder that contains a WCH MRS project, the extension scans the project automatically. You can run these actions from the sidebar, status bar, or command palette:

- `WCH: Refresh Projects`: rescan projects;
- `WCH: Build`: build the current project;
- `WCH: Clean`: clean build output;
- `WCH: Clean and Build`: clean and rebuild;
- `WCH: Download`: download the generated firmware;
- `WCH: Build and Download`: build first, then download on success;
- `WCH: Debug`: build first, then start debugging;
- `WCH: Open in MRS`: open the current project in MRS.

Default shortcuts match MRS:

- `F7`: build;
- `Shift+F7`: clean and build;
- `F8`: download;
- `F5`: debug.

## Sidebar

The sidebar is split into two views:

- **Overview**: detected project information;
- **Settings & Tools**: MRS directory setting, build method setting, and opening the current project in MRS.

"Open Project in MRS" resolves the MRS project for the workspace containing the current file. If the current folder is not an MRS project, the extension shows a warning and does not open anything.

The Overview view shows:

- Project name and path;
- Toolchain type;
- Architecture and ABI;
- Output file;
- Linker script;
- OpenOCD configuration;
- GDB port;
- Whether the project is supported.

If the project has no download or debug configuration yet, the extension will ask you to complete the configuration in MRS first.

## Current Scope

Currently supported:

- WCH RISC-V projects;
- Standard MRS 2/3 installation layout on Windows;
- Existing download and debug configuration from MRS projects;
- Common WCH RISC-V toolchain layouts, including GCC8, GCC12, and GCC15.

Not a main focus for now:

- Non-RISC-V WCH projects;
- New projects created completely outside MRS configuration;
- Heavily customized MRS installation layouts;
- Linux or macOS.

## Calling From Other Extensions

Other VS Code extensions can invoke the build-and-download command directly. The command returns `true` when it succeeds.

```ts
await vscode.commands.executeCommand<boolean>(
  "wchVscode.buildDownloadProject",
  {
    folderPath: "D:\\workspace\\CH32V203Demo",
    showSuccessMessage: true,
  },
);
```

You can also locate the project by `.wvproj` path, project name, or base name:

```ts
await vscode.commands.executeCommand<boolean>(
  "wchVscode.buildDownloadProject",
  {
    wvprojPath: "D:\\workspace\\CH32V203Demo\\CH32V203Demo.wvproj",
  },
);
```

With no arguments, the command selects the target project from the active editor and workspace:

```ts
await vscode.commands.executeCommand<boolean>("wchVscode.buildDownloadProject");
```

## FAQ

### Can this extension fully replace MRS?

No, and it is not intended to. MRS is still useful for creating projects, changing chip-related configuration, and maintaining download/debug configuration. This extension is better suited for daily coding, build, download, and debug work in VS Code.

### Why does it say download is not configured?

The current project does not have a usable download or debug configuration. Open the project in MRS first, finish the download/debug setup, then return to VS Code.

### Why can it not find make.exe, OpenOCD, or GDB?

Usually `wchVscode.mounRiverStudioPath` is incorrect. Make sure it points to the MounRiver Studio installation root, not a subdirectory.

### Will it modify my MRS project?

The extension reads MRS project configuration and may generate VS Code configuration files such as `.vscode/c_cpp_properties.json`. It does not convert the project into another format.

## Development

This project uses pnpm:

```sh
pnpm install
pnpm run compile
pnpm run lint
pnpm test
```

Package:

```sh
pnpm run vscode:prepublish
pnpm run package
```

## License

GNU General Public License v3.0.
