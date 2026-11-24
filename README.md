<div align="center">
  <img src="media/wch-vscode-icon.png" alt="WCH VS Code Logo" width="80" height="80">
  <h1>WCH VS Code</h1>
  <p>基于 MounRiver Studio 工具链的 VS Code 扩展，开箱即用构建、烧录与单步调试，无需迁移原生工程。</p>
  <p><a href="README.md">中文</a> · <a href="README.en.md">English</a></p>
</div>

---

## 主要功能

- **工程编译**：支持一键增量构建（`F7`）与清理重新构建（`Shift+F7`），无缝调用底层编译工具链。
- **固件下载**：一键将固件快速烧录（`F8`）至目标芯片。
- **断点调试**：一键启动（`F5`）基于 OpenOCD 与 GDB 的芯片级硬件调试，支持源码断点、单步步进与变量监视。

---

## 为什么选择

- **零配置智能补全**：自动解析 `.wvproj`，将芯片架构、宏定义与头文件路径智能同步给 C/C++ 扩展，彻底告别手动折腾 `c_cpp_properties.json`。
- **专属工程文件视图**：提供类似 IDE 的专属源码树，自动按当前构建配置过滤文件，只展示真正参与编译的代码，告别在庞大杂乱的目录树中翻找。
- **免配置工具链联动**：自动串联底层编译器与调试适配器，无需手写繁琐的 `tasks.json` 与 `launch.json`，一键拉起完整开发流。
- **完全非侵入式共存**：对原有工程只读解析，不引入任何私有项目格式；随时可点击“在 MounRiver Studio 中打开”，团队成员自由选择工具，互不影响。

---

## 快速上手

### 1. 依赖

- **操作系统**：Windows、Linux（需要对应平台的 MounRiver Studio）
- **MounRiver Studio**：[MRS 2 或 MRS 3](http://www.mounriver.com/)
- **前置扩展**：[C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)（`ms-vscode.cpptools`）

### 2. 安装插件

在 VS Code 扩展面板（`Ctrl+Shift+X`）搜索 `WCH VS Code` 点击安装，或直接访问 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=WineRealms.wch-vscode) 获取。

### 3. 打开与配置

1. 在 VS Code 中打开包含 `.wvproj` 的工程文件夹。
2. 首次使用时按弹窗提示（或在侧栏中）指定 **MounRiver Studio 安装根目录**。Windows 示例为 `D:\MounRiver\MounRiver_Studio2`，Linux 请填写解压或安装后的根目录。

---

## 常见问题

<details>
<summary><b>会修改或污染我现有的工程文件吗？</b></summary>
不会。插件对 <code>.wvproj</code> 仅进行只读解析，所有的构建、调试参数均从原有工程动态提取。仅会在工作区生成 VS Code 代码补全所需的辅助配置。
</details>

<details>
<summary><b>为什么下载或调试提示找不到工具链？</b></summary>
请检查侧栏中的“MounRiver Studio 安装根目录”是否直接指向安装目录根路径，而不是子级目录。
</details>

---

## 开源协议

本项目采用 [GNU General Public License v3.0](LICENSE) 开源协议。

_免责声明：本项目为社区独立开源项目，不隶属于南京沁恒微电子 (WCH) 或 MounRiver Studio 官方。_
