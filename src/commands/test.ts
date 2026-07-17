// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";
import { leetCodeManager } from "../leetCodeManager";
import { IQuickItemEx, UserStatus } from "../shared";
import { IOperationLease, solutionOperationLock } from "../utils/operationLock";
import { prepareTestCaseArgument } from "../utils/testCaseUtils";
import { DialogType, promptForOpenOutputChannel, showFileSelectDialog } from "../utils/uiUtils";
import { getActiveSolutionFile, IActiveSolutionFile } from "../utils/workspaceUtils";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";

export async function testSolution(uri?: vscode.Uri): Promise<void> {
    let solutionFile: IActiveSolutionFile | undefined;
    const operationKey: string = getOperationKey(uri);
    const lease: IOperationLease | undefined = solutionOperationLock.acquire(operationKey, "test");
    if (!lease) {
        void vscode.window.showInformationMessage(
            `A LeetCode ${solutionOperationLock.getActiveOperation(operationKey)} operation is already running for this file.`,
        );
        return;
    }
    try {
        if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
            return;
        }

        solutionFile = await getActiveSolutionFile(uri);
        if (!solutionFile) {
            return;
        }
        const picks: Array<IQuickItemEx<string>> = [];
        picks.push(
            {
                label: "$(three-bars) Default test cases",
                description: "",
                detail: "Test with the default cases",
                value: ":default",
            },
            {
                label: "$(pencil) Write directly...",
                description: "",
                detail: "Write test cases in input box",
                value: ":direct",
            },
            {
                label: "$(file-text) Browse...",
                description: "",
                detail: "Test with the written cases in file",
                value: ":file",
            },
        );
        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks);
        if (!choice) {
            return;
        }

        let result: string | undefined;
        switch (choice.value) {
            case ":default":
                result = await leetCodeExecutor.testSolution(solutionFile.filePath);
                break;
            case ":direct":
                const testString: string | undefined = await vscode.window.showInputBox({
                    prompt: "Enter the test cases.",
                    validateInput: (s: string): string | undefined => s && s.trim() ? undefined : "Test case must not be empty.",
                    placeHolder: "Example: [1,2,3]\\n4",
                    ignoreFocusOut: true,
                });
                if (testString) {
                    result = await leetCodeExecutor.testSolution(
                        solutionFile.filePath,
                        prepareTestCaseArgument(testString),
                    );
                }
                break;
            case ":file":
                const testFile: vscode.Uri[] | undefined = await showFileSelectDialog(solutionFile.sourceUri);
                if (testFile && testFile.length) {
                    const input: string = Buffer.from(await vscode.workspace.fs.readFile(testFile[0])).toString("utf8").trim();
                    if (input) {
                        result = await leetCodeExecutor.testSolution(
                            solutionFile.filePath,
                            prepareTestCaseArgument(input),
                        );
                    } else {
                        vscode.window.showErrorMessage("The selected test file must not be empty.");
                    }
                }
                break;
            default:
                break;
        }
        if (!result) {
            return;
        }
        leetCodeSubmissionProvider.show(result);
    } catch (error) {
        leetCodeChannel.appendLine(`[Test] ${getErrorDetails(error)}`);
        await promptForOpenOutputChannel("Failed to test the solution. Please open the output channel for details.", DialogType.error);
    } finally {
        if (solutionFile) {
            try {
                await solutionFile.dispose();
            } catch (error) {
                leetCodeChannel.appendLine(`[Test cleanup] ${getErrorDetails(error)}`);
            }
        }
        lease.release();
    }
}

function getErrorDetails(error: any): string {
    return error instanceof Error && error.stack ? error.stack : String(error);
}

function getOperationKey(uri?: vscode.Uri): string {
    return (uri || vscode.window.activeTextEditor?.document.uri)?.toString() || "active-document";
}
