# MounRiver Studio 3 调试接口模式（1-wire / 2-wire）分析

- 分析对象：`D:\mounriver-studio\runtime\MounRiver_Studio3`
- 主体：Electron/VS Code 1.80.2 + `mrs-team.mrs-vscode` 1.1.0
- 关注点：
  1. 工程属性/下载设置中，“Debug Interface Mode（1-wire / 2-wires）”为什么只有部分芯片可选；
  2. 该选择如何保存；
  3. 该选择是否影响 OpenOCD 参数；
  4. 实际下载链路如何使用该选择。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 选项是否可选的判断来源 | 芯片 SDK 资源中的 `<系列>-flash.json` 的 `support_debugInterfaceMode` 字段 |
| 是否还受其他条件限制 | 是。仅 RISC-V 工程显示；`Flash Type = External` 时隐藏 |
| 选择保存到哪里 | `<project>.wvproj` 的 `flashConfig.debug_interface_mode`；同时写入 `<project>/.template` 的 `DebugInterfaceMode=0/1` |
| 是否影响 OpenOCD 参数 | **不影响**。`generateOpenOCDArgs()` 不读取该字段，OpenOCD cfg 也不读取 `.template` |
| OpenOCD 自身是否有 2-wire 能力 | 有。OpenOCD 二进制内有 `two_wires` 配置命令，但 MRS 从未调用 |
| 实际下载是否受影响 | 下载走 `McuCompilerDll.dll`，不是 OpenOCD；该 DLL 直接通过 `WCHLinkDll64.dll` / `CH375Dll64.dll` / `libusb` / HID 与 WCH-Link 通信，不启动 `openocd.exe`。内部 Flash 路径不传接口模式，External Flash 路径把模式编码进 `clkSpeed`（+10/+20） |

---

## 1. 判定来源

### 1.1 UI 条件

文件：

```text
resources/app/extensions/mrs-team.mrs-vscode/resources/html/download/download.js
```

页面初始化/更新时：

```js
"ARM" === useSettingsStore().Basic.architecture
    ? (this.isRVCore = false, this.isARMCore = true, ...)
    : (this.isRVCore = true,  this.isARMCore = false, ...)
```

接口模式下拉框的模板条件：

```html
<el-form-item v-if="isRVCore && !showAsmFile" ...>
  <el-select :disabled="sel_debugInterface" id="sel-dbgmode" ...>
```

其中：

- `isRVCore`：工程架构不是 `ARM`；
- `showAsmFile`：`Flash Type = External` 时为 `true`，即外部 Flash 模式下隐藏该下拉框；
- `sel_debugInterface`：`true` 表示禁用。

读取 `FlashControl` 后：

```js
e.support_debugInterfaceMode
    ? (this.sel_debugInterface = false,   // 允许选择
       this.download.DbgInterfaceMode ||= "1-wire serial")
    : (this.sel_debugInterface = true,    // 禁用
       this.download.DbgInterfaceMode = "")
```

因此实际判定结果：

| 条件 | 表现 |
|---|---|
| `architecture === "ARM"` | 不显示 |
| `Flash Type = External` | 不显示 |
| `support_debugInterfaceMode === false` | 显示但禁用，值被清空 |
| `support_debugInterfaceMode === true` | 可选，默认 `1-wire serial` |

### 1.2 数据来源

`out/extension.js` 中的 `getFlashControl(project)`：

```text
vendor → architecture → chipSerial → osType → chip(zip)
```

匹配到芯片后返回其 `flashControl`。`flashControl` 在解析 SDK 时从以下文件读取：

```text
resources/app/resources/win32/components/<Vendor>/SDK/default/<Arch>/<系列>/<OS>/<系列>-flash.json
```

示例：

```json
{
  "type": "CH32V002/4/5/6/7",
  "id": 78,
  "flash_address": "0x08000000",
  "support_readProtectOpts": true,
  "support_eraseCodeFlash": true,
  "support_memoryAssign": false,
  "support_eraseAll": true,
  "support_program": true,
  "support_verify": true,
  "support_resetRun": true,
  "support_spiPrintf": true,
  "support_debugInterfaceMode": true
}
```

解析逻辑还支持 `special.mcu` / `special.corresponding` 覆盖，但当前这批文件未使用该结构。

### 1.3 当前安装中支持该选项的系列

| 系列 | `type` | `id` |
|---|---|---:|
| CH32V002/004/005/006/007 | `CH32V002/4/5/6/7` | 78 |
| CH32M007 | `CH32M007` | 78 |
| CH32M030 | `CH32M030` | 142 |
| CH32H417 | `CH32H417` | 198 |
| CH32V4X7 | `CH32V4X7` | 166 |
| CH564 | `CH564` | 15 |
| CH572 | `CH570/2` | 139 |
| CH585 | `CH584/5` | 75 |
| CH587 | `CH586/7` | 171 |
| CH595 | `CH595/6` | 203 |

当前安装共有 42 个 `*-flash.json`，其中 14 个为 `true`。

### 1.4 保存位置

保存工程属性时，`out/extension.js` 写入两处：

| 文件 | 字段 | 值 |
|---|---|---|
| `<project>.wvproj` | `flashConfig.debug_interface_mode` | `"1-wire serial"` / `"2-wires serial"` |
| `<project>/.template` | `DebugInterfaceMode` | `0` / `1` |

映射关系：

```text
1-wire serial   → DebugInterfaceMode=0
2-wires serial  → DebugInterfaceMode=1
```

`.template` 示例：

```ini
CLKSpeed=1
DebugInterfaceMode=0
Erase All=true
Program=true
Verify=true
Reset=true
SDIPrintf=false
```

`.wvproj` 示例：

```json
{
  "flashConfig": {
    "clkSpeed": "High",
    "debug_interface_mode": "1-wire serial"
  }
}
```

读取时，`.template` 的 `DebugInterfaceMode` 也会被解析回 `FlashConfig`。

---

## 2. OpenOCD 参数

### 2.1 `generateOpenOCDArgs()` 的位置与输入

函数位于 `out/extension.js` 的 `MRSDebugTool` 类中。

等价签名：

```js
generateOpenOCDArgs(projectFolder, openocdBinDir, openOCDCfg, projectProperties)
```

| 形参 | 实际含义 |
|---|---|
| `projectFolder` | 工程根目录，函数内未使用 |
| `openocdBinDir` | OpenOCD 的 `bin` 目录 |
| `openOCDCfg` | `project.debugConfigurations.openOCDCfg`，含 `gdbport` |
| `projectProperties` | 工程属性，含 `basic.architecture`、双核信息 |

### 2.2 RISC-V 分支

```js
let cfg = "wch-riscv.cfg";
if (isDualCoreMCU(projectProperties)) {
    cfg = "wch-dual-core.cfg";
}

return [
    "-c", `gdb_port ${openOCDCfg.gdbport}`,
    "-s", `"${openocdBinDir.replace(/\\/g, "/")}"`,
    "-f", `${path.join(openocdBinDir, cfg).replace(/\\/g, "/")}`,
    "-c", "dbgtool",
    "-c", "init",
    "-c", "halt"
];
```

### 2.3 ARM 分支

```js
const cfg = "wch-arm.cfg";

return [
    "-c", `gdb_port ${openOCDCfg.gdbport}`,
    "-s", `"${openocdBinDir.replace(/\\/g, "/")}"`,
    "-f", `${path.join(openocdBinDir, cfg).replace(/\\/g, "/")}`,
    "-c", "init",
    "-c", "halt"
];
```

ARM 分支没有 `-c dbgtool`。

### 2.4 参数说明

| 参数 | 作用 |
|---|---|
| `-c "gdb_port N"` | 设置全局 GDB server 端口。`N` 来自 `openOCDCfg.gdbport`，常见值为 `3333` |
| `-s "<bin目录>"` | 增加 OpenOCD 脚本搜索目录；这里传 OpenOCD 的 `bin` 目录 |
| `-f <bin目录>/<cfg>` | 加载 WCH 的 OpenOCD 配置文件 |
| `-c dbgtool` | 仅 RISC-V。WCH 扩展命令，置 `_dbgtool` 标志；`wlink_init` 中该标志非 0 时会把 `0x81 0x0C` 命令的最后一个参数字节置为 `0xFF` |
| `-c init` | 初始化 OpenOCD：打开 WCH-Link、识别芯片、创建 target/flash bank |
| `-c halt` | 初始化完成后暂停 CPU |

### 2.5 实际命令行

RISC-V 单核：

```bat
openocd.exe -c "gdb_port 3333" ^
  -s "D:/.../OpenOCD/bin" ^
  -f D:/.../OpenOCD/bin/wch-riscv.cfg ^
  -c dbgtool -c init -c halt
```

RISC-V 双核：

```bat
openocd.exe -c "gdb_port 3333" ^
  -s "D:/.../OpenOCD/bin" ^
  -f D:/.../OpenOCD/bin/wch-dual-core.cfg ^
  -c dbgtool -c init -c halt
```

ARM：

```bat
openocd.exe -c "gdb_port 3333" ^
  -s "D:/.../OpenOCD/bin" ^
  -f D:/.../OpenOCD/bin/wch-arm.cfg ^
  -c init -c halt
```

### 2.6 配置文件内容

`wch-riscv.cfg`：

```tcl
adapter driver wlinke
adapter speed 6000
transport select sdi

wlink_set_address 0x00000000
set _CHIPNAME wch_riscv
sdi newtap $_CHIPNAME cpu -irlen 5 -expected-id 0x00001

target create $_TARGETNAME.0 wch_riscv -chain-position $_TARGETNAME
$_TARGETNAME.0 configure -work-area-phys 0x20000000 -work-area-size 10000 -work-area-backup 1

flash bank $_FLASHNAME wch_riscv 0x00000000 0 0 0 $_TARGETNAME.0

echo "Ready for Remote Connections"
```

`wch-dual-core.cfg`：

```tcl
adapter driver wlinke
adapter speed 6000
transport select sdi

target create ...cpu.0 wch_riscv -chain-position ... -coreid 0
...cpu.0 configure -gdb-port 3333

target create ...cpu.1 wch_riscv -chain-position ... -coreid 1
...cpu.1 configure -gdb-port 3334
```

`wch-arm.cfg`：

```tcl
adapter driver cmsis-dap
transport select swd
source [find ../share/openocd/scripts/target/ch32f1x.cfg]
```

由此可知：

- `adapter speed 6000` 在 cfg 内，不在命令行；
- `transport select sdi` 在 cfg 内，不在命令行；
- 双核的 `3333/3334` 端口在 cfg 内，会覆盖前面的 `-c "gdb_port ..."`；
- `two_wires` 不在命令行，也不在 cfg 内。

### 2.7 不包含的参数

`generateOpenOCDArgs()` **没有**拼接以下内容：

| 未包含项 | 说明 |
|---|---|
| `tcl_port` / `telnet_port` | `openOCDCfg` 有字段，但该函数不使用 |
| `configOptions` | 调试设置页的 `-c noload`、`-c page_erase`、`-c init -c "wch_riscv unfreeze"` 等不在这里追加 |
| `two_wires` | 没有 |
| `debug_interface_mode` | 没有 |
| `-c "adapter speed ..."` | 没有，cfg 内固定 `6000` |
| `-c "wlink_set_address ..."` | 没有，cfg 内固定 `0x00000000` |

真实工程中 `configOptions` 示例：

```json
{
  "configOptions": ["-f \"${WCH:OpenOCD:default}/bin/wch-riscv.cfg\""]
}
```

它用于 `.launch` 文件的：

```text
com.mounriver.debug.gdbjtag.openocd.gdbServerOther
```

这与 `MRSDebugTool` 的 `generateOpenOCDArgs()` 是两条不同的启动路径。

### 2.8 启动方式与远程模式

`Controller.prepare()`：

```js
if (!debugCfg.useRemote) {
    this.openocd = new OpenOCDServer(openocdExe, openocdArgs);
    await this.openocd.start(openocdBinDir);
}
```

`OpenOCDServer.start()`：

```js
spawn(executable, args, { cwd, env: process.env });
```

因此：

- 本地调试：OpenOCD 以 `bin` 目录为 cwd，按上述参数启动；
- 远程调试（`useRemote === true`）：不启动本地 OpenOCD，`generateOpenOCDArgs()` 的结果被忽略，GDB 直接连接 `127.0.0.1:3456` 的 MRS Remote Assistant。

> 注意：`spawn` 未使用 shell，而 `-s` 的值又手工加了双引号，因此传给进程的 argv 中该值本身可能带引号。这是代码现状。

---

## 3. OpenOCD 的 2-wire 能力

### 3.1 `two_wires` 命令

对 `openocd.exe`（SHA-256 `0f49153f490e8d89b391da9717e01f67c380f641c59600aec483113762469b65`）的静态分析：

| 符号/地址 | 行为 |
|---|---|
| `two_wires` @ `0x43124a` | 将全局字节 `_entwowires`（`0x78a236`）置为 1，无参数 |
| `wlink_init` @ `0x42f096` | 若 `_entwowires != 0` 且芯片在内部白名单内，向 WCH-Link 发送 `81 0D 02 EE 03`；否则日志输出 `The Chip do not support two-wires mode!` |
| `wlink_clean` @ `0x42d5f3` | 若 `_entwowires != 0`，发送 `81 0D 02 EE 03` 而不是 `... 02` |

`two_wires` 是 OpenOCD 的 configuration command，必须在 `init` 之前执行。放在 `init` 之后会报：

```text
Error: The 'two_wires' command must be used before 'init'.
```

### 3.2 MRS 是否调用 `two_wires`

没有。

在 MRS 安装目录中搜索 `two_wires`，只命中：

```text
components/WCH/OpenOCD/OpenOCD/bin/openocd.exe
components/WCH/OpenOCD/OpenOCD/scripts/...
components/WCH/OpenOCD/OpenOCD/share/openocd/scripts/...
```

MRS 的 `extension.js`、webview、`.launch`、`.cproject` 中都没有调用。

因此：

> 在工程属性中选择 2-wire，不会让 OpenOCD 进入 2-wire 模式。  
> 若要让 OpenOCD 走 2-wire，需要手动在 OpenOCD 的 `Config options` 中加入 `-c two_wires`，并确保它位于 `-c init` 之前。

### 3.3 单线与双线的差异

OpenOCD 侧没有两套驱动。`wch-riscv.cfg` 始终使用同一套配置：

```tcl
adapter driver wlinke
adapter speed 6000
transport select sdi
```

单线和双线的差别只在 **WCH-Link 的模式切换 USB 命令**上，target、flash bank、GDB 端口、内存访问和 flash 算法都不变。

| 项目 | 1-wire | 2-wire |
|---|---|---|
| OpenOCD transport | `sdi` | `sdi` |
| adapter driver | `wlinke` | `wlinke` |
| adapter speed | `6000` kHz | `6000` kHz |
| target 类型 | `wch_riscv` | `wch_riscv` |
| flash bank | `wch_riscv` | `wch_riscv` |
| WCH-Link 模式命令 | `81 0D 02 EE 02` | `81 0D 02 EE 03` |
| 触发方式 | 默认；`_entwowires == 0` | `two_wires` 置 `_entwowires = 1` |
| 发送时机 | `wlink_init` 中作为基线握手 | `wlink_init` 在基线握手和芯片识别之后追加 |
| 芯片白名单 | 代码中的固定列表 | OpenOCD 内部另一份固定列表 |
| 不支持时 | 正常继续 | 打印 `The Chip do not support two-wires mode!` 后继续，通常仍按 1-wire 工作 |

关键点：

1. **单线是默认路径**。`_entwowires` 是 BSS 全局，默认 0；不执行 `two_wires` 时，OpenOCD 不会发送 `...03`。
2. **双线是追加，不是替换**。`wlink_init` 先发送基线 `...02`，完成芯片识别后，若 `_entwowires` 为 1 且芯片在白名单内，再发送 `...03`。
3. **`two_wires` 是全局标志**。它没有参数，也不区分 target；同一次 OpenOCD 进程内所有后续 `init`/`clean` 都受影响。
4. **必须在 `init` 之前执行**。放在 `init` 之后会报 `The 'two_wires' command must be used before 'init'.`
5. **UI 列表与 OpenOCD 白名单不是同一份**。例如 CH32X315 的 `support_debugInterfaceMode` 为 `false`，但 OpenOCD 的 `_riscvchip` 白名单包含 `0xE6`（CH32X315）；反之，UI 为 `true` 的 CH32V002 系列（`0x4E`）不在 `wlink_init` 直接比较的 `_riscvchip` 列表中。最终是否成功以 OpenOCD 日志为准。
6. **不支持时不会硬失败**。日志为 `The Chip do not support two-wires mode!`，随后继续执行芯片初始化；实际通常仍是 1-wire。

从单线角度反推：

- OpenOCD 没有单独的“单线下载”代码路径；单线就是默认路径。
- 对支持模式切换的芯片，`wlink_init` 会发送 `...02` 作为基线；对不在列表中的芯片，连这条命令也不发送，直接使用 WCH-Link 当前模式。
- 双线只是在这个基线上额外发送 `...03`，因此单线调试/下载的行为可以由“不执行 `two_wires` 的 OpenOCD 路径”直接确定。

---

## 4. 实际下载链路

MRS 的 Download 不走 OpenOCD，也不是 DLL 去调用 OpenOCD，而是 `McuCompilerDll.dll` 直接通过 USB 与 WCH-Link 通信。

### 4.1 不调用 OpenOCD 的证据

对 `McuCompilerDll.dll`（SHA-256 `766866693a10b101dedfc3367bbb0c19ad6610636ee52e16c0ca780dd555f770`）的静态分析：

| 证据 | 结果 |
|---|---|
| 字符串 | 不存在 `openocd`、`OpenOCD`、`wch-riscv`、`openocd.exe`、`.cfg`、`adapter`、`transport`、`two_wire` |
| 导入表 | 导入 `libusb-1.0.dll` 的 `libusb_init/open/claim_interface/bulk_transfer/...`，以及 `HID.DLL`、`SETUPAPI.dll` |
| 进程创建 API | 未导入 `CreateProcessA/W`、`WinExec`、`system`；下载调用链中也没有 `ShellExecuteA` |
| `McuCompiler_OpenDevice` @ `0x18000a350` | 转到 `FUN_18000a1f0` @ `0x18000a1f0`：`LoadLibraryA("CH375Dll64.dll")` 或 `"WCHLinkDll64.dll"`，解析 `CH375OpenDevice`、`CH375CloseDevice`、`CH375SetTimeoutEx`、`CH375ReadEndP`、`CH375WriteEndP` |
| `MRSFunc_FlashOperation` @ `0x180010860` | 调用 `FUN_18000a1f0(1)`（加载 `WCHLinkDll64.dll`），随后调用 `McuCompiler_SetTwolineLowSpeed`、`McuCompiler_SetChipType`、`McuCompiler_Clear`、`McuCompiler_Download`、`McuCompiler_Reset` 等内部函数 |

`McuCompiler_SetTwolineLowSpeed(chipID, clkSpeed)` 是原生库内部函数，`MRSFunc_FlashOperation` 会无条件调用它；它的入参不是 UI 的 `debug_interface_mode`。这说明原生下载库自己根据芯片和速度处理 two-line 低速模式，而不是读取工程属性中的接口模式。

### 4.2 原生接口

```text
MRSFunc_FlashOperationExB(chipID, clkSpeed, optionFlags, address, file)
MRSFunc_FlashOperationExternal(chipID, clkSpeed, memMode, address, file, algoFile)
```

`extension.js` 调用处：

- 内部 Flash：

  ```js
  mrsMcuFlashOperationEx(chipID, clkSpeed, optionFlags, address, file)
  ```

  `clkSpeed` 仅为 `1/2/3`（High/Middle/Low），**没有接口模式参数**。

- `Flash Type = External`：

  ```js
  g = 10 + clkSpeed;  // 1-wire
  // 或
  g = 20 + clkSpeed;  // 2-wire
  mrsMcuFlashOperationExternal(chipID, g, memMode, address, file, algoFile)
  ```

  这是唯一显式把接口模式传给原生库的路径。

### 4.3 External 模式的矛盾点

UI 在 `Flash Type = External` 时把 `showAsmFile` 置为 `true`，而接口模式下拉框的 `v-if` 是：

```html
v-if="isRVCore && !showAsmFile"
```

因此外部 Flash 模式下下拉框反而被隐藏。External 分支使用的值只能来自之前内部 Flash 模式下保存的 `debug_interface_mode`。

### 4.4 内存分配操作

下载页的 “MCU 内存分配” 操作会把接口模式作为第三个参数传给原生 `MRSFunc_GetMemType`：

```js
[clkSpeed, chipID, interfaceMode]  // 0 = 1-wire, 1 = 2-wire
```

这同样属于原生库通道，与 OpenOCD 无关。

---

## 5. 调试路径区分

| 路径 | 入口 | OpenOCD 参数来源 |
|---|---|---|
| 标准调试（F5） | `mrs-vscode.startDebug` → `mrs.debug.debug` | `.launch` 的 `gdbServerOther`，内容来自 `openOCDCfg.configOptions` |
| MRS 内置调试工具 | `MRSDebugTool` → `Controller.prepare()` | `generateOpenOCDArgs()` 生成的固定参数 |
| 读内存/读寄存器 | `openocdReadMemory()` / `openocdReadRegisters()` | 硬编码 `-f wch-riscv.cfg -c init -c halt` |

`generateOpenOCDArgs()` 属于第二条路径。标准 F5 路径的 `configOptions` 可以包含：

```text
-f "${WCH:OpenOCD:default}/bin/wch-riscv.cfg"
-c noload
-c page_erase
-c init -c "wch_riscv unfreeze"
```

但同样不包含 `two_wires`。

---

## 6. 建议

1. **如果目标是让 OpenOCD 使用 2-wire**：
   - 在 OpenOCD 配置中加入 `two_wires`，且必须位于 `init` 之前；
   - 确认芯片在 OpenOCD 的 2-wire 白名单内，否则会打印 `The Chip do not support two-wires mode!`；
   - 仅修改工程属性的 Debug Interface Mode 不会生效。

2. **如果目标是让原生下载使用 2-wire**：
   - 当前内部 Flash 路径没有把 UI 的 `debug_interface_mode` 传给原生库；
   - `MRSFunc_FlashOperation` 内部会调用 `McuCompiler_SetTwolineLowSpeed(chipID, clkSpeed)`，这是原生库自己的 two-line 低速处理，不读取工程属性；
   - External Flash 路径通过 `clkSpeed + 10/20` 传递，但 UI 在 External 模式下隐藏了下拉框；
   - 若必须让工程属性直接控制内部 Flash 的 2-wire，需要修改 `extension.js` 的调用参数或扩展 `McuCompilerDll.dll` 的接口，当前版本没有这条映射。

3. **如果只是维护 UI 支持列表**：
   - 修改对应 `<系列>-flash.json` 的 `support_debugInterfaceMode` 即可；
   - 不需要改 `extension.js` 或 webview 代码。

---

## 7. 证据与限制

### 证据

- UI 判定与保存：`resources/app/extensions/mrs-team.mrs-vscode/resources/html/download/download.js`、`out/extension.js`
- 芯片标志：`resources/app/resources/win32/components/*/SDK/default/*/*/NoneOS/*-flash.json`
- OpenOCD 参数：`out/extension.js` 的 `generateOpenOCDArgs()`
- OpenOCD cfg：`components/WCH/OpenOCD/OpenOCD/bin/wch-riscv.cfg`、`wch-dual-core.cfg`、`wch-arm.cfg`
- `two_wires` 行为：Ghidra 反编译 `openocd.exe`，地址 `0x43124a`、`0x42f096`、`0x42d5f3`
- 原生下载：`out/extension.js` 的 `DownloadOperation`、`McuCompilerDll.dll` 导出
- 原生下载不调用 OpenOCD：`McuCompilerDll.dll` 的导入表/字符串、`McuCompiler_OpenDevice` @ `0x18000a350`、`FUN_18000a1f0` @ `0x18000a1f0`、`MRSFunc_FlashOperation` @ `0x180010860`

### 限制

- 未验证 `.template` 的 `DebugInterfaceMode` 是否被 WCHToolKit / WCH-LinkUtility 读取；当前 OpenOCD 二进制中不存在 `.template`、`DebugInterfaceMode`、`McuCompiler` 字符串。
- 未动态抓取 WCH-Link USB 流量；`0x81 0x0D 0x02 0xEE 0x02/0x03` 的语义来自静态反编译。
- 已静态确认 `McuCompilerDll.dll` 不启动 `openocd.exe`，也未导入进程创建 API；但未动态验证 `McuCompiler_SetTwolineLowSpeed` 的具体判定条件及其与 WCH-Link 当前模式的关系。
