import type {
  WchLinkedFolder,
  WchProjectModel,
  WchToolchainModel,
} from "./models/WchProjectModel";
import {
  getConfiguredMounRiverStudioPath,
  normalizeMounRiverArgument,
  resolveMounRiverOpenOcdExecutable,
  resolveMounRiverOpenOcdValue,
  resolveOpenOcdPaths,
} from "./build/buildShared";
import type {
  ParsedProjectPair,
  ParsedProjectFile,
  ParsedWchProject,
} from "./projectState";
import { t } from "./i18n";

type LaunchAttributeMaps = {
  strings: Map<string, string>;
  ints: Map<string, number>;
  booleans: Map<string, boolean>;
};

// 从已解析的项目文件中提炼出精简后的业务模型。
export function buildWchProjectModels(
  project: ParsedWchProject,
): WchProjectModel[] {
  return project.projectPairs
    .map((pair) => buildWchProjectModel(project, pair))
    .filter((model): model is WchProjectModel => model !== null);
}

// 当前仅支持 RISC-V 工程，其他工具链直接标记为不支持。
export function getUnsupportedProjectReason(
  project: ParsedWchProject,
): string | undefined {
  for (const pair of project.projectPairs) {
    const wvproj = asRecord(pair.wvproj.data);
    const basic = asRecord(wvproj?.basic);
    const chipInfo = asRecord(basic?.chipInfo);
    const toolchain = getString(chipInfo?.toolchain)?.trim();

    if (toolchain && toolchain.toUpperCase() !== "RISC-V") {
      return t("project.unsupportedToolchain", { toolchain });
    }
  }

  return undefined;
}

// 组合 .wvproj、.launch、.cproject 中有效字段，生成单个项目模型。
function buildWchProjectModel(
  project: ParsedWchProject,
  pair: ParsedProjectPair,
): WchProjectModel | null {
  const wvproj = asRecord(pair.wvproj.data);
  if (!wvproj) {
    return null;
  }

  const launchAttributes = createLaunchAttributeMaps(pair.launch.data);
  const cprojectInfo = extractCprojectInfo(project.cprojectFiles);
  const basic = asRecord(wvproj.basic);
  const chipInfo = asRecord(basic?.chipInfo);
  const toolchain = getString(chipInfo?.toolchain)?.trim();
  if (toolchain && toolchain.toUpperCase() !== "RISC-V") {
    return null;
  }

  const buildConfiguration = getFirstConfiguration(wvproj);
  const buildArtifact = asRecord(buildConfiguration?.buildArtifact);
  const ccompiler = asRecord(buildConfiguration?.ccompiler);
  const cIncludes = asRecord(ccompiler?.includes);
  const cPreprocessor = asRecord(ccompiler?.preprocessor);
  const cCompilerOptimization = asRecord(ccompiler?.optimization);
  const cCompilerWarnings = asRecord(ccompiler?.warnings);
  const cCompilerMisc = asRecord(ccompiler?.miscellaneous);
  const assembler = asRecord(buildConfiguration?.assembler);
  const assemblerPreprocessor = asRecord(assembler?.preprocessor);
  const assemblerIncludes = asRecord(assembler?.includes);
  const assemblerMisc = asRecord(assembler?.miscellaneous);
  const cppcompiler = asRecord(buildConfiguration?.cppcompiler);
  const cppIncludes = asRecord(cppcompiler?.includes);
  const cppPreprocessor = asRecord(cppcompiler?.preprocessor);
  const cppCompilerOptimization = asRecord(cppcompiler?.optimization);
  const cppCompilerWarnings = asRecord(cppcompiler?.warnings);
  const cppCompilerMisc = asRecord(cppcompiler?.miscellaneous);
  const linker =
    asRecord(buildConfiguration?.clinker) ??
    asRecord(buildConfiguration?.cpplinker);
  const linkerGeneral = asRecord(linker?.general);
  const linkerLibraries = asRecord(linker?.libraries);
  const linkerMisc = asRecord(linker?.miscellaneous);
  const createFlash = asRecord(buildConfiguration?.createFlash);
  const createList = asRecord(buildConfiguration?.createList);
  const printSize = asRecord(buildConfiguration?.printSize);
  const optimization = asRecord(buildConfiguration?.optimization);
  const warnings = asRecord(buildConfiguration?.warnings);
  const debugging = asRecord(buildConfiguration?.debugging);
  const riscvTarget = asRecord(buildConfiguration?.riscvTargetProcessor);
  const debugConfigurations = asRecord(wvproj.debugConfigurations);
  const openOcdCfg = asRecord(debugConfigurations?.openOCDCfg);
  const gdbCfg = asRecord(debugConfigurations?.gdbCfg);
  const startup = asRecord(debugConfigurations?.startup);
  const runCommands = asRecord(startup?.runCommands);
  const initCommands = asRecord(startup?.initCommands);
  const flashConfig = asRecord(wvproj.flashConfig);
  const programName =
    getString(
      launchAttributes.strings.get("org.eclipse.cdt.launch.PROGRAM_NAME"),
    ) ??
    getString(asRecord(debugConfigurations?.reserve)?.PROGRAM_NAME) ??
    "";
  const gdbExecutable =
    getString(asRecord(gdbCfg)?.executable) ??
    getString(
      launchAttributes.strings.get("org.eclipse.cdt.dsf.gdb.DEBUG_NAME"),
    ) ??
    "";
  const toolchainMetadata = resolveToolchainMetadata(gdbExecutable);
  const rawOpenOcdExecutable =
    getString(openOcdCfg?.executable) ??
    getString(
      launchAttributes.strings.get(
        "com.mounriver.debug.gdbjtag.openocd.gdbServerExecutable",
      ),
    ) ??
    "";
  const rawOpenOcdConfigOptions =
    getStringArray(openOcdCfg?.configOptions).length > 0
      ? getStringArray(openOcdCfg?.configOptions)
      : getLaunchArguments(
          launchAttributes.strings.get(
            "com.mounriver.debug.gdbjtag.openocd.gdbServerOther",
          ),
        );
  const resolvedOpenOcdConfig = resolveOpenOcdDebugConfig(
    rawOpenOcdExecutable,
    rawOpenOcdConfigOptions,
  );
  const targetArchitecture =
    cprojectInfo.targetArchitecture ||
    getString(riscvTarget?.architecture) ||
    "";
  const targetAbi =
    cprojectInfo.targetAbi || getString(riscvTarget?.integer_ABI) || "";
  const riscvExtensions = collectRiscvExtensions(riscvTarget);
  const optimizationLevel = getString(optimization?.level) ?? "";
  const functionSections = getBoolean(optimization?.function_sections) ?? false;
  const dataSections = getBoolean(optimization?.data_sections) ?? false;
  const architectureArgs = buildArchitectureArgs(
    targetArchitecture,
    targetAbi,
    riscvExtensions,
  );
  const commonOptimizationFlags = buildCommonOptimizationArgs(optimization);
  const commonWarningFlags = buildCommonWarningArgs(warnings);
  const commonDebuggingFlags = buildCompilerDebuggingArgs(debugging);
  const buildOtherCompilerFlags = splitSpaceFlags(
    getString(cCompilerMisc?.other_compiler_flags),
  );
  const linkerFlags = getStringArray(linkerMisc?.linker_flags);
  const otherLinkerFlags = splitSpaceFlags(
    getString(linkerMisc?.other_linker_flags),
  );
  const linkerConfig = {
    doNotUseStandardStartFiles:
      getBoolean(linkerGeneral?.do_not_use_standard_start_files) ?? false,
    doNotUseDefaultLibraries:
      getBoolean(linkerGeneral?.do_not_use_default_libraries) ?? false,
    noStartupOrDefaultLibs:
      getBoolean(linkerGeneral?.no_startup_or_default_libs) ?? false,
    removeUnusedSections:
      getBoolean(linkerGeneral?.remove_unused_sections) ?? false,
    printRemovedSections:
      getBoolean(linkerGeneral?.print_removed_sections) ?? false,
    omitAllSymbolInformation:
      getBoolean(linkerGeneral?.omit_all_symbol_information) ?? false,
    useNewlibNano: getBoolean(linkerMisc?.use_newlib_nano) ?? false,
    useFloatWithNanoPrintf:
      getBoolean(linkerMisc?.use_float_with_nano_printf) ?? false,
    useFloatWithNanoScanf:
      getBoolean(linkerMisc?.use_float_with_nano_scanf) ?? false,
    doNotUseSyscalls: getBoolean(linkerMisc?.do_not_use_syscalls) ?? false,
  };
  const cStandard = normalizeCStandard(
    getString(cCompilerOptimization?.language_standard),
  );
  const cppStandard = normalizeCppStandard(
    getString(cppCompilerOptimization?.cpp_language_standard),
  );
  const cOptimizationFlags = splitSpaceFlags(
    getString(cCompilerOptimization?.other_optimization_flags),
  );
  const cPreprocessorDoNotSearchSystemDirectories =
    getBoolean(cPreprocessor?.do_not_search_system_directories) ?? false;
  const cPreprocessOnly = getBoolean(cPreprocessor?.preprocess_only) ?? false;
  const cUndefinedSymbols = getStringArray(cPreprocessor?.undefined_symbols);
  const cWarningFlags = splitSpaceFlags(
    getString(cCompilerWarnings?.other_warning_flags),
  );
  const cSpecificWarningFlags = buildCSpecificWarningArgs(cCompilerWarnings);
  const cDebuggingFlags = buildCompilerDebuggingArgs(debugging);
  const cOtherCompilerFlags = splitSpaceFlags(
    getString(cCompilerMisc?.other_compiler_flags),
  );
  const cGenerateAssemblerListing =
    getBoolean(cCompilerMisc?.generate_assembler_listing) ?? false;
  const cSaveTemporaryFiles =
    getBoolean(cCompilerMisc?.save_temporary_files) ?? false;
  const cVerbose = getBoolean(cCompilerMisc?.verbose) ?? false;
  const cppOptimizationFlags = splitSpaceFlags(
    getString(cppCompilerOptimization?.other_optimization_flags),
  );
  const cppPreprocessorDoNotSearchSystemDirectories =
    getBoolean(cppPreprocessor?.do_not_search_system_directories) ?? false;
  const cppDoNotSearchSystemCppDirectories =
    getBoolean(cppPreprocessor?.do_not_search_system_cpp_directories) ?? false;
  const cppPreprocessOnly =
    getBoolean(cppPreprocessor?.preprocess_only) ?? false;
  const cppUndefinedSymbols = getStringArray(
    cppPreprocessor?.undefined_symbols,
  );
  const cppWarningFlags = splitSpaceFlags(
    getString(cppCompilerWarnings?.other_warning_flags),
  );
  const cppSpecificOptimizationFlags = buildCppSpecificOptimizationArgs(
    cppCompilerOptimization,
  );
  const cppSpecificWarningFlags =
    buildCppSpecificWarningArgs(cppCompilerWarnings);
  const cppDebuggingFlags = buildCompilerDebuggingArgs(debugging);
  const cppOtherCompilerFlags = splitSpaceFlags(
    getString(cppCompilerMisc?.other_compiler_flags),
  );
  const cppGenerateAssemblerListing =
    getBoolean(cppCompilerMisc?.generate_assembler_listing) ?? false;
  const cppSaveTemporaryFiles =
    getBoolean(cppCompilerMisc?.save_temporary_files) ?? false;
  const cppVerbose = getBoolean(cppCompilerMisc?.verbose) ?? false;
  const assemblerUsePreprocessor =
    getBoolean(assemblerPreprocessor?.use_preprocessor) ?? false;
  const assemblerDoNotSearchSystemDirectories =
    getBoolean(assemblerPreprocessor?.do_not_search_system_directories) ??
    false;
  const assemblerPreprocessOnly =
    getBoolean(assemblerPreprocessor?.preprocess_only) ?? false;
  const assemblerUndefinedSymbols = getStringArray(
    assemblerPreprocessor?.undefined_symbols,
  );
  const assemblerFlags = getStringArray(assemblerMisc?.assembler_flags);
  const assemblerGenerateAssemblerListing =
    getBoolean(assemblerMisc?.generate_assembler_listing) ?? false;
  const assemblerSaveTemporaryFiles =
    getBoolean(assemblerMisc?.save_temporary_files) ?? false;
  const assemblerVerbose = getBoolean(assemblerMisc?.verbose) ?? false;
  const assemblerWarningFlags = splitSpaceFlags(
    getString(assembler?.other_warning_flags),
  );
  const assemblerOtherFlags = splitSpaceFlags(
    getString(assemblerMisc?.other_assembler_flags),
  );
  const createFlashEnabled = getBoolean(createFlash?.enabled) ?? false;
  const flashOutputFormat = getString(createFlash?.outputFileFormat) ?? "";
  const flashCreateBinary = flashOutputFormat.toLowerCase() === "ihexandbinary";
  const flashCopyOnlySectionText =
    getBoolean(createFlash?.copy_only_section_text) ?? false;
  const flashCopyOnlySectionData =
    getBoolean(createFlash?.copy_only_section_data) ?? false;
  const flashCopyOnlySections = getStringArray(createFlash?.copy_only_sections);
  const flashFlags = splitSpaceFlags(getString(createFlash?.other_flags));
  const createListEnabled = getBoolean(createList?.enabled) ?? false;
  const listFlags = splitSpaceFlags(getString(createList?.other_flags));
  const printSizeEnabled = getBoolean(printSize?.enabled) ?? false;
  const sizeFormat = getString(printSize?.size_format) ?? "";
  const sizeFlags = splitSpaceFlags(getString(printSize?.other_flags));

  return {
    identity: {
      name: getString(basic?.projectName) ?? pair.baseName,
      baseName: pair.baseName,
      folderPath: project.folderPath,
      folderName: project.folderName,
      files: {
        cproject: project.cprojectFiles.map((file) => file.filePath),
        launch: pair.launch.filePath,
        wvproj: pair.wvproj.filePath,
      },
    },
    target: {
      architecture: getString(basic?.architecture) ?? "",
      toolchain: toolchain ?? "",
      mcu: getString(chipInfo?.mcu) ?? "",
      rtos: getString(chipInfo?.rtos) ?? "",
      debugLink: getString(chipInfo?.link) ?? "",
      svdPath:
        getString(debugConfigurations?.svdpath) ??
        getString(
          launchAttributes.strings.get("com.mounriver.debug.gdbjtag.svdPath"),
        ) ??
        "",
      // linkedFolders 表示 MRS 工程里额外挂进来的目录，后续会用于补充 VS Code 的索引路径。
      linkedFolders: extractLinkedFolders(basic?.linkedFolders),
    },
    build: {
      configName: getString(buildConfiguration?.name) ?? "",
      parallelizationNumber:
        getString(buildConfiguration?.parallelizationNumber) ?? "",
      stopOnFirstBuildError:
        getBoolean(buildConfiguration?.stop_on_first_build_error) ?? true,
      preScript: getString(buildConfiguration?.pre_script) ?? "",
      postScript: getString(buildConfiguration?.post_script) ?? "",
      toolchainName: cprojectInfo.toolchainName,
      commandPrefix: cprojectInfo.commandPrefix,
      compilerPath: buildCompilerPath(cprojectInfo.commandPrefix),
      toolchain: toolchainMetadata,
      artifact: {
        name: getString(buildArtifact?.artifact_name) ?? "",
        extension: getString(buildArtifact?.artifact_extension) ?? "",
        outputPrefix: getString(buildArtifact?.output_prefix) ?? "",
        outputFile:
          getString(
            launchAttributes.strings.get("org.eclipse.cdt.launch.PROGRAM_NAME"),
          ) ??
          getString(
            debugConfigurations?.reserve &&
              asRecord(debugConfigurations.reserve)?.PROGRAM_NAME,
          ) ??
          "",
      },
      targetArchitecture,
      targetAbi,
      riscvExtensions,
      architectureArgs,
      cStandard,
      cppStandard,
      includePaths: getStringArray(cIncludes?.include_paths),
      includeSystemPaths: getStringArray(cIncludes?.include_system_paths),
      includeFiles: getStringArray(cIncludes?.include_files),
      definedSymbols: getStringArray(cPreprocessor?.defined_symbols),
      otherCompilerFlags: buildOtherCompilerFlags,
      sourceExcludes:
        cprojectInfo.sourceExcludes.length > 0
          ? cprojectInfo.sourceExcludes
          : getStringArray(buildConfiguration?.excludeResources),
      compile: {
        assembler: {
          usePreprocessor: assemblerUsePreprocessor,
          doNotSearchSystemDirectories: assemblerDoNotSearchSystemDirectories,
          preprocessOnly: assemblerPreprocessOnly,
          includePaths: getStringArray(assemblerIncludes?.include_paths),
          includeSystemPaths: getStringArray(assemblerIncludes?.include_system_paths),
          includeFiles: getStringArray(assemblerIncludes?.include_files),
          definedSymbols: getStringArray(assemblerPreprocessor?.defined_symbols),
          undefinedSymbols: assemblerUndefinedSymbols,
          assemblerFlags,
          generateAssemblerListing: assemblerGenerateAssemblerListing,
          saveTemporaryFiles: assemblerSaveTemporaryFiles,
          verbose: assemblerVerbose,
          otherAssemblerFlags: assemblerOtherFlags,
          warningFlags: assemblerWarningFlags,
          args: uniqueStrings([
            ...architectureArgs,
            ...buildAssemblerPreprocessorArgs(
              assemblerUsePreprocessor,
              assemblerDoNotSearchSystemDirectories,
              assemblerPreprocessOnly,
              assemblerUndefinedSymbols,
            ),
            ...buildAssemblerMiscArgs(
              assemblerFlags,
              assemblerGenerateAssemblerListing,
              assemblerSaveTemporaryFiles,
              assemblerVerbose,
            ),
            ...assemblerWarningFlags,
            ...assemblerOtherFlags,
          ]),
        },
        c: {
          standard: cStandard,
          includePaths: getStringArray(cIncludes?.include_paths),
          includeSystemPaths: getStringArray(cIncludes?.include_system_paths),
          includeFiles: getStringArray(cIncludes?.include_files),
          definedSymbols: getStringArray(cPreprocessor?.defined_symbols),
          undefinedSymbols: cUndefinedSymbols,
          doNotSearchSystemDirectories: cPreprocessorDoNotSearchSystemDirectories,
          doNotSearchSystemCppDirectories: false,
          preprocessOnly: cPreprocessOnly,
          generateAssemblerListing: cGenerateAssemblerListing,
          saveTemporaryFiles: cSaveTemporaryFiles,
          verbose: cVerbose,
          optimizationFlags: cOptimizationFlags,
          warningFlags: uniqueStrings([...commonWarningFlags, ...cSpecificWarningFlags, ...cWarningFlags]),
          debuggingFlags: cDebuggingFlags,
          otherCompilerFlags: cOtherCompilerFlags,
          args: uniqueStrings([
            ...architectureArgs,
            ...buildCommonCompilerArgs(optimizationLevel, functionSections, dataSections),
            ...commonOptimizationFlags,
            ...(cStandard ? [`-std=${cStandard}`] : []),
            ...cOptimizationFlags,
            ...buildCompilerPreprocessorArgs(
              cPreprocessorDoNotSearchSystemDirectories,
              false,
              cPreprocessOnly,
              cUndefinedSymbols,
            ),
            ...uniqueStrings([...commonWarningFlags, ...cSpecificWarningFlags, ...cWarningFlags]),
            ...cDebuggingFlags,
            ...buildCompilerMiscArgs(cGenerateAssemblerListing, cSaveTemporaryFiles, cVerbose),
            ...buildOtherCompilerFlags,
            ...cOtherCompilerFlags,
          ]),
        },
        cpp: {
          standard: cppStandard,
          includePaths: getStringArray(cppIncludes?.include_paths),
          includeSystemPaths: getStringArray(cppIncludes?.include_system_paths),
          includeFiles: getStringArray(cppIncludes?.include_files),
          definedSymbols: getStringArray(cppPreprocessor?.defined_symbols),
          undefinedSymbols: cppUndefinedSymbols,
          doNotSearchSystemDirectories: cppPreprocessorDoNotSearchSystemDirectories,
          doNotSearchSystemCppDirectories: cppDoNotSearchSystemCppDirectories,
          preprocessOnly: cppPreprocessOnly,
          generateAssemblerListing: cppGenerateAssemblerListing,
          saveTemporaryFiles: cppSaveTemporaryFiles,
          verbose: cppVerbose,
          optimizationFlags: uniqueStrings([...cppSpecificOptimizationFlags, ...cppOptimizationFlags]),
          warningFlags: uniqueStrings([...commonWarningFlags, ...cppSpecificWarningFlags, ...cppWarningFlags]),
          debuggingFlags: cppDebuggingFlags,
          otherCompilerFlags: cppOtherCompilerFlags,
          args: uniqueStrings([
            ...architectureArgs,
            ...buildCommonCompilerArgs(optimizationLevel, functionSections, dataSections),
            ...commonOptimizationFlags,
            ...(cppStandard ? [`-std=${cppStandard}`] : []),
            ...cppSpecificOptimizationFlags,
            ...cppOptimizationFlags,
            ...buildCompilerPreprocessorArgs(
              cppPreprocessorDoNotSearchSystemDirectories,
              cppDoNotSearchSystemCppDirectories,
              cppPreprocessOnly,
              cppUndefinedSymbols,
            ),
            ...uniqueStrings([...commonWarningFlags, ...cppSpecificWarningFlags, ...cppWarningFlags]),
            ...cppDebuggingFlags,
            ...buildCompilerMiscArgs(cppGenerateAssemblerListing, cppSaveTemporaryFiles, cppVerbose),
            ...buildOtherCompilerFlags,
            ...cppOtherCompilerFlags,
          ]),
        },
      },
      linker: {
        script: getFirstString(linkerGeneral?.scriptFiles),
        libraries: getStringArray(linkerLibraries?.libraries),
        librarySearchPaths: getStringArray(linkerLibraries?.library_search_path),
        linkerFlags,
        otherLinkerFlags,
        otherObjects: getStringArray(linkerMisc?.other_objects),
        mapFile: getString(linkerMisc?.generate_map) ?? "",
        args: uniqueStrings([
          ...architectureArgs,
          ...buildLinkBehaviorArgs(linkerConfig),
          ...buildLinkMiscArgs(
            getBoolean(optimization?.link_time_optimizer) ?? false,
            getBoolean(debugging?.generate_prof_information) ?? false,
            getBoolean(debugging?.generate_gprof_information) ?? false,
            splitSpaceFlags(getString(debugging?.other_debugging_flags)),
            getBoolean(linkerMisc?.cross_reference) ?? false,
            getBoolean(linkerMisc?.print_link_map) ?? false,
            getBoolean(linkerMisc?.verbose) ?? false,
            getString(linkerMisc?.picolibc) ?? "",
          ),
          ...linkerFlags,
          ...otherLinkerFlags,
        ]),
      },
      postBuild: {
        createFlash: createFlashEnabled,
        createBinary: flashCreateBinary,
        flashArgs: buildFlashArgs(
          flashOutputFormat,
          flashCopyOnlySectionText,
          flashCopyOnlySectionData,
          flashCopyOnlySections,
          flashFlags,
        ),
        createList: createListEnabled,
        listArgs: buildListArgs(
          getBoolean(createList?.display_all_headers) ?? false,
          getBoolean(createList?.disassemble) ?? false,
          getBoolean(createList?.display_source) ?? false,
          getBoolean(createList?.demangle_names) ?? false,
          getBoolean(createList?.display_debug_info) ?? false,
          getBoolean(createList?.display_file_headers) ?? false,
          getBoolean(createList?.display_line_numbers) ?? false,
          getBoolean(createList?.display_relocation_info) ?? false,
          getBoolean(createList?.display_symbols) ?? false,
          getBoolean(createList?.wide_lines) ?? false,
          listFlags,
        ),
        printSize: printSizeEnabled,
        sizeArgs: buildSizeArgs(
          sizeFormat,
          getBoolean(printSize?.hex) ?? false,
          getBoolean(printSize?.show_totals) ?? false,
          sizeFlags,
        ),
      },
    },
    debug: {
      programName,
      gdbExecutable,
      openOcdExecutable: resolvedOpenOcdConfig.executable,
      openOcdConfigOptions: resolvedOpenOcdConfig.configOptions,
      host:
        getString(openOcdCfg?.host) ??
        getString(
          launchAttributes.strings.get(
            "org.eclipse.cdt.debug.gdbjtag.core.ipAddress",
          ),
        ) ??
        "localhost",
      gdbPort:
        getNumber(openOcdCfg?.gdbport) ??
        getNumber(
          launchAttributes.ints.get(
            "com.mounriver.debug.gdbjtag.openocd.gdbServerGdbPortNumber",
          ),
        ) ??
        0,
      telnetPort:
        getNumber(openOcdCfg?.telnetport) ??
        getNumber(
          launchAttributes.ints.get(
            "com.mounriver.debug.gdbjtag.openocd.gdbServerTelnetPortNumber",
          ),
        ) ??
        0,
      tclPort:
        getNumber(openOcdCfg?.tclport) ??
        getNumber(
          launchAttributes.strings.get(
            "com.mounriver.debug.gdbjtag.openocd.gdbServerTclPortNumber",
          ),
        ) ??
        0,
      startupCommands:
        getStringArray(gdbCfg?.commands).length > 0
          ? getStringArray(gdbCfg?.commands)
          : getLaunchCommands(
              launchAttributes.strings.get(
                "com.mounriver.debug.gdbjtag.openocd.gdbClientOtherCommands",
              ),
            ),
      stopAt:
        resolveStopAt(runCommands, launchAttributes),
      firstResetType:
        getString(initCommands?.initResetType) ??
        getString(
          launchAttributes.strings.get(
            "com.mounriver.debug.gdbjtag.openocd.firstResetType",
          ),
        ) ??
        "",
      secondResetType:
        getString(runCommands?.runResetType) ??
        getString(
          launchAttributes.strings.get(
            "com.mounriver.debug.gdbjtag.openocd.secondResetType",
          ),
        ) ??
        "",
    },
    flash: {
      targetPath: getString(flashConfig?.target_path) ?? "",
      address: getString(flashConfig?.address) ?? "",
      erase: getBoolean(flashConfig?.erase) ?? false,
      program: getBoolean(flashConfig?.program) ?? false,
      verify: getBoolean(flashConfig?.verify) ?? false,
      reset: getBoolean(flashConfig?.reset) ?? false,
    },
  };
}

// 提取 .launch 中的键值属性，便于按 key 读取。
function createLaunchAttributeMaps(data: unknown): LaunchAttributeMaps {
  const strings = new Map<string, string>();
  const ints = new Map<string, number>();
  const booleans = new Map<string, boolean>();
  const root = asRecord(data);
  const launchConfiguration = asRecord(root?.launchConfiguration);

  for (const item of asArray(launchConfiguration?.stringAttribute)) {
    const attribute = asRecord(item);
    const key = getString(attribute?.["@_key"]);
    const value = getString(attribute?.["@_value"]);

    if (key && value !== null) {
      strings.set(key, value);
    }
  }

  for (const item of asArray(launchConfiguration?.intAttribute)) {
    const attribute = asRecord(item);
    const key = getString(attribute?.["@_key"]);
    const value = getNumber(attribute?.["@_value"]);

    if (key && value !== null) {
      ints.set(key, value);
    }
  }

  for (const item of asArray(launchConfiguration?.booleanAttribute)) {
    const attribute = asRecord(item);
    const key = getString(attribute?.["@_key"]);
    const value = getBoolean(attribute?.["@_value"]);

    if (key && value !== null) {
      booleans.set(key, value);
    }
  }

  return { strings, ints, booleans };
}

function resolveStopAt(
  runCommands: Record<string, unknown> | null,
  _launchAttributes: LaunchAttributeMaps,
): string {
  const _runCommandSetBreak = getBoolean(runCommands?.setBreak);
  const _setBreakAt = getString(runCommands?.setBreakAt) ?? "";
  return "";
}

// 从 .cproject 中抽取少量 .wvproj 没有或不够直观的构建信息。
function extractCprojectInfo(cprojectFiles: ParsedProjectFile[]): {
  toolchainName: string;
  commandPrefix: string;
  targetArchitecture: string;
  targetAbi: string;
  sourceExcludes: string[];
} {
  for (const file of cprojectFiles) {
    const root = asRecord(file.data);
    const cproject = asRecord(root?.cproject);
    const storageModules = asArray(cproject?.storageModule)
      .map(asRecord)
      .filter(isRecord);
    const settingsModule = storageModules.find(
      (item) => item?.["@_moduleId"] === "org.eclipse.cdt.core.settings",
    );
    const cconfiguration = asRecord(settingsModule?.cconfiguration);
    const cconfigurationModules = asArray(cconfiguration?.storageModule)
      .map(asRecord)
      .filter(isRecord);
    const buildModule = cconfigurationModules.find(
      (item) => item?.["@_moduleId"] === "cdtBuildSystem",
    );
    const configuration = asRecord(buildModule?.configuration);
    const folderInfo = asRecord(configuration?.folderInfo);
    const toolChain = asRecord(folderInfo?.toolChain);
    const options = asArray(toolChain?.option).map(asRecord).filter(isRecord);

    const toolchainName = getOptionValue(options, "option.toolchain.name");
    const commandPrefix = getOptionValue(options, "option.command.prefix");
    const targetArchitecture = trimOptionEnumValue(
      getOptionValue(options, "option.target.isa.base"),
    );
    const targetAbi = trimOptionEnumValue(
      getOptionValue(options, "option.target.abi.integer"),
    );
    const sourceEntry = asRecord(asRecord(configuration?.sourceEntries)?.entry);
    const sourceExcludes = splitPipeList(
      getString(sourceEntry?.["@_excluding"]),
    );

    return {
      toolchainName: toolchainName ?? "",
      commandPrefix: commandPrefix ?? "",
      targetArchitecture: targetArchitecture ?? "",
      targetAbi: targetAbi ?? "",
      sourceExcludes,
    };
  }

  return {
    toolchainName: "",
    commandPrefix: "",
    targetArchitecture: "",
    targetAbi: "",
    sourceExcludes: [],
  };
}

// 取第一个构建配置，当前样例只有一个 obj 配置。
function getFirstConfiguration(
  wvproj: Record<string, unknown>,
): Record<string, unknown> | null {
  const buildConfig = asRecord(wvproj.buildConfig);
  const configurations = asArray(buildConfig?.configurations);
  return asRecord(configurations[0]);
}

// 汇总 RISC-V 扩展开关，方便后续直接展示或生成参数。
function collectRiscvExtensions(
  target: Record<string, unknown> | null,
): string[] {
  if (!target) {
    return [];
  }

  const extensions: string[] = [];
  if (getBoolean(target.multiply_extension)) {
    extensions.push("M");
  }
  if (getBoolean(target.atomic_extension)) {
    extensions.push("A");
  }
  if (getBoolean(target.compressed_extension)) {
    extensions.push("C");
  }
  if (getBoolean(target.extra_compressed_extension)) {
    extensions.push("XW");
  }
  if (getBoolean(target.bit_extension)) {
    extensions.push("B");
  }
  if (getBoolean(target.multiplication_subset_of_the_M_extension)) {
    extensions.push("Zmmul");
  }

  return extensions;
}

function buildCompilerPath(commandPrefix: string): string {
  if (!commandPrefix) {
    return "";
  }

  return `${commandPrefix}gcc`;
}

function normalizeCStandard(value: string | null): string {
  if (!value) {
    return "";
  }

  return value.replace(/^gnu(\d+)/, "gnu$1");
}

function normalizeCppStandard(value: string | null): string {
  if (!value) {
    return "";
  }

  const match = /^gnu(?:cpp|\+\+)?(\d+)$/.exec(value);
  if (match) {
    return `gnu++${match[1]}`;
  }

  const cppMatch = /^c(?:pp|\+\+)?(\d+)$/.exec(value);
  if (cppMatch) {
    return `c++${cppMatch[1]}`;
  }

  return value;
}

function buildArchitectureArgs(
  targetArchitecture: string,
  targetAbi: string,
  riscvExtensions: string[],
): string[] {
  const args: string[] = [];

  if (targetArchitecture) {
    args.push(`-march=${buildMarch(targetArchitecture, riscvExtensions)}`);
  }

  if (targetAbi) {
    args.push(`-mabi=${targetAbi}`);
  }

  return args;
}

function buildMarch(
  targetArchitecture: string,
  riscvExtensions: string[],
): string {
  const extensions = riscvExtensions
    .map((item) => item.toLowerCase())
    .filter((item) => item !== "zmmul");
  const suffix = extensions.join("");
  const base = targetArchitecture || "rv32i";

  if (riscvExtensions.includes("Zmmul")) {
    return suffix ? `${base}${suffix}_zmmul` : `${base}_zmmul`;
  }

  return `${base}${suffix}`;
}

function buildCommonCompilerArgs(
  optimizationLevel: string,
  functionSections: boolean,
  dataSections: boolean,
): string[] {
  return uniqueStrings([
    ...buildOptimizationLevelArgs(optimizationLevel),
    ...(functionSections ? ["-ffunction-sections"] : []),
    ...(dataSections ? ["-fdata-sections"] : []),
  ]);
}

function buildCommonOptimizationArgs(
  optimization: Record<string, unknown> | null,
): string[] {
  if (!optimization) {
    return [];
  }

  return uniqueStrings([
    ...(getBoolean(optimization.char_is_signed) ? ["-fsigned-char"] : []),
    ...(getBoolean(optimization.no_common_unitialized) ? ["-fno-common"] : []),
    ...(getBoolean(optimization.do_not_inline_functions)
      ? ["-fno-inline"]
      : []),
    ...(getBoolean(optimization.assume_freestanding_environment)
      ? ["-ffreestanding"]
      : []),
    ...(getBoolean(optimization.disable_builtin) ? ["-fno-builtin"] : []),
    ...(getBoolean(optimization.single_precision_constants)
      ? ["-fsingle-precision-constant"]
      : []),
    ...(getBoolean(optimization.position_independent_code) ? ["-fpic"] : []),
    ...(getBoolean(optimization.link_time_optimizer) ? ["-flto"] : []),
    ...(getBoolean(optimization.disable_loop_invariant_move)
      ? ["-fno-move-loop-invariants"]
      : []),
    ...(getBoolean(optimization.code_generation_without_hardware_floating)
      ? ["-msoft-float"]
      : []),
    ...(getBoolean(optimization.use_pipelines) ? ["-pipe"] : []),
    ...(getBoolean(optimization.show_caret_indicating_the_column)
      ? ["-fdiagnostics-show-caret"]
      : []),
    ...splitSpaceFlags(getString(optimization.other_optimization_flags)),
  ]);
}

function buildOptimizationLevelArgs(level: string): string[] {
  switch (level.toLowerCase()) {
    case "":
      return [];
    case "none":
      return ["-O0"];
    case "debug":
      return ["-Og"];
    case "size":
      return ["-Os"];
    case "optimize":
      return ["-O1"];
    case "more":
      return ["-O2"];
    case "most":
      return ["-O3"];
    case "fast":
      return ["-Os"];
    case "z":
      return ["-Oz"];
    default:
      return level.startsWith("-Os") ? [level] : [];
  }
}

function buildCommonWarningArgs(
  warnings: Record<string, unknown> | null,
): string[] {
  if (!warnings) {
    return [];
  }

  return uniqueStrings([
    ...(getBoolean(warnings.check_syntax_only) ? ["-fsyntax-only"] : []),
    ...(getBoolean(warnings.pedantic) ? ["-pedantic"] : []),
    ...(getBoolean(warnings.pedantic_warnings_as_errors)
      ? ["-pedantic-errors"]
      : []),
    ...(getBoolean(warnings.inhibit_all_warnings) ? ["-w"] : []),
    ...(getBoolean(warnings.warn_on_various_unused_elements)
      ? ["-Wunused"]
      : []),
    ...(getBoolean(warnings.warn_on_uninitialized_variables)
      ? ["-Wuninitialized"]
      : []),
    ...(getBoolean(warnings.enable_all_common_warnings) ? ["-Wall"] : []),
    ...(getBoolean(warnings.enable_extra_warnings) ? ["-Wextra"] : []),
    ...(getBoolean(warnings.warn_on_undeclared_global_function)
      ? ["-Wmissing-declarations"]
      : []),
    ...(getBoolean(warnings.warn_on_implicit_conversions)
      ? ["-Wconversion"]
      : []),
    ...(getBoolean(warnings.warn_if_pointer_arthmetic)
      ? ["-Wpointer-arith"]
      : []),
    ...(getBoolean(warnings.warn_if_padding_is_included) ? ["-Wpadded"] : []),
    ...(getBoolean(warnings.warn_if_shadowed_variable) ? ["-Wshadow"] : []),
    ...(getBoolean(warnings.warn_if_suspicious_logical_ops)
      ? ["-Wlogical-op"]
      : []),
    ...(getBoolean(warnings.warn_if_struct_is_returned)
      ? ["-Waggregate-return"]
      : []),
    ...(getBoolean(warnings.warn_if_floats_are_compared_as_equal)
      ? ["-Wfloat-equal"]
      : []),
    ...(getBoolean(warnings.generate_errors_instead_of_warnings)
      ? ["-Werror"]
      : []),
    ...splitSpaceFlags(getString(warnings.other_warning_flags)),
  ]);
}

function buildCompilerDebuggingArgs(
  debugging: Record<string, unknown> | null,
): string[] {
  if (!debugging) {
    return [];
  }

  return uniqueStrings([
    ...buildDebugLevelArgs(getString(debugging.debug_level)),
    ...buildDebugFormatArgs(getString(debugging.debug_format)),
    ...(getBoolean(debugging.generate_prof_information) ? ["-p"] : []),
    ...(getBoolean(debugging.generate_gprof_information) ? ["-pg"] : []),
    ...splitSpaceFlags(getString(debugging.other_debugging_flags)),
  ]);
}

function buildDebugLevelArgs(debugLevel: string | null): string[] {
  if (!debugLevel || debugLevel.toLowerCase() === "none") {
    return [];
  }

  const normalized = debugLevel.toLowerCase();
  if (normalized === "default") {
    return ["-g"];
  }
  if (normalized === "minimal") {
    return ["-g1"];
  }
  if (normalized === "max" || normalized === "maximum") {
    return ["-g3"];
  }
  if (/^g\d?$/.test(normalized)) {
    return [`-${normalized}`];
  }

  return [];
}

function buildDebugFormatArgs(debugFormat: string | null): string[] {
  if (!debugFormat || debugFormat.toLowerCase() === "default") {
    return [];
  }

  const normalized = debugFormat.toLowerCase();
  if (normalized.startsWith("dwarf")) {
    const version = normalized.replace(/[^0-9]/g, "");
    return [version ? `-gdwarf-${version}` : "-gdwarf"];
  }
  if (normalized.startsWith("stabs")) {
    return ["-gstabs"];
  }

  return [];
}

function buildCSpecificWarningArgs(
  warnings: Record<string, unknown> | null,
): string[] {
  if (!warnings) {
    return [];
  }

  return uniqueStrings([
    ...(getBoolean(warnings.warn_if_a_global_function_has_no_prototype)
      ? ["-Wmissing-prototypes"]
      : []),
    ...(getBoolean(warnings.warn_if_a_function_has_no_arg_type)
      ? ["-Wstrict-prototypes"]
      : []),
    ...(getBoolean(warnings.warn_if_wrong_cast) ? ["-Wbad-function-cast"] : []),
  ]);
}

function buildCppSpecificOptimizationArgs(
  optimization: Record<string, unknown> | null,
): string[] {
  if (!optimization) {
    return [];
  }

  const abiVersion = getString(optimization.abi_version);
  return uniqueStrings([
    ...(abiVersion && abiVersion !== "default"
      ? [`-fabi-version=${abiVersion}`]
      : []),
    ...(getBoolean(optimization.do_not_use_exceptions)
      ? ["-fno-exceptions"]
      : []),
    ...(getBoolean(optimization.do_not_use_rtti) ? ["-fno-rtti"] : []),
    ...(getBoolean(optimization.do_not_use__cxa_atexit)
      ? ["-fno-use-cxa-atexit"]
      : []),
    ...(getBoolean(optimization.do_not_use_thread_safe_statics)
      ? ["-fno-threadsafe-statics"]
      : []),
  ]);
}

function buildCppSpecificWarningArgs(
  warnings: Record<string, unknown> | null,
): string[] {
  if (!warnings) {
    return [];
  }

  return uniqueStrings([
    ...(getBoolean(warnings.warn_on_abi_violations) ? ["-Wabi"] : []),
    ...(getBoolean(warnings.warn_on_class_privacy)
      ? ["-Wctor-dtor-privacy"]
      : []),
    ...(getBoolean(warnings.warn_on_no_except_expressions)
      ? ["-Wnoexcept"]
      : []),
    ...(getBoolean(warnings.warn_on_virtual_destructors)
      ? ["-Wnon-virtual-dtor"]
      : []),
    ...(getBoolean(warnings.warn_on_uncast_null) ? ["-Wconversion-null"] : []),
    ...(getBoolean(warnings.warn_on_sign_promotion) ? ["-Wsign-promo"] : []),
    ...(getBoolean(warnings.warn_about_effictive_cpp_violcations)
      ? ["-Weffc++"]
      : []),
  ]);
}

function buildCompilerPreprocessorArgs(
  doNotSearchSystemDirectories: boolean,
  doNotSearchSystemCppDirectories: boolean,
  preprocessOnly: boolean,
  undefinedSymbols: string[],
): string[] {
  return uniqueStrings([
    ...(doNotSearchSystemDirectories ? ["-nostdinc"] : []),
    ...(doNotSearchSystemCppDirectories ? ["-nostdinc++"] : []),
    ...(preprocessOnly ? ["-E"] : []),
    ...undefinedSymbols.map((symbol) => `-U${symbol}`),
  ]);
}

function buildAssemblerPreprocessorArgs(
  usePreprocessor: boolean,
  doNotSearchSystemDirectories: boolean,
  preprocessOnly: boolean,
  undefinedSymbols: string[],
): string[] {
  return uniqueStrings([
    ...(usePreprocessor ? ["-x", "assembler-with-cpp"] : []),
    ...(doNotSearchSystemDirectories ? ["-nostdinc"] : []),
    ...(preprocessOnly ? ["-E"] : []),
    ...undefinedSymbols.map((symbol) => `-U${symbol}`),
  ]);
}

function buildCompilerMiscArgs(
  generateAssemblerListing: boolean,
  saveTemporaryFiles: boolean,
  verbose: boolean,
): string[] {
  return uniqueStrings([
    ...(generateAssemblerListing ? ["-fverbose-asm"] : []),
    ...(saveTemporaryFiles ? ["-save-temps=obj"] : []),
    ...(verbose ? ["-v"] : []),
  ]);
}

function buildAssemblerMiscArgs(
  assemblerFlags: string[],
  generateAssemblerListing: boolean,
  saveTemporaryFiles: boolean,
  verbose: boolean,
): string[] {
  return uniqueStrings([
    ...assemblerFlags,
    ...(generateAssemblerListing ? ["-fverbose-asm"] : []),
    ...(saveTemporaryFiles ? ["-save-temps=obj"] : []),
    ...(verbose ? ["-v"] : []),
  ]);
}

function buildLinkBehaviorArgs(config: {
  doNotUseStandardStartFiles: boolean;
  doNotUseDefaultLibraries: boolean;
  noStartupOrDefaultLibs: boolean;
  removeUnusedSections: boolean;
  printRemovedSections: boolean;
  omitAllSymbolInformation: boolean;
  useNewlibNano: boolean;
  useFloatWithNanoPrintf: boolean;
  useFloatWithNanoScanf: boolean;
  doNotUseSyscalls: boolean;
}): string[] {
  const flags: string[] = [];

  if (config.noStartupOrDefaultLibs) {
    flags.push("-nostdlib");
  } else {
    if (config.doNotUseStandardStartFiles) {
      flags.push("-nostartfiles");
    }
    if (config.doNotUseDefaultLibraries) {
      flags.push("-nodefaultlibs");
    }
  }

  if (config.removeUnusedSections) {
    flags.push("-Wl,--gc-sections");
  }
  if (config.printRemovedSections) {
    flags.push("-Wl,--print-gc-sections");
  }
  if (config.omitAllSymbolInformation) {
    flags.push("-Wl,-s");
  }
  if (config.useNewlibNano) {
    flags.push("--specs=nano.specs");
  }
  if (config.doNotUseSyscalls) {
    flags.push("--specs=nosys.specs");
  }
  if (config.useFloatWithNanoPrintf) {
    flags.push("-u", "_printf_float");
  }
  if (config.useFloatWithNanoScanf) {
    flags.push("-u", "_scanf_float");
  }

  return flags;
}

function buildLinkMiscArgs(
  linkTimeOptimizer: boolean,
  generateProfInformation: boolean,
  generateGprofInformation: boolean,
  debuggingFlags: string[],
  crossReference: boolean,
  printLinkMap: boolean,
  verbose: boolean,
  picolibc: string,
): string[] {
  return uniqueStrings([
    ...(linkTimeOptimizer ? ["-flto"] : []),
    ...(generateProfInformation ? ["-p"] : []),
    ...(generateGprofInformation ? ["-pg"] : []),
    ...debuggingFlags,
    ...(crossReference ? ["-Wl,--cref"] : []),
    ...(printLinkMap ? ["-Wl,-M"] : []),
    ...(verbose ? ["-v"] : []),
    ...(picolibc && picolibc.toLowerCase() !== "disabled"
      ? ["--specs=picolibc.specs"]
      : []),
  ]);
}

// MRS "hex and bin" 选项存储的值为 "ihexAndbinary"，标准 objcopy 不支持。
// 将其映射为 ihex（与 MRS 自己生成的 makefile 行为一致）。
const VALID_BFD_TARGETS = new Set(["ihex", "binary", "srec"]);

function normalizeFlashOutputFormat(format: string): string {
  const normalized = (format || "ihex").toLowerCase();
  return VALID_BFD_TARGETS.has(normalized) ? normalized : "ihex";
}

function buildFlashArgs(
  outputFormat: string,
  copyOnlySectionText: boolean,
  copyOnlySectionData: boolean,
  copyOnlySections: string[],
  flashFlags: string[],
): string[] {
  const format = normalizeFlashOutputFormat(outputFormat);
  return uniqueStrings([
    "-O",
    format,
    ...(copyOnlySectionText ? ["-j", ".text"] : []),
    ...(copyOnlySectionData ? ["-j", ".data"] : []),
    ...copyOnlySections.flatMap((section) => ["-j", section]),
    ...flashFlags,
  ]);
}

function buildListArgs(
  displayAllHeaders: boolean,
  disassemble: boolean,
  displaySource: boolean,
  demangleNames: boolean,
  displayDebugInfo: boolean,
  displayFileHeaders: boolean,
  displayLineNumbers: boolean,
  displayRelocationInfo: boolean,
  displaySymbols: boolean,
  wideLines: boolean,
  listFlags: string[],
): string[] {
  const flags: string[] = [];
  if (displayAllHeaders) {
    flags.push("-x");
  }
  if (disassemble) {
    flags.push("-d");
  }
  if (displaySource) {
    flags.push("-S");
  }
  if (demangleNames) {
    flags.push("-C");
  }
  if (displayDebugInfo) {
    flags.push("-g");
  }
  if (displayFileHeaders) {
    flags.push("-f");
  }
  if (displayLineNumbers) {
    flags.push("-l");
  }
  if (displayRelocationInfo) {
    flags.push("-r");
  }
  if (displaySymbols) {
    flags.push("-t");
  }
  if (wideLines) {
    flags.push("-w");
  }

  return uniqueStrings([...flags, ...listFlags]);
}

function buildSizeArgs(
  sizeFormat: string,
  hex: boolean,
  showTotals: boolean,
  sizeFlags: string[],
): string[] {
  const flags: string[] = [];

  switch (sizeFormat.toLowerCase()) {
    case "sysv":
      flags.push("--format=sysv");
      break;
    case "gnu":
      flags.push("--format=gnu");
      break;
    default:
      flags.push("--format=berkeley");
      break;
  }

  if (hex) {
    flags.push("--radix=16");
  }
  if (showTotals) {
    flags.push("--totals");
  }

  return uniqueStrings([...flags, ...sizeFlags]);
}

function resolveOpenOcdDebugConfig(
  executable: string,
  configOptions: string[],
): { executable: string; configOptions: string[] } {
  const normalizedConfigOptions = configOptions.flatMap((item) =>
    splitCommandLineArguments(item),
  );
  const mounRiverStudioPath = getConfiguredMounRiverStudioPath();
  const openOcdPaths = resolveOpenOcdPaths(mounRiverStudioPath);
  if (!openOcdPaths) {
    return {
      executable: normalizeMounRiverArgument(executable),
      configOptions: normalizedConfigOptions.map((item) => normalizeMounRiverArgument(item)),
    };
  }

  return {
    executable:
      resolveMounRiverOpenOcdExecutable(openOcdPaths, executable) ??
      normalizeMounRiverArgument(executable),
    configOptions: normalizedConfigOptions.map((item) =>
      resolveMounRiverOpenOcdValue(openOcdPaths, item),
    ),
  };
}

function resolveToolchainMetadata(gdbExecutable: string): WchToolchainModel {
  const matchedToolchainName = /\$\{WCH:Toolchain:([^}]+)\}/
    .exec(gdbExecutable)?.[1]
    ?.trim()
    ?.toUpperCase();
  switch (matchedToolchainName) {
    case "GCC":
    case "GCC8":
      return buildResolvedToolchain("RISC-V Embedded GCC", "riscv-none-embed-");
    case "GCC12":
      return buildResolvedToolchain("RISC-V Embedded GCC12", "riscv-wch-elf-");
    case "GCC15":
      return buildResolvedToolchain(
        "RISC-V Embedded GCC15",
        "riscv32-wch-elf-",
      );
    default:
      return buildResolvedToolchain("", "");
  }
}

function buildResolvedToolchain(
  directoryName: string,
  executablePrefix: string,
): WchToolchainModel {
  return {
    directoryName,
    executablePrefix,
    executables: {
      gcc: executablePrefix ? `${executablePrefix}gcc.exe` : "",
      gpp: executablePrefix ? `${executablePrefix}g++.exe` : "",
      gdb: executablePrefix ? `${executablePrefix}gdb.exe` : "",
      objcopy: executablePrefix ? `${executablePrefix}objcopy.exe` : "",
      objdump: executablePrefix ? `${executablePrefix}objdump.exe` : "",
      size: executablePrefix ? `${executablePrefix}size.exe` : "",
    },
  };
}

function getOptionValue(
  options: Record<string, unknown>[],
  superClassSuffix: string,
): string | null {
  const option = options.find((item) =>
    getString(item["@_superClass"])?.includes(superClassSuffix),
  );
  return getString(option?.["@_value"]);
}

function trimOptionEnumValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

function getLaunchCommands(value: unknown): string[] {
  const text = getString(value);
  if (!text) {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getLaunchArguments(value: unknown): string[] {
  return getLaunchCommands(value).flatMap((item) => splitCommandLineArguments(item));
}

function splitCommandLineArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }

    if (quote === char) {
      quote = null;
      current += char;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function splitPipeList(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function splitSpaceFlags(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getFirstString(value: unknown): string {
  return getString(asArray(value)[0]) ?? "";
}

function getStringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => getString(item))
    .filter((item): item is string => item !== null && item.length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

// 从 .wvproj 的 linkedFolders 中提取有效目录路径。
function extractLinkedFolders(value: unknown): WchLinkedFolder[] {
  return asArray(value)
    .map((item) => {
      const textValue = getString(item);
      if (textValue) {
        return {
          name:
            textValue
              .split("/")
              .filter((segment) => segment.length > 0)
              .pop() ?? textValue,
          location: textValue,
        };
      }

      const record = asRecord(item);
      if (!record) {
        return null;
      }

      const location =
        getString(record.path) ??
        getString(record.folderPath) ??
        getString(record.location) ??
        getString(record.targetPath);
      if (!location) {
        return null;
      }

      return {
        name:
          getString(record.name) ??
          location
            .split("/")
            .filter((segment) => segment.length > 0)
            .pop() ??
          location,
        location,
      };
    })
    .filter(
      (item): item is WchLinkedFolder =>
        item !== null && item.location.length > 0,
    );
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function isRecord(
  value: Record<string, unknown> | null,
): value is Record<string, unknown> {
  return value !== null;
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function getBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
