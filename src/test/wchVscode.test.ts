import * as assert from "assert";
import * as path from "node:path";

import * as vscode from "vscode";
import type { WchProjectModel } from "../models/WchProjectModel";
import {
  buildMarch,
  resolveCompilerExecutableName,
  resolveGdbExecutableName,
  resolveMounRiverOpenOcdExecutable,
  resolveMounRiverOpenOcdValue,
  resolveMounRiverStudioExecutable,
  resolveOpenOcdPaths,
  resolveToolchainDirectoryName,
} from "../build/buildShared";
import { normalizeFlashAddress, toOpenOcdPath } from "../build/downloadProjectTask";
import { resolveProjectFileSystemPath, toLogicalProjectPath } from "../build/buildProjectResolver";
import type { ResolvedBuildProject } from "../build/buildProjectResolver";
import { buildOpenOcdServerArgs, resolveConfiguredOpenOcdExecutable } from "../debug/debugConfig";
import { getList, getString, getTuple, parseMiLine } from "../debug/miParser";
import { buildWchProjectModels } from "../projectModelBuilder";
import type { ParsedWchProject } from "../projectState";
suite("wch-vscode Test Suite", () => {
  vscode.window.showInformationMessage("Start wch-vscode tests.");

  test("resolveToolchainDirectoryName maps supported WCH toolchains", () => {
    assert.strictEqual(
      resolveToolchainDirectoryName("${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe"),
      "RISC-V Embedded GCC",
    );
    assert.strictEqual(
      resolveToolchainDirectoryName("${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe"),
      "RISC-V Embedded GCC12",
    );
    assert.strictEqual(
      resolveToolchainDirectoryName("${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe"),
      "RISC-V Embedded GCC15",
    );
  });

  test("build resolver maps linked folder project paths", () => {
    const model = createModel();
    const sourcePath = resolveProjectFileSystemPath(model, "${project}/Core/startup/startup_ch32v00x.S");
    assert.strictEqual(
      sourcePath,
      path.resolve(model.identity.folderPath, "..\\shared\\Core", "startup", "startup_ch32v00x.S"),
    );
    assert.strictEqual(
      toLogicalProjectPath(model, sourcePath),
      "Core/startup/startup_ch32v00x.S",
    );
  });

  test("buildMarch keeps zmmul suffix ordering", () => {
    const model = createModel();
    model.build.riscvExtensions = ["M", "A", "C", "Zmmul"];
    assert.strictEqual(buildMarch(model), "rv32imac_zmmul");
  });

  test("download normalizes mapped flash alias addresses for OpenOCD", () => {
    assert.strictEqual(normalizeFlashAddress("0x08000000"), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("0x00000000"), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("  0x08000000  "), "0x00000000");
    assert.strictEqual(normalizeFlashAddress("0x08004000"), "0x08004000");
    assert.strictEqual(normalizeFlashAddress("main"), "main");
  });

  test("wvproj setBreak=false disables debug stopAt", () => {
    const [model] = buildWchProjectModels(createParsedProject({
      runCommands: {
        setBreak: false,
        setBreakAt: "handle_reset",
      },
    }));

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("wvproj setBreakAt is ignored", () => {
    const [model] = buildWchProjectModels(createParsedProject({
      runCommands: {
        setBreak: true,
        setBreakAt: "custom_boot_entry",
      },
    }));

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("launch setStopAt does not affect debug stopAt", () => {
    const [model] = buildWchProjectModels(createParsedProject({
      launchBooleans: {
        "org.eclipse.cdt.debug.gdbjtag.core.setStopAt": true,
      },
      launchStrings: {
        "org.eclipse.cdt.debug.gdbjtag.core.stopAt": "handle_reset",
      },
    }));

    assert.strictEqual(model.debug.stopAt, "");
  });

  test("compiler executable follows model build prefix", () => {
    assert.strictEqual(
      resolveCompilerExecutableName("${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe"),
      "riscv-none-embed-gcc.exe",
    );
    assert.strictEqual(
      resolveCompilerExecutableName("${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe"),
      "riscv-wch-elf-gcc.exe",
    );
    assert.strictEqual(
      resolveCompilerExecutableName("${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe"),
      "riscv32-wch-elf-gcc.exe",
    );
  });

  test("gdb executable follows model build prefix", () => {
    assert.strictEqual(
      resolveGdbExecutableName("${WCH:Toolchain:GCC8}/bin/riscv-none-embed-gdb.exe"),
      "riscv-none-embed-gdb.exe",
    );
    assert.strictEqual(
      resolveGdbExecutableName("${WCH:Toolchain:GCC12}/bin/riscv-none-embed-gdb.exe"),
      "riscv-wch-elf-gdb.exe",
    );
    assert.strictEqual(
      resolveGdbExecutableName("${WCH:Toolchain:GCC15}/bin/riscv-none-embed-gdb.exe"),
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
      toOpenOcdPath("c:\\Users\\xiaow\\Downloads\\hard\\ch32l103\\EXAM\\FreeRTOS\\obj\\FreeRTOS.hex"),
      "c:/Users/xiaow/Downloads/hard/ch32l103/EXAM/FreeRTOS/obj/FreeRTOS.hex",
    );
  });

  test("debug openocd args prefer project launch options", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);
    project.model.debug.openOcdConfigOptions = ["-f", "interface/wch-link.cfg", "-f", "target/wch-riscv.cfg"];
    project.model.debug.gdbPort = 3334;
    project.model.debug.telnetPort = 4445;
    project.model.debug.tclPort = 6667;

    assert.deepStrictEqual(
      buildOpenOcdServerArgs(project, openOcdPaths),
      [
        "-f",
        "interface/wch-link.cfg",
        "-f",
        "target/wch-riscv.cfg",
        "-c",
        "gdb_port 3334",
        "-c",
        "telnet_port 4445",
        "-c",
        "tcl_port 6667",
      ],
    );
  });

  test("debug openocd args fall back to MRS default config", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);
    project.model.debug.openOcdConfigOptions = [];

    assert.deepStrictEqual(
      buildOpenOcdServerArgs(project, openOcdPaths),
      [
        "-f",
        "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
        "-c",
        "gdb_port 3333",
        "-c",
        "telnet_port 4444",
        "-c",
        "tcl_port 6666",
      ],
    );
  });

  test("MRS openocd values resolve WCH variable from component root", () => {
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdValue(openOcdPaths, "${WCH:OpenOCD:default}\\bin\\wch-riscv.cfg"),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
  });

  test("MRS openocd values resolve quoted WCH variable paths", () => {
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdValue(openOcdPaths, "\"${WCH:OpenOCD:default}/bin/wch-riscv.cfg\""),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
  });

  test("MRS openocd executable resolves WCH default variable from install root", () => {
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdExecutable(openOcdPaths, "${WCH:OpenOCD:default}"),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
  });

  test("MRS openocd executable resolves WCH variable suffix from component root", () => {
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);

    assert.strictEqual(
      resolveMounRiverOpenOcdExecutable(openOcdPaths, "${WCH:OpenOCD:default}\\bin\\openocd.exe"),
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
  });

  test("debug openocd executable uses normalized model path", () => {
    const project = createResolvedBuildProject();
    const openOcdPaths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.ok(openOcdPaths);
    project.model.debug.openOcdExecutable = openOcdPaths.executable;

    assert.strictEqual(
      resolveConfiguredOpenOcdExecutable(project, openOcdPaths),
      openOcdPaths.executable,
    );
  });

  test("MI parser parses stopped async records", () => {
    const record = parseMiLine('*stopped,reason="breakpoint-hit",frame={func="main",fullname="C:\\\\p\\\\main.c",line="42"}');
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
    const breakpoint = parseMiLine('7^done,bkpt={number="1",type="hw breakpoint",disp="keep",enabled="y"}');
    assert.strictEqual(breakpoint.kind, "result");
    if (breakpoint.kind === "result") {
      assert.strictEqual(breakpoint.token, 7);
      assert.strictEqual(getString(getTuple(breakpoint.results.bkpt)?.type), "hw breakpoint");
    }

    const stack = parseMiLine('8^done,stack=[frame={level="0",func="main",fullname="C:\\\\p\\\\main.c",line="9"}]');
    assert.strictEqual(stack.kind, "result");
    if (stack.kind === "result") {
      const frame = getTuple(getTuple(getList(stack.results.stack)[0])?.frame);
      assert.strictEqual(getString(frame?.fullname), "C:\\p\\main.c");
    }

    const multiFrameStack = parseMiLine('81^done,stack=[frame={level="0",func="task2_task"},frame={level="1",func="vPortTaskWrapper"}]');
    assert.strictEqual(multiFrameStack.kind, "result");
    if (multiFrameStack.kind === "result") {
      const frames = getList(multiFrameStack.results.stack);
      assert.strictEqual(frames.length, 2);
      assert.strictEqual(getString(getTuple(getTuple(frames[0])?.frame)?.func), "task2_task");
      assert.strictEqual(getString(getTuple(getTuple(frames[1])?.frame)?.func), "vPortTaskWrapper");
    }

    const variables = parseMiLine('9^done,variables=[{name="counter",value="3"},{name="flag",type="int"}]');
    assert.strictEqual(variables.kind, "result");
    if (variables.kind === "result") {
      assert.strictEqual(getString(getTuple(getList(variables.results.variables)[0])?.value), "3");
    }

    const error = parseMiLine('10^error,msg="No hardware breakpoint available"');
    assert.strictEqual(error.kind, "result");
    if (error.kind === "result") {
      assert.strictEqual(error.resultClass, "error");
      assert.strictEqual(getString(error.results.msg), "No hardware breakpoint available");
    }
  });

  test("MRS2 executable is resolved relative to install root", () => {
    assert.strictEqual(
      resolveMounRiverStudioExecutable("F:\\MounRiver\\MounRiver_Studio2"),
      "F:\\MounRiver\\MounRiver_Studio2\\MounRiver Studio 2.exe",
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
    outputDirectory: path.join(model.identity.folderPath, model.build.configName),
    targetBaseName: model.identity.name,
    elfPath: path.join(model.identity.folderPath, model.build.configName, `${model.identity.name}.elf`),
    hexPath: path.join(model.identity.folderPath, model.build.configName, `${model.identity.name}.hex`),
    lstPath: path.join(model.identity.folderPath, model.build.configName, `${model.identity.name}.lst`),
    sizPath: path.join(model.identity.folderPath, model.build.configName, `${model.identity.name}.siz`),
    mapFilePath: path.join(model.identity.folderPath, model.build.configName, `${model.identity.name}.map`),
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
}): ParsedWchProject {
  const stringAttribute = Object.entries(options.launchStrings ?? {}).map(([key, value]) => ({
    "@_key": key,
    "@_value": value,
  }));
  const booleanAttribute = Object.entries(options.launchBooleans ?? {}).map(([key, value]) => ({
    "@_key": key,
    "@_value": String(value),
  }));

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
                },
              ],
            },
            debugConfigurations: {
              startup: {
                runCommands: options.runCommands ?? {},
              },
            },
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
    args: ["-march=rv32imac", "-mabi=ilp32", "-O0", "-ffunction-sections", "-fdata-sections", "-std=gnu11"],
  };
  const cpp = {
    ...c,
    standard: "gnu++17",
    args: ["-march=rv32imac", "-mabi=ilp32", "-O0", "-ffunction-sections", "-fdata-sections", "-std=gnu++17"],
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
        mapFile: "\"${BuildArtifactFileBaseName}.map\"",
        args: ["-march=rv32imac", "-mabi=ilp32", "-nostartfiles", "-Wl,--gc-sections", "--specs=nano.specs", "--specs=nosys.specs"],
      },
      postBuild: {
        createFlash: true,
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
      targetPath: "",
      address: "",
      erase: false,
      program: false,
      verify: false,
      reset: false,
    },
  };
}
