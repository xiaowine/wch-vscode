# WCH VS Code Extension

[中文](README.md) | [English](README.en.md)

一个给MounRiver Studio 2 RISC-V 工程使用的 VS Code 扩展。

它的目标很简单：继续使用你熟悉的 VS Code，同时把 MRS2 工程里的编译、下载、调试配置接进来。你不需要把项目重新迁移成一套新的工程结构，也不需要为了写代码长期停留在 MRS2 里。

## 为什么会有这个插件

MounRiver Studio 2 能创建和维护 WCH 工程，也带有工具链、OpenOCD、下载和调试配置。但很多人日常写代码更习惯 VS Code：

- 编辑器响应更轻，插件生态更熟悉；
- 文件搜索、Git、终端、快捷键和多窗口工作流更顺手；
- 不想为了改几行代码、编译一下、下载一下，就在 MRS2 和 VS Code 之间来回切换。

这个扩展就是为这个场景准备的。它读取当前工作区里的 MRS2 工程文件，尽量复用 MRS2 已经生成的工程信息，然后在 VS Code 里提供常用操作。

## 为什么不是用“基于 VS Code 修改的 MRS2”

MRS2 本身确实是基于 Eclipse/Theia/VS Code 相关技术栈做出来的集成环境，但它仍然是一个独立 IDE。直接使用 MRS2 的好处是完整、官方、开箱即用；缺点是你必须接受它完整的工作方式。

这个插件选择了另一条路：

- 保留原版 VS Code，不替换你的编辑器；
- 不接管整个开发环境，只补齐 WCH 工程最常用的编译、下载、调试入口；
- 继续使用 MRS2 自带的工具链和配置，减少重复配置；
- 可以和你现有的 VS Code 插件、主题、快捷键、Git 工作流一起用；
- 项目仍然可以随时回到 MRS2 打开，不会被改造成只能由本插件使用的格式。

简单说：MRS2 负责创建和保存工程配置，VS Code 负责日常写代码，这个插件负责把中间断开的那一段接起来。

## 主要功能

- 自动识别工作区中的 WCH MounRiver Studio 2 工程并解析工程配置；
- 支持在 VS Code 中编译 WCH 工程；
- 支持下载固件到目标板；
- 支持启动 VS Code 调试会话，并使用断点调试；
- 支持 C/C++ 代码提示，并自动生成所需的 `.vscode/c_cpp_properties.json` 配置。

## 安装与配置

使用这个插件前，你只需要准备好两件事：

- Windows；
- 已安装 MounRiver Studio 2；

安装插件后，在 VS Code 设置中搜索 `wchVscode.mounRiverStudioPath`，填写 MRS2 的安装目录：

```json
{
  "wchVscode.mounRiverStudioPath": "F:\\MounRiver\\MounRiver_Studio2"
}
```

这个路径是插件依赖的 MounRiver Studio 2 安装目录。

## 命令与快捷键

打开一个包含 WCH MRS2 工程的文件夹后，插件会自动扫描工程。你可以通过侧边栏、状态栏或者命令面板执行这些操作：

- `WCH: Refresh Projects`：重新扫描工程；
- `WCH: Build`：编译当前工程；
- `WCH: Clean`：清理构建输出；
- `WCH: Clean and Build`：清理后重新编译；
- `WCH: Download`：下载已生成的固件；
- `WCH: Build and Download`：先编译，成功后下载；
- `WCH: Debug`：先编译，成功后启动调试；
- `WCH: Open in MRS2`：用 MRS2 打开当前工程。

默认快捷键与 MRS2 保持一致：

- `F7`：编译；
- `Shift+F7`：清理并编译；
- `F8`：下载；
- `F5`：调试。

## 侧边栏能看到什么

插件会在 VS Code 活动栏中添加 WCH 入口，用来查看当前识别到的工程信息，例如：

- 工程名称和路径；
- 工具链类型；
- 架构和 ABI；
- 输出文件；
- 链接脚本；
- OpenOCD 配置；
- GDB 端口；
- 是否支持当前工程。

如果项目还没有在 MRS2 中配置下载或调试，插件会提示你先回到 MRS2 完成配置。

## 当前支持范围

目前主要支持：

- WCH RISC-V 工程；
- 标准 MounRiver Studio 2 Windows 安装结构；
- MRS2 工程中已有的下载和调试配置；
- GCC8、GCC12、GCC15 等常见 WCH RISC-V 工具链布局。

暂不作为重点支持：

- 非 RISC-V WCH 工程；
- 完全脱离 MRS2 配置的新建工程；
- 非标准手动改造过的 MRS2 安装目录；
- Linux/macOS 环境。

## 给其他扩展调用

如果你在写其他 VS Code 扩展，也可以直接调用本插件的一键编译下载命令。命令成功时返回 `true`。

```ts
await vscode.commands.executeCommand<boolean>(
  "wchVscode.buildDownloadProject",
  {
    folderPath: "D:\\workspace\\CH32V203Demo",
    showSuccessMessage: true,
  },
);
```

也可以传入 `.wvproj` 路径、工程名或基础名来定位项目：

```ts
await vscode.commands.executeCommand<boolean>(
  "wchVscode.buildDownloadProject",
  {
    wvprojPath: "D:\\workspace\\CH32V203Demo\\CH32V203Demo.wvproj",
  },
);
```

不传参数时，会按当前活动编辑器和工作区自动选择目标工程：

```ts
await vscode.commands.executeCommand<boolean>("wchVscode.buildDownloadProject");
```

## 常见问题

### 这个插件能完全替代 MRS2 吗？

不能，也不打算完全替代。MRS2 仍然适合用来创建工程、修改芯片相关配置、维护下载和调试配置。本插件更适合日常写代码、编译、下载和调试。

### 为什么提示没有配置下载？

说明当前工程缺少可用的下载或调试配置。请先用 MRS2 打开项目，完成一次下载/调试配置后再回到 VS Code。

### 为什么找不到 make.exe、OpenOCD 或 GDB？

通常是 `wchVscode.mounRiverStudioPath` 配错了。请确认它指向 MounRiver Studio 2 安装根目录，而不是某个子目录。

### 会修改我的 MRS2 工程吗？

插件会读取 MRS2 工程配置，并在需要时生成 VS Code 使用的配置文件，例如 `.vscode/c_cpp_properties.json`。它不会把工程改造成另一套格式。

## 开发

本项目使用 pnpm：

```sh
pnpm install
pnpm run compile
pnpm run lint
pnpm test
```

打包：

```sh
pnpm run vscode:prepublish
pnpm run package
```

## 协议

GNU General Public License v3.0。
