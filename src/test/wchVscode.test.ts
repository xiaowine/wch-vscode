import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";
import type { WchProjectModel } from "../models/WchProjectModel";
import {
  buildMarch,
  createMounRiverStudioEnvironment,
  resolveCompilerExecutableName,
  resolveGdbExecutableName,
  resolveMounRiverOpenOcdExecutable,
  resolveMounRiverOpenOcdValue,
  resolveMounRiverStudioExecutable,
  normalizeOpenOcdChipId,
  resolveOpenOcdPaths,
  resolveToolchainDirectoryName,
} from "../build/buildShared";
import {
  buildOpenOcdDownloadArgs,
  normalizeFlashAddress,
  toOpenOcdPath,
} from "../build/downloadProjectTask";
import { buildOpenOcdPowerCycleArgs } from "../build/powerOffReset";
import {
  OPEN_POWER_OFF_DELAY_SETTING_COMMAND,
  OPEN_POWER_OUTPUT_SETTING_COMMAND,
  OPEN_RESET_MODE_SETTING_COMMAND,
  WchToolsSidebarProvider,
} from "../sidebar/WchToolsSidebarProvider";
import {
  resolveProjectFileSystemPath,
  toLogicalProjectPath,
} from "../build/buildProjectResolver";
import type { ResolvedBuildProject } from "../build/buildProjectResolver";
import {
  buildOpenOcdServerArgs,
  resolveConfiguredOpenOcdExecutable,
} from "../debug/debugConfig";
import { decodeGdbPath, resolveGdbBreakpointFile, resolveGdbFilePath } from "../debug/gdbPath";
import { getList, getString, getTuple, parseMiLine } from "../debug/miParser";
import { detectProjectInFolder } from "../projectDetection";
import { buildWchProjectModels } from "../projectModelBuilder";
import type { ParsedWchProject } from "../projectState";
import { MounRiverLineColorizer, MounRiverOutputFilter } from "../build/mrsCliOutput";
suite("wch-vscode Test Suite", () => {
  vscode.window.showInformationMessage("Start wch-vscode tests.");

  test("project detection rejects empty required files and reports errors", async () => {
    const folderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "wch-vscode-invalid-"),
    );

    try {
      await fs.writeFile(path.join(folderPath, ".cproject"), "");
      await fs.writeFile(path.join(folderPath, "DemoProject.wvproj"), "");

      const result = await detectProjectInFolder({
        uri: vscode.Uri.file(folderPath),
        name: "InvalidProject",
        index: 0,
      });

      assert.strictEqual(result.isTargetProject, false);
      assert.strictEqual(result.validationErrors.length, 2);
      assert.ok(
        result.validationErrors.some(
          (error) => error.fileName === ".cproject",
        ),
      );
      assert.ok(
        result.validationErrors.some(
          (error) => error.fileName === "DemoProject.wvproj",
        ),
      );
    } finally {
      await fs.rm(folderPath, { recursive: true, force: true });
    }
  });

  test("project detection rejects structurally invalid required files", async () => {
    const folderPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "wch-vscode-invalid-structure-"),
    );

    try {
      await fs.writeFile(path.join(folderPath, ".cproject"), "<notCProject />");
      await fs.writeFile(path.join(folderPath, "DemoProject.wvproj"), "{}");

      const result = await detectProjectInFolder({
        uri: vscode.Uri.file(folderPath),
        name: "InvalidProjectStructure",
        index: 0,
      });

      assert.strictEqual(result.isTargetProject, false);
      assert.strictEqual(result.validationErrors.length, 2);
      assert.ok(
        result.validationErrors.every((error) => error.message.length > 0),
      );
    } finally {
      await fs.rm(folderPath, { recursive: true, force: true });
    }
  });

  test("resolveToolchainDirectoryName maps supported WCH toolchains", () => {
    assert.strictEqual(
      resolveToolchainDirectoryName(
        "${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe",
      ),
      "RISC-V Embedded GCC",
    );
    assert.strictEqual(
      resolveToolchainDirectoryName(
        "${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe",
      ),
      "RISC-V Embedded GCC12",
    );
    assert.strictEqual(
      resolveToolchainDirectoryName(
        "${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe",
      ),
      "RISC-V Embedded GCC15",
    );
  });

  test("build resolver maps linked folder project paths", () => {
    const model = createModel();
    const sourcePath = resolveProjectFileSystemPath(
      model,
      "${project}/Core/startup/startup_ch32v00x.S",
    );
    assert.strictEqual(
      sourcePath,
      path.resolve(
        model.identity.folderPath,
        "..\\shared\\Core",
        "startup",
        "startup_ch32v00x.S",
      ),
    );
    assert.strictEqual(
      toLogicalProjectPath(model, sourcePath),
      "Core/startup/startup_ch32v00x.S",
    );
  });

  test("build resolver uses the wvproj directory for nested projects", () => {
    const workspacePath = "C:\\workspace\\中文\\ADC";
    const projectPath = path.join(workspacePath, "ADC_DMA");
    const parsedProject = createParsedProject({});
    parsedProject.folderPath = workspacePath;
    parsedProject.projectPairs[0].wvproj.filePath = path.join(
      projectPath,
      "ADC_DMA.wvproj",
    );
    const wvprojData = parsedProject.projectPairs[0].wvproj.data as {
      basic: { linkedFolders: unknown };
    };
    wvprojData.basic.linkedFolders = [
      { name: "Ld", location: "../../SRC/Ld" },
    ];

    const models = buildWchProjectModels(parsedProject);
    assert.strictEqual(models.length, 1);

    const model = models[0];
    const linkerScriptPath = resolveProjectFileSystemPath(
      model,
      "${project}/Ld/Link.ld",
    );
    assert.strictEqual(model.identity.folderPath, projectPath);
    assert.strictEqual(
      linkerScriptPath,
      path.resolve(projectPath, "../../SRC/Ld", "Link.ld"),
    );
    assert.strictEqual(toLogicalProjectPath(model, linkerScriptPath), "Ld/Link.ld");
  });

  test("build resolver maps MRS build-directory relative paths", () => {
    const model = createModel();
    model.build.configName = "Debug";
    assert.strictEqual(
      resolveProjectFileSystemPath(model, "../StdPeriphDriver/inc"),
      path.resolve(model.identity.folderPath, "StdPeriphDriver", "inc"),
    );
  });

  test("build resolver maps MRS build-directory relative linked folder paths", () => {
    const model = createModel();
    model.build.configName = "Debug";
    assert.strictEqual(
      resolveProjectFileSystemPath(model, "../Core/startup"),
      path.resolve(model.identity.folderPath, "..\\shared\\Core", "startup"),
    );
  });

  test("buildMarch keeps zmmul suffix ordering", () => {
    const model = createModel();
    model.build.riscvExtensions = ["M", "A", "C", "Zmmul"];
    assert.strictEqual(buildMarch(model), "rv32imac_zmmul");
  });

  test("buildMarch expands B extension to Z sub-extensions", () => {
    const model = createModel();
    model.build.riscvExtensions = ["M", "C", "B"];
    assert.strictEqual(buildMarch(model), "rv32imc_zba_zbb_zbc_zbs");
  });

  test("buildMarch appends XW directly when no Z-extensions", () => {
    const model = createModel();
    model.build.riscvExtensions = ["M", "C", "XW"];
    assert.strictEqual(buildMarch(model), "rv32imcxw");
  });

  test("buildMarch places XW after Z sub-extensions with underscore", () => {
    const model = createModel();
    model.build.riscvExtensions = ["M", "C", "XW", "B"];
    assert.strictEqual(buildMarch(model), "rv32imc_zba_zbb_zbc_zbs_xw");
  });

  test("download normalizes mapped flash alias addresses for OpenOCD", () => {
    assert.strictEqual(normalizeFlashAddress("0x08000000"), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("0x00000000"), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("  0x08000000  "), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("0x08004000"), "0x08004000");
    assert.strictEqual(normalizeFlashAddress("main"), "main");
  });

  test("download adds flash mcu type before initializing OpenOCD", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH59x";
    project.model.flash.address = "0x00000000";

    assert.deepStrictEqual(
      buildOpenOcdDownloadArgs(
        project,
        "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
        "C:\\workspace\\DemoProject\\obj\\DemoProject.hex",
      ),
      [
        "-f",
        "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
        "-c",
        "chip_id CH59x",
        "-c",
        "init",
        "-c",
        "halt",
        "-c",
        'program "C:/workspace/DemoProject/obj/DemoProject.hex" 0x00000000 verify reset exit',
      ],
    );
  });

  test("download openocd args enable two-wire before init", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH32V003";
    project.model.flash.debugInterfaceMode = "2-wires serial";

    const args = buildOpenOcdDownloadArgs(
      project,
      "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
      "C:\\workspace\\DemoProject\\obj\\DemoProject.hex",
    );
    assert.strictEqual(args.filter((arg) => arg === "two_wires").length, 1);
    assert.ok(args.indexOf("two_wires") < args.indexOf("init"));
  });

  test("download power-on and program share one OpenOCD session", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH32L10x";

    const args = buildOpenOcdDownloadArgs(
      project,
      "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
      "C:\\workspace\\DemoProject\\obj\\DemoProject.hex",
      "3v3",
    );

    assert.ok(args.includes("dbgtool"));
    assert.ok(args.includes("pow3v3 on"));
    assert.ok(args.indexOf("pow3v3 on") < args.indexOf("init"));
    assert.ok(args.indexOf("dbgtool") < args.indexOf("init"));
    assert.ok(args[args.length - 1].includes("program"));
  });

  test("download openocd args reset exactly once after program", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH59x";

    const args = buildOpenOcdDownloadArgs(
      project,
      "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
      "C:\\workspace\\DemoProject\\obj\\DemoProject.hex",
    );

    const programCommand = args[args.length - 1];
    assert.ok(programCommand.includes("verify"));
    assert.ok(programCommand.includes("reset"));
    assert.ok(programCommand.includes("exit"));
    assert.strictEqual(programCommand.match(/\breset\b/g)?.length, 1);
  });

  test("power-off reset args place power commands before init", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH32V003";
    project.model.flash.debugInterfaceMode = "2-wires serial";
    const configPath = "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg";

    assert.deepStrictEqual(
      buildOpenOcdPowerCycleArgs(project, configPath, "off", false),
      [
        "-c",
        "gdb_port disabled",
        "-c",
        "telnet_port disabled",
        "-c",
        "tcl_port disabled",
        "-f",
        configPath,
        "-c",
        "chip_id CH32V003",
        "-c",
        "dbgtool",
        "-c",
        "two_wires",
        "-c",
        "pow3v3 off",
        "-c",
        "init",
        "-c",
        "shutdown",
      ],
    );

    const onArgs = buildOpenOcdPowerCycleArgs(
      project,
      configPath,
      "on",
      true,
    );
    assert.ok(onArgs.includes("pow3v3 on"));
    assert.ok(!onArgs.includes("pow5v on"));
    assert.ok(onArgs.indexOf("pow3v3 on") < onArgs.indexOf("init"));
    assert.ok(onArgs.indexOf("halt") > onArgs.indexOf("init"));
    assert.ok(onArgs.indexOf("shutdown") > onArgs.indexOf("halt"));
  });

  test("power-off reset switches only the selected reset voltage", () => {
    const project = createResolvedBuildProject();
    project.model.flash.mcuType = "CH32V003";

    const args = buildOpenOcdPowerCycleArgs(
      project,
      "F:\\MounRiver\\OpenOCD\\bin\\wch-riscv.cfg",
      "off",
      false,
      "5v",
    );

    assert.ok(args.includes("pow5v off"));
    assert.ok(!args.includes("pow3v3 off"));
  });

  test("reset settings and command are registered", async () => {
    const extension = vscode.extensions.getExtension("winerealms.wch-vscode");
    assert.ok(extension);
    await extension.activate();

    const config = vscode.workspace.getConfiguration("wchVscode");
    assert.strictEqual(config.get("resetMode"), "nrst");
    assert.strictEqual(config.get("powerOffDelayMs"), 100);
    assert.strictEqual(config.get("powerOutput"), "3v3");

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("wchVscode.powerOffReset"));
  });

  test("tools sidebar hides power settings for normal reset", () => {
    const provider = new WchToolsSidebarProvider();
    const commandIds = provider
      .getChildren()
      .map((item) =>
        typeof item.command === "object" ? item.command.command : undefined,
      );

    assert.ok(commandIds.includes(OPEN_RESET_MODE_SETTING_COMMAND));
    assert.ok(!commandIds.includes(OPEN_POWER_OUTPUT_SETTING_COMMAND));
    assert.ok(!commandIds.includes(OPEN_POWER_OFF_DELAY_SETTING_COMMAND));
  });

  test("OpenOCD chip id normalization matches MRS aliases", () => {
    assert.strictEqual(normalizeOpenOcdChipId("CH59x"), "CH59x");
    assert.strictEqual(normalizeOpenOcdChipId("CH32V00x"), "CH32V003");
    assert.strictEqual(normalizeOpenOcdChipId("CH56x"), "CH565/9");
  });

  test("wvproj flash mcutype is preserved for OpenOCD", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        flashConfig: {
          mcutype: "CH59x",
        },
      }),
    );

    assert.strictEqual(model.flash.mcuType, "CH59x");
  });

  test("wvproj setBreak=false disables debug stopAt", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        runCommands: {
          setBreak: false,
          setBreakAt: "handle_reset",
        },
      }),
    );

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("wvproj setBreakAt is ignored", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        runCommands: {
          setBreak: true,
          setBreakAt: "custom_boot_entry",
        },
      }),
    );

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("linker raw long options are normalized for gcc forwarding", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        linkerMisc: {
          linker_flags: ["--print-memory-usage"],
        },
      }),
    );

    assert.ok(model.build.linker.args.includes("-Wl,--print-memory-usage"));
    assert.strictEqual(
      model.build.linker.args.includes("--print-memory-usage"),
      false,
    );
  });

  test("launch setStopAt does not affect debug stopAt", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        launchBooleans: {
          "org.eclipse.cdt.debug.gdbjtag.core.setStopAt": true,
        },
        launchStrings: {
          "org.eclipse.cdt.debug.gdbjtag.core.stopAt": "handle_reset",
        },
      }),
    );

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("compiler executable follows model build prefix", () => {
    assert.strictEqual(
      resolveCompilerExecutableName(
        "${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv-none-embed-gcc.exe",
    );
    assert.strictEqual(
      resolveCompilerExecutableName(
        "${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv-wch-elf-gcc.exe",
    );
    assert.strictEqual(
      resolveCompilerExecutableName(
        "${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv32-wch-elf-gcc.exe",
    );
  });

  test("gdb executable follows model build prefix", () => {
    assert.strictEqual(
      resolveGdbExecutableName(
        "${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv-none-embed-gdb.exe",
    );
    assert.strictEqual(
      resolveGdbExecutableName(
        "${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv-wch-elf-gdb.exe",
    );
    assert.strictEqual(
      resolveGdbExecutableName(
        "${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe",
      ),
      "riscv32-wch-elf-gdb.exe",
    );
  });

  test("openocd paths are resolved relative to MounRiver Studio root", () => {
    const paths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.strictEqual(
      paths?.root,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD",
    );
    assert.strictEqual(
      paths?.config,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
    assert.strictEqual(
      paths?.executable,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
    assert.strictEqual(
      paths?.scripts,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\share\\openocd\\scripts",
    );
  });

  test("openocd paths are not resolved without MounRiver Studio root", () => {
    assert.strictEqual(resolveOpenOcdPaths(""), undefined);
  });

  test("openocd command paths use forward slashes for Tcl parsing", () => {
    assert.strictEqual(
      toOpenOcdPath(
        "c:\\Users\\xiaow\\Downloads\\hard\\ch32l103\\EXAM\\FreeRTOS\\obj\\FreeRTOS.hex",
      ),
      "c:/Users/xiaow/Downloads/hard/ch32l103/EXAM/FreeRTOS/obj/FreeRTOS.hex",
    );
  });

  test("debug openocd args prefer project launch options", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.debug.openOcdConfigOptions = [
      "-f",
      "interface/wch-link.cfg",
      "-f",
      "target/wch-riscv.cfg",
    ];
    project.model.debug.gdbPort = 3334;
    project.model.debug.telnetPort = 4445;
    project.model.debug.tclPort = 6667;
    project.model.flash.mcuType = "CH59x";

    assert.deepStrictEqual(buildOpenOcdServerArgs(project, openOcdPaths), [
      "-c",
      "gdb_port 3334",
      "-c",
      "telnet_port 4445",
      "-c",
      "tcl_port 6667",
      "-s",
      path.dirname(openOcdPaths.executable),
      "-f",
      "interface/wch-link.cfg",
      "-f",
      "target/wch-riscv.cfg",
      "-c",
      "chip_id CH59x",
      "-c",
      "dbgtool",
      "-c",
      "init",
      "-c",
      "halt",
    ]);
  });

  test("debug openocd args do not duplicate configured chip id", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.debug.openOcdConfigOptions = [
      "-f",
      openOcdPaths.config,
      "-c",
      "chip_id CH59x",
    ];
    project.model.flash.mcuType = "CH59x";

    const args = buildOpenOcdServerArgs(project, openOcdPaths);
    assert.strictEqual(args.filter((arg) => /chip_id/i.test(arg)).length, 1);
  });

  test("debug openocd args fall back to MRS default config", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.debug.openOcdConfigOptions = [];

    assert.deepStrictEqual(buildOpenOcdServerArgs(project, openOcdPaths), [
      "-c",
      "gdb_port 3333",
      "-c",
      "telnet_port 4444",
      "-c",
      "tcl_port 6666",
      "-s",
      path.dirname(openOcdPaths.executable),
      "-f",
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
      "-c",
      "dbgtool",
      "-c",
      "init",
      "-c",
      "halt",
    ]);
  });

  test("debug openocd args enable two-wire before init", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.flash.mcuType = "CH32V003";
    project.model.flash.debugInterfaceMode = "2-wires serial";

    const args = buildOpenOcdServerArgs(project, openOcdPaths);
    assert.ok(args.includes("dbgtool"));
    assert.strictEqual(args.filter((arg) => arg === "two_wires").length, 1);
    assert.ok(args.indexOf("two_wires") < args.indexOf("init"));
    assert.ok(args.indexOf("dbgtool") < args.indexOf("init"));
  });

  test("debug openocd args power on before init in power-off mode", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.flash.mcuType = "CH32L10x";

    const args = buildOpenOcdServerArgs(project, openOcdPaths, "3v3");
    assert.ok(args.includes("pow3v3 on"));
    assert.ok(args.indexOf("pow3v3 on") < args.indexOf("init"));
    assert.ok(args.indexOf("dbgtool") < args.indexOf("init"));
  });

  test("wvproj debug interface mode is preserved", () => {
    const [model] = buildWchProjectModels(
      createParsedProject({
        flashConfig: {
          debug_interface_mode: "2-wires serial",
        },
      }),
    );

    assert.strictEqual(model.flash.debugInterfaceMode, "2-wires serial");
  });

  test("MRS openocd values resolve WCH variable from component root", () => {
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdValue(
        openOcdPaths,
        "${WCH:OpenOCD:default}\\bin\\wch-riscv.cfg",
      ),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
  });

  test("MRS openocd values resolve quoted WCH variable paths", () => {
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdValue(
        openOcdPaths,
        '"${WCH:OpenOCD:default}/bin/wch-riscv.cfg"',
      ),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
  });

  test("MRS openocd executable resolves WCH default variable from install root", () => {
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdExecutable(openOcdPaths, "${WCH:OpenOCD:default}"),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
  });

  test("MRS openocd executable resolves WCH variable suffix from component root", () => {
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdExecutable(
        openOcdPaths,
        "${WCH:OpenOCD:default}\\bin\\openocd.exe",
      ),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
  });

  test("debug openocd executable uses normalized model path", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths(
      "F:\\MounRiver\\MounRiver_Studio2",
    );
    assert.ok(openOcdPaths);
    project.model.debug.openOcdExecutable = openOcdPaths.executable;

    assert.strictEqual(
      resolveConfiguredOpenOcdExecutable(project, openOcdPaths),
      openOcdPaths.executable,
    );
  });

  test("MI parser parses stopped async records", () => {
    const record = parseMiLine(
      '*stopped,reason="breakpoint-hit",frame={func="main",fullname="C:\\\\p\\\\main.c",line="42"}',
    );
    assert.strictEqual(record.kind, "exec");
    if (record.kind !== "exec") {
      return;
    }

    const frame = getTuple(record.results.frame);
    assert.strictEqual(record.asyncClass, "stopped");
    assert.strictEqual(getString(record.results.reason), "breakpoint-hit");
    assert.strictEqual(getString(frame?.func), "main");
    assert.strictEqual(getString(frame?.line), "42");
  });

  test("MI parser parses breakpoint, stack, variables, and error records", () => {
    const breakpoint = parseMiLine(
      '7^done,bkpt={number="1",type="hw breakpoint",disp="keep",enabled="y"}',
    );
    assert.strictEqual(breakpoint.kind, "result");
    if (breakpoint.kind === "result") {
      assert.strictEqual(breakpoint.token, 7);
      assert.strictEqual(
        getString(getTuple(breakpoint.results.bkpt)?.type),
        "hw breakpoint",
      );
    }

    const stack = parseMiLine(
      '8^done,stack=[frame={level="0",func="main",fullname="C:\\\\p\\\\main.c",line="9"}]',
    );
    assert.strictEqual(stack.kind, "result");
    if (stack.kind === "result") {
      const frame = getTuple(getTuple(getList(stack.results.stack)[0])?.frame);
      assert.strictEqual(getString(frame?.fullname), "C:\\p\\main.c");
    }

    const multiFrameStack = parseMiLine(
      '81^done,stack=[frame={level="0",func="task2_task"},frame={level="1",func="vPortTaskWrapper"}]',
    );
    assert.strictEqual(multiFrameStack.kind, "result");
    if (multiFrameStack.kind === "result") {
      const frames = getList(multiFrameStack.results.stack);
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(
        getString(getTuple(getTuple(frames[0])?.frame)?.func),
        "task2_task",
      );
      assert.strictEqual(
        getString(getTuple(getTuple(frames[1])?.frame)?.func),
        "vPortTaskWrapper",
      );
    }

    const variables = parseMiLine(
      '9^done,variables=[{name="counter",value="3"},{name="flag",type="int"}]',
    );
    assert.strictEqual(variables.kind, "result");
    if (variables.kind === "result") {
      assert.strictEqual(
        getString(getTuple(getList(variables.results.variables)[0])?.value),
        "3",
      );
    }

    const error = parseMiLine(
      '10^error,msg="No hardware breakpoint available"',
    );
    assert.strictEqual(error.kind, "result");
    if (error.kind === "result") {
      assert.strictEqual(error.resultClass, "error");
      assert.strictEqual(
        getString(error.results.msg),
        "No hardware breakpoint available",
      );
    }
  });

  test("MRS silent build uses an isolated portable profile", () => {
    const environment = createMounRiverStudioEnvironment(
      "C:\\Users\\test\\AppData\\Local\\wch-vscode\\mrs-cli-portable",
    );

    assert.strictEqual(
      environment.VSCODE_PORTABLE,
      "C:\\Users\\test\\AppData\\Local\\wch-vscode\\mrs-cli-portable",
    );
    assert.strictEqual(environment.ELECTRON_RUN_AS_NODE, undefined);
  });

  test("MRS executable is resolved relative to install root", () => {
    assert.strictEqual(
      resolveMounRiverStudioExecutable("F:\\MounRiver\\MounRiver_Studio2"),
      "F:\\MounRiver\\MounRiver_Studio2\\MounRiver Studio 2.exe",
    );
  });

  test("MRS executable resolves the installed version", async () => {
    const mrs3Root = await fs.mkdtemp(
      path.join(os.tmpdir(), "wch-vscode-mrs3-"),
    );
    const mrs2Root = await fs.mkdtemp(
      path.join(os.tmpdir(), "wch-vscode-mrs2-"),
    );

    try {
      await fs.writeFile(path.join(mrs3Root, "MounRiver Studio 3.exe"), "");
      assert.strictEqual(
        resolveMounRiverStudioExecutable(mrs3Root),
        path.join(mrs3Root, "MounRiver Studio 3.exe"),
      );

      await fs.writeFile(path.join(mrs2Root, "MounRiver Studio 2.exe"), "");
      assert.strictEqual(
        resolveMounRiverStudioExecutable(mrs2Root),
        path.join(mrs2Root, "MounRiver Studio 2.exe"),
      );
    } finally {
      await fs.rm(mrs3Root, { recursive: true, force: true });
      await fs.rm(mrs2Root, { recursive: true, force: true });
    }
  });

  test("MRS output filter drops Electron startup noise", () => {
    const filter = new MounRiverOutputFilter();
    const noisyOutput = [
      "[10244:1021/000438.517:ERROR:jump_list.cc(301)] Failed to append custom category.",
      "undefined",
      "{",
      "  VSCODE_IPC_HOOK: '\\\\\\\\.\\\\pipe\\\\x',",
      "  VSCODE_NLS_CONFIG: '{}'",
      "}",
      "[main 2026-10-20T16:04:38.527Z] ",
      "make -j24 all",
      "[00:01:20] 编译完成 (耗时558ms)",
      "",
    ].join("\r\n");

    let filtered = "";
    for (const chunk of noisyOutput.match(/.{1,7}/gs) ?? []) {
      filtered += filter.push(chunk);
    }
    filtered += filter.flush();

    assert.ok(!filtered.includes("jump_list"));
    assert.ok(!filtered.includes("VSCODE_IPC_HOOK"));
    assert.ok(!filtered.includes("undefined"));
    assert.ok(!filtered.includes("[main "));
    assert.ok(filtered.includes("make -j24 all"));
    assert.ok(filtered.includes("编译完成"));
  });

  test("MRS log colorizer colors diagnostics and status", () => {
    const colorizer = new MounRiverLineColorizer();
    const input = [
      "d:/work/main.c:3:5: error: boom",
      "    3 | int x = ;",
      "      |     ^",
      "d:/work/main.c:9:1: warning: unused",
      "d:/work/main.c:10:1: note: see here",
      "make: *** [makefile:1: all] Error 2",
      "[00:00:01] 编译失败",
      "[00:00:02] 失败",
      "[00:00:03] 成功",
      "[00:00:04] 已取消",
      "",
    ].join("\n");

    const colored = colorizer.push(input);

    // 整行着色，包含文件路径。
    assert.ok(colored.startsWith("\x1b[1;31md:/work/main.c:3:5: error: boom\x1b[0m"));
    assert.ok(colored.includes("\x1b[33md:/work/main.c:9:1: warning: unused\x1b[0m"));
    assert.ok(colored.includes("\x1b[34md:/work/main.c:10:1: note: see here\x1b[0m"));
    assert.ok(colored.includes("\x1b[31m      |     ^\x1b[0m"));
    assert.ok(/\x1b\[31mmake: \*\*\*/.test(colored));
    assert.ok(/\x1b\[31m\[00:00:01\] 编译失败/.test(colored));
    assert.ok(/\x1b\[31m\[00:00:02\] 失败/.test(colored));
    assert.ok(/\x1b\[32m\[00:00:03\] 成功/.test(colored));
    assert.ok(/\x1b\[33m\[00:00:04\] 已取消/.test(colored));
  });

  test("GDB file path is resolved relative to its working directory", () => {
    if (process.platform !== "win32") {
      return;
    }

    assert.strictEqual(
      resolveGdbFilePath("C:\\proj", "C:\\proj\\obj\\a.elf"),
      "obj\\a.elf",
    );
    assert.strictEqual(
      resolveGdbFilePath("C:\\proj", "D:\\other\\a.elf"),
      "D:\\other\\a.elf",
    );
    assert.strictEqual(
      resolveGdbFilePath("", "C:\\proj\\a.elf"),
      "C:\\proj\\a.elf",
    );
  });

  test("GDB paths decode octal escapes and resolve breakpoints", () => {
    if (process.platform !== "win32") {
      return;
    }

    const parsed = parseMiLine('^error,msg="\\326\\320\\316\\304.c"');
    assert.strictEqual(parsed.kind, "result");
    if (parsed.kind === "result") {
      assert.strictEqual(getString(parsed.results.msg), "\u00d6\u00d0\u00ce\u00c4.c");
    }

    assert.strictEqual(decodeGdbPath("\u00d6\u00d0\u00ce\u00c4"), "中文");
    assert.strictEqual(
      resolveGdbBreakpointFile("C:\\proj", "C:\\proj\\User\\main.c"),
      "User\\main.c",
    );
    assert.strictEqual(
      resolveGdbBreakpointFile("C:\\proj", "C:\\proj\\中文\\SRC\\Core\\main.c"),
      "main.c",
    );
  });
});

function createResolvedBuildProject(): ResolvedBuildProject {
  const model = createModel();
  return {
    workspaceFolder: {
      uri: vscode.Uri.file(model.identity.folderPath),
      name: model.identity.folderName,
      index: 0,
    },
    model,
    outputDirectory: path.join(
      model.identity.folderPath,
      model.build.configName,
    ),
    targetBaseName: model.identity.name,
    elfPath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.elf`,
    ),
    hexPath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.hex`,
    ),
    lstPath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.lst`,
    ),
    binPath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.bin`,
    ),
    sizPath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.siz`,
    ),
    mapFilePath: path.join(
      model.identity.folderPath,
      model.build.configName,
      `${model.identity.name}.map`,
    ),
    linkerScriptPath: path.join(model.identity.folderPath, "Ld", "Link.ld"),
    toolchainPaths: {
      rootPath: "F:\\MounRiver\\MounRiver_Studio2",
      make: "F:\\MounRiver\\MounRiver_Studio2\\make.exe",
      gcc: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-gcc.exe",
      gpp: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-g++.exe",
      gdb: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-gdb.exe",
      objcopy: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-objcopy.exe",
      objdump: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-objdump.exe",
      size: "F:\\MounRiver\\MounRiver_Studio2\\riscv-wch-elf-size.exe",
    },
    sources: [],
    otherObjects: [],
    hasCppSources: false,
  };
}

function createParsedProject(options: {
  runCommands?: Record<string, unknown>;
  launchStrings?: Record<string, string>;
  launchBooleans?: Record<string, boolean>;
  linkerMisc?: Record<string, unknown>;
  flashConfig?: Record<string, unknown>;
}): ParsedWchProject {
  const stringAttribute = Object.entries(options.launchStrings ?? {}).map(
    ([key, value]) => ({
      "@_key": key,
      "@_value": value,
    }),
  );
  const booleanAttribute = Object.entries(options.launchBooleans ?? {}).map(
    ([key, value]) => ({
      "@_key": key,
      "@_value": String(value),
    }),
  );

  return {
    folderPath: "C:\\workspace\\DemoProject",
    folderName: "DemoProject",
    cprojectFiles: [],
    projectPairs: [
      {
        baseName: "DemoProject",
        launch: {
          filePath: "C:\\workspace\\DemoProject\\DemoProject.launch",
          fileName: "DemoProject.launch",
          format: "launch-xml",
          data: {
            launchConfiguration: {
              stringAttribute,
              booleanAttribute,
            },
          },
        },
        wvproj: {
          filePath: "C:\\workspace\\DemoProject\\DemoProject.wvproj",
          fileName: "DemoProject.wvproj",
          format: "wvproj-json",
          data: {
            basic: {
              projectName: "DemoProject",
              architecture: "RISC-V",
              chipInfo: {
                toolchain: "RISC-V",
                mcu: "CH32V203",
              },
            },
            buildConfig: {
              configurations: [
                {
                  name: "obj",
                  clinker: {
                    miscellaneous: options.linkerMisc ?? {},
                  },
                },
              ],
            },
            debugConfigurations: {
              startup: {
                runCommands: options.runCommands ?? {},
              },
            },
            flashConfig: options.flashConfig ?? {},
          },
        },
      },
    ],
    models: [],
  };
}

function createModel(): WchProjectModel {
  const assembler = {
    usePreprocessor: true,
    doNotSearchSystemDirectories: false,
    preprocessOnly: false,
    includePaths: [],
    includeSystemPaths: [],
    includeFiles: [],
    definedSymbols: [],
    undefinedSymbols: [],
    assemblerFlags: [],
    generateAssemblerListing: false,
    saveTemporaryFiles: false,
    verbose: false,
    otherAssemblerFlags: [],
    warningFlags: [],
    args: ["-march=rv32imac", "-mabi=ilp32", "-x", "assembler-with-cpp"],
  };
  const c = {
    standard: "gnu11",
    includePaths: [],
    includeSystemPaths: [],
    includeFiles: [],
    definedSymbols: [],
    undefinedSymbols: [],
    doNotSearchSystemDirectories: false,
    doNotSearchSystemCppDirectories: false,
    preprocessOnly: false,
    generateAssemblerListing: false,
    saveTemporaryFiles: false,
    verbose: false,
    optimizationFlags: [],
    warningFlags: [],
    debuggingFlags: [],
    otherCompilerFlags: [],
    args: [
      "-march=rv32imac",
      "-mabi=ilp32",
      "-O0",
      "-ffunction-sections",
      "-fdata-sections",
      "-std=gnu11",
    ],
  };
  const cpp = {
    ...c,
    standard: "gnu++17",
    args: [
      "-march=rv32imac",
      "-mabi=ilp32",
      "-O0",
      "-ffunction-sections",
      "-fdata-sections",
      "-std=gnu++17",
    ],
  };

  return {
    identity: {
      name: "DemoProject",
      baseName: "DemoProject",
      folderPath: "C:\\workspace\\DemoProject",
      folderName: "DemoProject",
      files: {
        cproject: [],
        launch: "",
        wvproj: "",
      },
    },
    target: {
      architecture: "RISC-V",
      toolchain: "RISC-V",
      mcu: "CH32V203",
      rtos: "NoneOS",
      svdPath: "",
      debugLink: "WCH-Link",
      linkedFolders: [
        {
          name: "Core",
          location: "..\\shared\\Core",
        },
      ],
    },
    build: {
      configName: "obj",
      parallelizationNumber: "",
      stopOnFirstBuildError: true,
      preScript: "",
      postScript: "",
      toolchainName: "RISC-V",
      commandPrefix: "riscv-none-embed-",
      compilerPath: "riscv-none-embed-gcc",
      toolchain: {
        directoryName: "RISC-V Embedded GCC12",
        executablePrefix: "riscv-wch-elf-",
        executables: {
          gcc: "riscv-wch-elf-gcc.exe",
          gpp: "riscv-wch-elf-g++.exe",
          gdb: "riscv-wch-elf-gdb.exe",
          objcopy: "riscv-wch-elf-objcopy.exe",
          objdump: "riscv-wch-elf-objdump.exe",
          size: "riscv-wch-elf-size.exe",
        },
      },
      artifact: {
        name: "${ProjName}",
        extension: "elf",
        outputPrefix: "",
        outputFile: "",
      },
      targetArchitecture: "rv32i",
      targetAbi: "ilp32",
      riscvExtensions: ["M", "A", "C"],
      architectureArgs: ["-march=rv32imac", "-mabi=ilp32"],
      cStandard: "gnu11",
      cppStandard: "gnu++17",
      includePaths: [],
      includeSystemPaths: [],
      includeFiles: [],
      definedSymbols: [],
      otherCompilerFlags: [],
      sourceExcludes: [],
      compile: {
        assembler,
        c,
        cpp,
      },
      linker: {
        script: "${project}/Ld/Link.ld",
        libraries: [],
        librarySearchPaths: [],
        linkerFlags: [],
        otherLinkerFlags: [],
        otherObjects: [],
        mapFile: '"${BuildArtifactFileBaseName}.map"',
        args: [
          "-march=rv32imac",
          "-mabi=ilp32",
          "-nostartfiles",
          "-Wl,--gc-sections",
          "--specs=nano.specs",
          "--specs=nosys.specs",
        ],
      },
      postBuild: {
        createFlash: true,
        createBinary: true,
        flashArgs: ["-O", "ihex"],
        createList: true,
        listArgs: ["-x", "-S", "-C", "-l", "-w"],
        printSize: true,
        sizeArgs: ["--format=berkeley"],
      },
    },
    debug: {
      programName: "",
      gdbExecutable: "${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe",
      openOcdExecutable: "",
      openOcdConfigOptions: [],
      host: "localhost",
      gdbPort: 0,
      telnetPort: 0,
      tclPort: 0,
      startupCommands: [],
      stopAt: "",
      firstResetType: "",
      secondResetType: "",
    },
    flash: {
      mcuType: "",
      targetPath: "",
      address: "",
      erase: false,
      program: false,
      verify: false,
      reset: false,
      debugInterfaceMode: "",
    },
  };
}
