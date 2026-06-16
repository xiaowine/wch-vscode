import * as vscode from 'vscode';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { buildWchProjectModels, getUnsupportedProjectReason } from './projectModelBuilder';
import type { ParsedProjectPair, ParsedProjectFile, ParsedWchProject } from './projectState';
import { t } from './i18n';

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
});

const textDecoder = new TextDecoder('utf-8');

// 解析命中项目对应的全部 XML 文件内容，并整理成统一结构。
export async function parseMatchedProjectFiles(
	folder: vscode.WorkspaceFolder,
	cprojectFiles: vscode.Uri[],
	launchFiles: vscode.Uri[],
	wvprojFiles: vscode.Uri[],
	matchingBaseNames: string[],
	unconfiguredWvprojFiles: vscode.Uri[],
): Promise<ParsedWchProject> {
	const cprojectResults = await Promise.all(cprojectFiles.map((file) => parseCprojectFile(file)));
	const launchMap = await createLaunchFileMap(launchFiles);
	const wvprojMap = await createWvprojFileMap(wvprojFiles);
	const projectPairs: ParsedProjectPair[] = [];

	for (const baseName of matchingBaseNames) {
		const launch = launchMap.get(baseName);
		const wvproj = wvprojMap.get(baseName);

		if (!launch || !wvproj) {
			continue;
		}

		projectPairs.push({
			baseName,
			launch,
			wvproj,
		});
	}

	const project: ParsedWchProject = {
		folderPath: folder.uri.fsPath,
		folderName: folder.name,
		cprojectFiles: cprojectResults,
		projectPairs,
		models: [],
	};

	project.models = buildWchProjectModels(project);
	project.unsupportedReason = getUnsupportedProjectReason(project);
	if (project.models.length === 0 && project.projectPairs.length === 0 && unconfiguredWvprojFiles.length > 0) {
		project.unsupportedReason = t('error.projectDownloadNotConfigured');
		project.configurationWvprojPath = unconfiguredWvprojFiles[0].fsPath;
	}
	return project;
}

// 读取并解析 .cproject XML 文件。
export async function parseCprojectFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	return parseXmlFile(file, 'cproject-xml');
}

// 读取并解析 .wvproj JSON 文件。
export async function parseWvprojFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	try {
		const content = await readTextFile(file);
		if (content.trim().length === 0) {
			throw new Error(t('error.projectFileEmpty'));
		}

		const data = JSON.parse(content);
		if (!isValidWvprojData(data)) {
			throw new Error(t('error.projectFileInvalidData'));
		}

		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format: 'wvproj-json',
			data,
		};
	} catch (error) {
		return createParseErrorResult(file, 'wvproj-json', error);
	}
}

// 将 .launch 文件解析后按去后缀基名建立索引。
async function createLaunchFileMap(files: vscode.Uri[]): Promise<Map<string, ParsedProjectFile>> {
	const entries = await Promise.all(
		files.map(async (file) => [getBaseName(file, '.launch'), await parseLaunchFile(file)] as const),
	);

	return new Map(entries);
}

// 将 .wvproj 文件按 JSON 解析后按去后缀基名建立索引。
async function createWvprojFileMap(files: vscode.Uri[]): Promise<Map<string, ParsedProjectFile>> {
	const entries = await Promise.all(
		files.map(async (file) => [getBaseName(file, '.wvproj'), await parseWvprojFile(file)] as const),
	);

	return new Map(entries);
}

async function parseXmlFile(file: vscode.Uri, format: 'cproject-xml' | 'launch-xml'): Promise<ParsedProjectFile> {
	try {
		const xmlContent = await readTextFile(file);
		if (xmlContent.trim().length === 0) {
			throw new Error(t('error.projectFileEmpty'));
		}

		const validationResult = XMLValidator.validate(xmlContent);
		if (validationResult !== true) {
			throw new Error(validationResult.err.msg);
		}

		const data = xmlParser.parse(xmlContent, true);
		if (!isValidXmlProjectData(data, format)) {
			throw new Error(t('error.projectFileInvalidData'));
		}

		return {
			filePath: file.fsPath,
			fileName: getFileName(file),
			format,
			data,
		};
	} catch (error) {
		return createParseErrorResult(file, format, error);
	}
}

// 读取并解析 .launch XML 文件。
async function parseLaunchFile(file: vscode.Uri): Promise<ParsedProjectFile> {
	return parseXmlFile(file, 'launch-xml');
}

async function readTextFile(file: vscode.Uri): Promise<string> {
	const content = await vscode.workspace.fs.readFile(file);
	return textDecoder.decode(content);
}

function createParseErrorResult(
	file: vscode.Uri,
	format: ParsedProjectFile['format'],
	error: unknown,
): ParsedProjectFile {
	return {
		filePath: file.fsPath,
		fileName: getFileName(file),
		format,
		data: null,
		parseError: error instanceof Error ? error.message : String(error),
	};
}

function isParsedObject(data: unknown): data is Record<string, unknown> {
	return typeof data === 'object' && data !== null && !Array.isArray(data);
}

function isValidXmlProjectData(data: unknown, format: 'cproject-xml' | 'launch-xml'): data is Record<string, unknown> {
	if (!isParsedObject(data)) {
		return false;
	}

	if (format === 'cproject-xml') {
		return isParsedObject(data.cproject);
	}

	return isParsedObject(data.launchConfiguration);
}

function isValidWvprojData(data: unknown): data is Record<string, unknown> {
	if (!isParsedObject(data)) {
		return false;
	}

	const basic = data.basic;
	const buildConfig = data.buildConfig;
	if (!isParsedObject(basic) || !isParsedObject(buildConfig)) {
		return false;
	}

	return Array.isArray(buildConfig.configurations) && buildConfig.configurations.length > 0;
}

// 取文件名，用于展示和调试。
function getFileName(file: vscode.Uri): string {
	return file.path.split('/').pop() ?? file.fsPath;
}

// 取文件去掉指定后缀后的基名，用于匹配 .launch 和 .wvproj。
function getBaseName(file: vscode.Uri, suffix: string): string {
	const name = getFileName(file);
	return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
