// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import {
    JudgeOperationKind,
    runWithCliSessionRecovery,
} from "../utils/cliSessionRecovery";

export async function runJudgeOperationWithSessionRecovery<T>(
    operationKind: JudgeOperationKind,
    operation: () => Promise<T>,
): Promise<T> {
    return await runWithCliSessionRecovery(
        operationKind,
        operation,
        () => leetCodeManager.repairCliLogin(),
        {
            onRepair: (): void => {
                leetCodeChannel.appendLine(
                    `[${label(operationKind)}] Judge still rejected the session; rebuilding the CLI session ` +
                    "from the verified cookie.",
                );
            },
            onRetry: (attempt: number, delayMilliseconds: number): void => {
                const seconds: number = delayMilliseconds / 1000;
                const message: string =
                    `LeetCode judge session is synchronizing; retrying ${label(operationKind).toLowerCase()} ` +
                    `in ${seconds} seconds (recovery ${attempt}/2)...`;
                leetCodeChannel.appendLine(`[${label(operationKind)}] ${message}`);
                vscode.window.setStatusBarMessage(message, delayMilliseconds);
            },
        },
    );
}

function label(operationKind: JudgeOperationKind): string {
    return operationKind === "submit" ? "Submit" : "Test";
}
