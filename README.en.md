# WCH VS Code Extension

[中文](README.md) | [English](README.en.md)

> This is a community-developed third-party VS Code extension. It is not affiliated with or endorsed by WCH or MounRiver Studio.

If you build WCH projects with MounRiver Studio but prefer to work in VS Code, this extension lets you keep editing, building, downloading, and debugging in VS Code. The project is still created and managed by MRS, and nothing needs to be migrated to a new format.

## What It Does

- Detects MRS projects in your workspace automatically;
- Builds, downloads, and debugs from VS Code;
- Provides C/C++ IntelliSense and navigation;
- Leaves the project structure unchanged, so you can still open it in MRS.

## Installation

You need Windows and MRS 2 or MRS 3. MRS 1 is not supported.

After installing the extension, tell it where MRS is installed. Search for “MounRiver Studio installation root” in Settings, or click the same item in the “Settings & Tools” sidebar:

```json
{
  "wchVscode.mounRiverStudioPath": "F:\\MounRiver\\MounRiver_Studio2"
}
```

Point it to the MounRiver Studio folder itself, not to `bin` or another subfolder.

## Settings

### Build Method

The default “Plugin parses parameters” option works for most projects. If you want the build to behave exactly like MRS, choose “MRS parses parameters”.

If you use MRS to parse parameters and MRS is already running, close it first before building from VS Code.

### Reset Method

The default is “Normal reset”, which works the same way as before.

On some chips, the debug pins are shared with other functions, and a normal reset cannot enter download mode. In that case, change the reset method to “Power-off reset” in the “Settings & Tools” sidebar.

When power-off reset is selected, you can also set:

- **Reset voltage**: choose 3.3V or 5V to match the target board;
- **Re-power wait time**: 100 ms by default; increase it if the board starts slowly.

The target board must be powered by WCH-Link. If it has its own external power supply, power-off reset cannot cut the power. If the wrong reset voltage is selected, the target will not actually power off.

## Usage

Open a folder containing a `.wvproj` file and the extension will detect the project. You can then use the sidebar, status bar, or Command Palette.

| Action | Shortcut |
| --- | --- |
| Build | `F7` |
| Clean and Build | `Shift+F7` |
| Download | `F8` |
| Debug | `F5` |

Type `WCH` in the Command Palette to see the other commands.

When downloading or resetting, the “WCH Download/Reset” terminal opens and shows progress.

## Sidebar

- **Overview**: project, chip, build, debug, and download information;
- **Settings & Tools**: MRS installation folder, build method, reset method, and related settings.

Only the settings that apply are shown. For example, reset voltage and wait time are hidden when normal reset is selected.

## FAQ

**Can it fully replace MRS?**

No. Use MRS to create projects, change chip settings, and maintain download/debug configuration. This extension is for day-to-day editing, building, downloading, and debugging.

**It says download is not configured. What should I do?**

Open the project in MRS, complete a download or debug configuration once, then return to VS Code.

**It cannot find the toolchain, OpenOCD, or GDB.**

The MRS installation folder is usually wrong. Make sure it points to the MounRiver Studio installation root, not to `bin` or a subfolder.

**Will it modify my project?**

It reads the MRS project files and may generate `.vscode/c_cpp_properties.json`, but it does not convert the project to another format.

## Feedback

Report problems or suggestions on GitHub Issues:

https://github.com/xiaowine/wch-vscode/issues

## License

GNU General Public License v3.0.
