import * as assert from "assert";
import * as path from "node:path";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from "vscode";
import type { WchProjectModel } from "../models/WchProjectModel";
import {
  buildMarch,
  resolveCompilerExecutableName,
  resolveMounRiverStudioExecutable,
  resolveOpenOcdPaths,
  resolveToolchainDirectoryName,
} from "../build/buildShared";
import { toOpenOcdPath } from "../build/downloadProjectTask";
import { resolveProjectFileSystemPath, toLogicalProjectPath } from "../build/buildProjectResolver";
// import * as myExtension from '../../extension';

suite("wch-vscode Test Suite", () => {
  vscode.window.showInformationMessage("Start wch-vscode tests.");

  test("Sample check", () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

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
      path.resolve(model.folderPath, "..\\shared\\Core", "startup", "startup_ch32v00x.S"),
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

  test("openocd paths are resolved relative to MounRiver Studio root", () => {
    const paths = resolveOpenOcdPaths("F:\\MounRiver\\MounRiver_Studio2");
    assert.strictEqual(
      paths?.config,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\wch-riscv.cfg",
    );
    assert.strictEqual(
      paths?.executable,
      "F:\\MounRiver\\MounRiver_Studio2\\resources\\app\\resources\\win32\\components\\WCH\\OpenOCD\\OpenOCD\\bin\\openocd.exe",
    );
  });

  test("openocd command paths use forward slashes for Tcl parsing", () => {
    assert.strictEqual(
      toOpenOcdPath("c:\\Users\\xiaow\\Downloads\\hard\\ch32l103\\EXAM\\FreeRTOS\\obj\\FreeRTOS.hex"),
      "c:/Users/xiaow/Downloads/hard/ch32l103/EXAM/FreeRTOS/obj/FreeRTOS.hex",
    );
  });

  test("MRS2 executable is resolved relative to install root", () => {
    assert.strictEqual(
      resolveMounRiverStudioExecutable("F:\\MounRiver\\MounRiver_Studio2"),
      "F:\\MounRiver\\MounRiver_Studio2\\MounRiver Studio 2.exe",
    );
  });
});

function createModel(): WchProjectModel {
  return {
    baseName: "DemoProject",
    folderPath: "C:\\workspace\\DemoProject",
    folderName: "DemoProject",
    linkedFolders: [
      {
        name: "Core",
        location: "..\\shared\\Core",
      },
    ],
    files: {
      cproject: [],
      launch: "",
      wvproj: "",
    },
    project: {
      name: "DemoProject",
      projectType: "c",
      architecture: "RISC-V",
      artifact: {
        name: "${ProjName}",
        extension: "elf",
        outputPrefix: "",
        outputFile: "",
      },
    },
    chip: {
      vendor: "WCH",
      series: "CH32V",
      mcu: "CH32V203",
      rtos: "NoneOS",
      toolchain: "RISC-V",
      debugLink: "WCH-Link",
      svdPath: "",
    },
    resolvedToolchain: {
      directoryName: "RISC-V Embedded GCC12",
      executablePrefix: "riscv-wch-elf-",
      executables: {
        gcc: "riscv-wch-elf-gcc.exe",
        gpp: "riscv-wch-elf-g++.exe",
        objcopy: "riscv-wch-elf-objcopy.exe",
        objdump: "riscv-wch-elf-objdump.exe",
        size: "riscv-wch-elf-size.exe",
      },
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
      targetArchitecture: "rv32i",
      targetAbi: "ilp32",
      riscvExtensions: ["M", "A", "C"],
      architectureArgs: ["-march=rv32imac", "-mabi=ilp32"],
      optimizationLevel: "none",
      functionSections: true,
      dataSections: true,
      commonOptimizationFlags: [],
      commonWarningFlags: [],
      commonDebuggingFlags: [],
      cStandard: "gnu11",
      cppStandard: "gnu++17",
      includePaths: [],
      includeSystemPaths: [],
      includeFiles: [],
      definedSymbols: [],
      otherCompilerFlags: [],
      linkerScript: "${project}/Ld/Link.ld",
      libraries: [],
      librarySearchPaths: [],
      sourceExcludes: [],
    },
    assembler: {
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
    },
    c: {
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
    },
    cpp: {
      standard: "gnu++17",
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
      args: ["-march=rv32imac", "-mabi=ilp32", "-O0", "-ffunction-sections", "-fdata-sections", "-std=gnu++17"],
    },
    linker: {
      linkerScript: "${project}/Ld/Link.ld",
      libraries: [],
      librarySearchPaths: [],
      linkerFlags: [],
      otherLinkerFlags: [],
      otherObjects: [],
      generateMap: "\"${BuildArtifactFileBaseName}.map\"",
      doNotUseStandardStartFiles: true,
      doNotUseDefaultLibraries: false,
      noStartupOrDefaultLibs: false,
      removeUnusedSections: true,
      printRemovedSections: false,
      omitAllSymbolInformation: false,
      useNewlibNano: true,
      useFloatWithNanoPrintf: false,
      useFloatWithNanoScanf: false,
      doNotUseSyscalls: true,
      crossReference: false,
      printLinkMap: false,
      verbose: false,
      picolibc: "",
      useWchPrintffloat: false,
      useWchPrintf: false,
      useIqmath: false,
      args: ["-march=rv32imac", "-mabi=ilp32", "-nostartfiles", "-Wl,--gc-sections", "--specs=nano.specs", "--specs=nosys.specs"],
    },
    postBuild: {
      createFlash: true,
      flashOutputFormat: "ihex",
      copyOnlySectionText: false,
      copyOnlySectionData: false,
      copyOnlySections: [],
      flashFlags: [],
      flashArgs: ["-O", "ihex"],
      createList: true,
      listFlags: [],
      listArgs: ["-x", "-S", "-C", "-l", "-w"],
      listOptions: {
        displaySource: true,
        displayAllHeaders: true,
        demangleNames: true,
        displayDebugInfo: false,
        disassemble: false,
        displayFileHeaders: false,
        displayLineNumbers: true,
        displayRelocationInfo: false,
        displaySymbols: false,
        wideLines: true,
      },
      printSize: true,
      sizeFormat: "berkeley",
      sizeFlags: [],
      sizeArgs: ["--format=berkeley"],
      sizeOptions: {
        hex: false,
        showTotals: false,
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
