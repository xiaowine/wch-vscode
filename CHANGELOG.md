# 更新日志

本文档记录 WCH VS Code Extension 的主要变更。

## [0.0.3] - 2026-05-24

### 新增

- 添加扩展图标配置，使用 `media/wch-vscode-sidebar.png` 作为插件图标。
- 添加仓库、主页和问题反馈链接，方便用户访问 GitHub 项目。
- 添加中文 manifest 本地化文件 `package.nls.zh-cn.json`。
- 添加英文运行时语言文件 `src/i18n/en.ts`，并根据 VS Code 显示语言切换中英文文案。
- 添加英文 README `README.en.md`，并在中英文 README 顶部增加语言跳转链接。

### 优化

- 重写中文 README，用更直接的方式介绍插件用途、主要功能、安装配置、命令快捷键和当前支持范围。
- 精简安装配置说明，突出 MRS2 安装目录配置。
- 调整主要功能描述，重点说明工程自动识别解析、编译、下载、断点调试和 C/C++ 代码提示。
- 默认快捷键说明改为与 MRS2 保持一致。
- 将侧边栏 SVG 图标固定为白色，改善活动栏显示效果。

### 变更

- 将协议声明改为 `GPL-3.0-only`。
- 将默认 manifest 文案保持为英文，中文文案移动到 `package.nls.zh-cn.json`。

## [0.0.1]

### 新增

- 初始版本。
- 支持识别 WCH MounRiver Studio 2 RISC-V 工程。
- 支持编译、清理、下载、编译并下载、调试等基础命令。
- 支持侧边栏展示工程信息。
- 支持生成 Microsoft C/C++ 扩展使用的 `.vscode/c_cpp_properties.json`。
