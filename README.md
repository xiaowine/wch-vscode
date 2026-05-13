# wch-vscode

VS Code extension for WCH MounRiver Studio 2 RISC-V projects. It detects MRS projects in the current workspace, builds them with the bundled WCH toolchain, downloads firmware through OpenOCD, and starts a VS Code debug session for supported targets.

## Features

- Detects `.cproject`, `.launch`, and `.wvproj` project files in workspace folders.
- Builds a normalized project model from MounRiver Studio project metadata.
- Generates `.vscode/c_cpp_properties.json` for the Microsoft C/C++ extension when the file is missing.
- Provides sidebar views for project overview and WCH project files.
- Adds status bar actions for Clean, Build, Clean Build, Download, Build Download, and Debug.
- Generates makefiles from the parsed project model before building.
- Resolves WCH GCC8, GCC12, and GCC15 RISC-V toolchains from the configured MounRiver Studio 2 installation.
- Starts WCH RISC-V debug sessions through the included GDB/OpenOCD flow.
- Opens detected projects in MounRiver Studio 2.

## Requirements

- Windows.
- MounRiver Studio 2 installed locally.
- Microsoft C/C++ extension (`ms-vscode.cpptools`), installed automatically as an extension dependency.
- A WCH RISC-V MounRiver Studio project in the current VS Code workspace.

Configure `wchVscode.mounRiverStudioPath` before using build, download, debug, or generated C/C++ toolchain paths. Example:

```json
{
  "wchVscode.mounRiverStudioPath": "F:\\MounRiver\\MounRiver_Studio2"
}
```

## Commands

- `WCH: Refresh Projects`: rescan the workspace and refresh WCH views.
- `WCH: Build`: generate build files and run make.
- `WCH: Clean`: remove the active project's build output directory.
- `WCH: Clean and Build`: clean the output directory, regenerate build files, and run make.
- `WCH: Download`: download the generated firmware image through OpenOCD.
- `WCH: Build and Download`: build first, then download on success.
- `WCH: Debug`: build first, then start a WCH RISC-V debug session.
- `WCH: Open in MRS2`: open the project in MounRiver Studio 2.

## External Command API

Other extensions can invoke build-and-download directly through the VS Code command API. The command returns `true` when both build and download succeed.

```ts
await vscode.commands.executeCommand<boolean>(
  "wchVscode.buildDownloadProject",
  {
    folderPath: "D:\\workspace\\CH32V203Demo",
    // or: wvprojPath: "D:\\workspace\\CH32V203Demo\\CH32V203Demo.wvproj",
    // or: projectName: "CH32V203Demo",
    // or: baseName: "CH32V203Demo",
    showSuccessMessage: true
  }
);
```

Passing no argument keeps the original behavior and uses the active editor/workspace to resolve the target project:

```ts
await vscode.commands.executeCommand<boolean>("wchVscode.buildDownloadProject");
```

For simple integrations, a string argument is accepted. A `.wvproj` path is treated as `wvprojPath`; any other string is treated as `folderPath`.

## Extension Settings

- `wchVscode.mounRiverStudioPath`: MounRiver Studio 2 installation root. The extension resolves WCH toolchains, `make.exe`, OpenOCD, and MRS2 from this root.

## Current Scope

- RISC-V projects are supported.
- Non-RISC-V WCH project files are detected but marked unsupported.
- Toolchain resolution currently follows the standard MounRiver Studio 2 Windows installation layout.

## Development

Use pnpm:

```sh
pnpm install
pnpm run compile
pnpm run lint
pnpm test
```

## Packaging

The release build cleans stale output before compiling so the VSIX only contains JavaScript emitted from the current `src/` tree.
Packaging uses `@vscode/vsce --no-dependencies` because this project uses pnpm; letting VSCE invoke npm dependency detection can report false missing dependencies from pnpm's isolated `node_modules` layout.

```sh
pnpm run vscode:prepublish
pnpm run package
```

Publishing uses the `publisher` value in `package.json`. Change it to your Visual Studio Marketplace publisher ID before running:

```sh
pnpm run publish
```
