import * as vscode from "vscode";

export async function executeTaskAndWait(
  task: vscode.Task,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution !== execution) {
        return;
      }

      disposable.dispose();
      resolve(event.exitCode);
    });

    vscode.tasks.executeTask(task).then(
      (taskExecution) => {
        execution = taskExecution;
      },
      (error: unknown) => {
        disposable.dispose();
        reject(error);
      },
    );
  });
}
