<div align="center">
  <img src="media/wch-vscode-icon.png" alt="WCH VS Code Logo" width="80" height="80">
  <h1>WCH VS Code</h1>
  <p>A VS Code extension powered by the MounRiver Studio toolchain. Out-of-the-box building, flashing, and hardware debugging without migrating your native projects.</p>
  <p><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>
</div>

---

## Key Features

- **Project Build**: One-key incremental compilation (`F7`) and clean rebuild (`Shift+F7`), seamlessly invoking the underlying toolchain.
- **Firmware Flashing**: Fast one-key firmware download (`F8`) to the target MCU.
- **Breakpoint Debugging**: Instant launch (`F5`) of chip-level hardware debugging based on OpenOCD and GDB, supporting source-level breakpoints, step-by-step execution, and variable watches.

---

## Why Choose This Extension

- **Zero-Config IntelliSense**: Automatically parses `.wvproj` and synchronizes target architecture, global macros, and include paths to the C/C++ extension—no manual tweaking of `c_cpp_properties.json`.
- **Dedicated Project Files View**: Provides an IDE-like source tree that filters files by the active build configuration, showing only source files participating in the build.
- **Zero-Glue Toolchain Integration**: Automatically bridges compilers and debug adapters without writing boilerplate `tasks.json` or `launch.json` scripts.
- **Non-Invasive Coexistence**: Read-only parsing of native projects without proprietary formats. Seamlessly jump back to the official IDE via "Open in MounRiver Studio" at any time.

---

## Quick Start

### 1. Prerequisites

- **OS**: Windows
- **MounRiver Studio**: [MRS 2 or MRS 3](http://www.mounriver.com/)
- **Required Extension**: [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (`ms-vscode.cpptools`)

### 2. Install Extension

Search for `WCH VS Code` in the VS Code Extensions view (`Ctrl+Shift+X`) and click Install, or get it directly from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=WineRealms.wch-vscode).

### 3. Open & Configure

1. Open any workspace folder containing a `.wvproj` file in VS Code.
2. On first launch, follow the prompt (or use the sidebar setting) to specify your **MounRiver Studio Installation Root** (e.g., `D:\MounRiver\MounRiver_Studio2`).

---

## FAQ

<details>
<summary><b>Will this modify or pollute my existing project files?</b></summary>
No. The extension performs read-only parsing on <code>.wvproj</code> files and dynamically extracts all build and debug parameters. It only creates helper configurations needed by VS Code for code IntelliSense.
</details>

<details>
<summary><b>Why does downloading or debugging report that the toolchain cannot be found?</b></summary>
Please verify that the "MounRiver Studio Installation Root" setting points directly to the installation root directory, rather than a subfolder.
</details>

---

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).

_Disclaimer: This is an independent community open-source project and is not affiliated with or endorsed by Nanjing Qinheng Microelectronics (WCH) or MounRiver Studio._
