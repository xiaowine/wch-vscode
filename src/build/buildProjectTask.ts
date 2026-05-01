import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ResolvedBuildProject } from './buildProjectResolver';
import { resolveBuildProjectForExecution, resolveCurrentBuildTarget } from './buildProjectResolver';
import { generateBuildFiles } from './makefileGenerator';

export const BUILD_PROJECT_COMMAND = 'wchVscode.buildProject';

export function hasCurrentBuildTarget(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): boolean {
	return Boolean(resolveCurrentBuildTarget(editor).target);
}

export function getCurrentBuildTargetTooltip(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): string {
	const resolution = resolveCurrentBuildTarget(editor);
	if (!resolution.target) {
		return resolution.error ?? '当前未找到可编译的 WCH 工程';
	}

	const { model } = resolution.target;
	return `Build ${model.project.name || model.baseName}`;
}

export async function buildCurrentProject(
	editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): Promise<void> {
	let project: ResolvedBuildProject;
	try {
		project = await resolveBuildProjectForExecution(editor);
	} catch (error) {
		void vscode.window.showErrorMessage(asErrorMessage(error));
		return;
	}

	try {
		await generateBuildFiles(project);
	} catch (error) {
		void vscode.window.showErrorMessage(`生成 makefile 失败：${asErrorMessage(error)}`);
		return;
	}

	await vscode.tasks.executeTask(createBuildTask(project));
}

function createBuildTask(project: ResolvedBuildProject): vscode.Task {
	const execution = new vscode.ProcessExecution(
		project.toolchainPaths.make,
		[],
		{
			cwd: project.outputDirectory,
			env: {
				PATH: `${path.dirname(project.toolchainPaths.gcc)};${process.env.PATH ?? ''}`,
			},
		},
	);
	const task = new vscode.Task(
		{
			type: 'wchBuild',
			workspaceFolder: project.workspaceFolder.name,
			projectName: project.model.project.name || project.model.baseName,
		},
		project.workspaceFolder,
		`Build ${project.model.project.name || project.model.baseName}`,
		'wch-vscode',
		execution,
		[],
	);
	task.group = vscode.TaskGroup.Build;
	task.presentationOptions = {
		clear: true,
		panel: vscode.TaskPanelKind.Dedicated,
		reveal: vscode.TaskRevealKind.Always,
	};
	return task;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
