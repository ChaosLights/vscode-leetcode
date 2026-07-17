// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";
import { leetCodeManager } from "../leetCodeManager";
import { DialogType, promptForOpenOutputChannel, promptForSignIn } from "../utils/uiUtils";
import { getActiveSolutionFile, IActiveSolutionFile } from "../utils/workspaceUtils";
import { IOperationLease, solutionOperationLock } from "../utils/operationLock";
import { leetCodeSubmissionProvider } from "../webview/leetCodeSubmissionProvider";

export async function submitSolution(uri?: vscode.Uri): Promise<void> {
    if (!leetCodeManager.getUser()) {
        promptForSignIn();
        return;
    }

    let solutionFile: IActiveSolutionFile | undefined;
    const operationKey: string = getOperationKey(uri);
    const lease: IOperationLease | undefined = solutionOperationLock.acquire(operationKey, "submit");
    if (!lease) {
        void vscode.window.showInformationMessage(
            `A LeetCode ${solutionOperationLock.getActiveOperation(operationKey)} operation is already running for this file.`,
        );
        return;
    }
    try {
        solutionFile = await getActiveSolutionFile(uri);
        if (!solutionFile) {
            return;
        }
        const result: string = await leetCodeExecutor.submitSolution(solutionFile.filePath);
        leetCodeSubmissionProvider.show(result);
    } catch (error) {
        leetCodeChannel.appendLine(`[Submit] ${getErrorDetails(error)}`);
        await promptForOpenOutputChannel("Failed to submit the solution. Please open the output channel for details.", DialogType.error);
        return;
    } finally {
        if (solutionFile) {
            try {
                await solutionFile.dispose();
            } catch (error) {
                leetCodeChannel.appendLine(`[Submit cleanup] ${getErrorDetails(error)}`);
            }
        }
        lease.release();
    }

    leetCodeTreeDataProvider.refresh();
}

function getErrorDetails(error: any): string {
    return error instanceof Error && error.stack ? error.stack : String(error);
}

function getOperationKey(uri?: vscode.Uri): string {
    return (uri || vscode.window.activeTextEditor?.document.uri)?.toString() || "active-document";
}
