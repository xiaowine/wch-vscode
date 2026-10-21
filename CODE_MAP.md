# 代码地图

本文件描述仓库的模块划分、关键数据流和约定，便于快速定位改动点。

## 1. 入口与激活流程

`src/extension.ts`

1. 首次激活时显示一次非官方声明（`globalState` 记录）。
2. 创建三个视图提供器：
   - `WchVscodeSidebarProvider`：概览视图（工程信息）
   - `WchProjectFilesProvider`：资源管理器中的“WCH 文件”视图
   - `WchToolsSidebarProvider`：设置与工具视图
3. 创建状态栏项，并注册工作区刷新监听。
4. `initializeProjectState` 执行首次项目检测，缺少 cpptools 配置时自动生成。
5. 注册命令：刷新、编译、清理、清理并编译、下载、编译并下载、调试、掉电复位、复制侧栏值、生成 C/C++ 配置、在 MRS 中打开项目、打开设置。

命令 ID 统一使用 `wchVscode.*`，与 `package.json` 的 `contributes.commands` 对应。

## 2. 工程检测与解析

| 文件 | 职责 |
| --- | --- |
| `src/projectDetection.ts` | 扫描工作区根目录的 `.cproject`、`.launch`、`.wvproj`；**不递归子目录**；监听文件变化并刷新视图 |
| `src/xmlParser.ts` | 读取 `.cproject`/`.launch` XML 与 `.wvproj` JSON，做结构校验 |
| `src/projectState.ts` | 全局缓存检测结果和解析结果（`setWchProjectState` / `getWchProjectState`） |
| `src/projectModelBuilder.ts` | 把三个文件合并成 `WchProjectModel`（identity/target/build/debug/flash） |
| `src/models/WchProjectModel.ts` | 模型类型定义 |

关键约定：

- 只有工作区根目录下的 `.wvproj` 才被视为工程。
- `model.identity.folderPath` 是 `.wvproj` 所在目录，不是工作区根目录。
- `.wvproj` 中的 `${project}` 与 `linkedFolders.location` 都以工程目录为基准。
- `linkedFolders` 的实际路径 = `path.resolve(identity.folderPath, location)`。

## 3. 构建流程

| 文件 | 职责 |
| --- | --- |
| `src/build/buildMethod.ts` | 读取 `wchVscode.buildMethod`：`make`（默认）或 `mrs-cli` |
| `src/build/buildProjectResolver.ts` | 解析当前工程、工具链、链接脚本、源文件、输出目录和产物路径 |
| `src/build/makefileGenerator.ts` | 生成 `makefile`、`sources.mk`、`objects.mk`、`subdir.mk` |
| `src/build/buildProjectTask.ts` | 编译/清理/清理并编译入口，`make` 模式通过 `vscode.ProcessExecution` 执行 |
| `src/build/mrsCliBuild.ts` | `mrs-cli` 模式：`spawn` MRS `--mrsSilentType=...` |
| `src/build/mrsCliOutput.ts` | 解析 MRS 静默构建日志中的成功/失败标记 |
| `src/build/downloadProjectTask.ts` | OpenOCD 下载与擦除参数；下载输出写入共享面板 |
| `src/build/openOcdOutput.ts` | 下载与掉电复位共用的“WCH 下载/复位”终端 |
| `src/build/powerOffReset.ts` | 掉电复位：设置读取、OpenOCD 断电/上电参数、两次进程调用 |
| `src/build/powerOffResetCommand.ts` | 手动掉电复位命令 |
| `src/build/buildDownloadProjectTask.ts` | 编译并下载组合命令 |
| `src/build/taskExecution.ts` | 等待 VS Code 任务结束并取退出码 |
| `src/build/buildShared.ts` | MRS 安装路径、工具链/OpenOCD 路径、环境变量清理等共享逻辑 |

路径约定：

- 输出目录 = `identity.folderPath / build.configName`（通常 `obj`）。
- `make` 模式下，makefile 内尽量写**相对输出目录**的路径，避免 GNU make 按 ANSI 代码页解析中文路径。
- 工具链绝对路径在路径含非 ASCII 字符时无法相对化，保持原样。
- 构建前生成文件，清理时直接删除输出目录。

## 4. 调试流程

| 文件 | 职责 |
| --- | --- |
| `src/debug/debugProjectCommand.ts` | 调试命令入口：先编译，再启动调试会话 |
| `src/debug/debugConfig.ts` | 生成 GDB/OpenOCD 启动配置与参数 |
| `src/debug/wchRiscvDebugAdapter.ts` | 自定义调试适配器（DAP），驱动 GDB/MI |
| `src/debug/miParser.ts` | 解析 GDB/MI 输出 |
| `src/debug/debugLog.ts` | 调试输出通道与请求跟踪 |

## 5. 视图与提示

| 文件 | 职责 |
| --- | --- |
| `src/sidebar/WchVscodeSidebarProvider.ts` | 概览视图：工程、目标、构建、调试、下载信息 |
| `src/sidebar/WchProjectFilesProvider.ts` | “WCH 文件”视图：工程本地目录 + `linkedFolders` |
| `src/sidebar/WchToolsSidebarProvider.ts` | 设置与工具视图：MRS 路径、编译方式、复位方式（掉电时显示复位电压、重新上电等待时间）、在 MRS 中打开 |
| `src/projectConfigurationPrompt.ts` | 工程缺少下载/调试配置时的提示 |
| `src/mounRiverStudioLauncher.ts` | 定位当前工程并启动 MRS |
| `src/cpptoolsConfigGenerator.ts` | 生成 `.vscode/c_cpp_properties.json` |

## 6. 国际化

- `src/i18n.ts`：按 `vscode.env.language` 选择语言，提供 `t(key, values)`。
- `src/i18n/zh-cn.ts`、`src/i18n/en.ts`：消息表，新增文案必须两边同时添加。

## 7. 构建与测试命令

```bash
pnpm install          # 安装依赖
pnpm run compile      # tsc --noEmit + esbuild 打包
pnpm run watch        # tsc watch
pnpm run lint         # ESLint
pnpm test             # 编译 + lint + VS Code 测试
pnpm run package      # vsce 打包
```

- 编译产物：`out/extension.js`、`out/debug/wchRiscvDebugAdapter.js`（esbuild）。
- 测试源码：`src/test/wchVscode.test.ts`。

## 8. 已知问题

- `.vscode-test.mjs` 的 `files` 指向 `out/tests/**/*.test.js`，而编译产物在 `out/test/**`，直接执行 `pnpm test` 会匹配不到用例。
- `pnpm run compile` 不再用 tsc 输出测试文件，运行测试前需要额外编译 `src/test`。
