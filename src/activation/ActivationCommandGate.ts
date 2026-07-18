// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

type CommandHandler = (...args: any[]) => any;

/**
 * Registers contributed commands synchronously while making their work wait for
 * the extension's asynchronous initialization. This closes the reconnect window
 * where a restored inlay hint can be clicked before its command exists.
 */
export class ActivationCommandGate {
    private readonly ready: Promise<void>;
    private resolveReady!: () => void;
    private settled: boolean = false;
    private failed: boolean = false;

    constructor(private readonly progressTitle: string = "Starting LeetCode...") {
        this.ready = new Promise<void>((resolve: () => void) => {
            this.resolveReady = resolve;
        });
    }

    public wrap(handler: CommandHandler): CommandHandler {
        return async (...args: any[]): Promise<any> => {
            if (!this.settled) {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: this.progressTitle,
                        cancellable: false,
                    },
                    () => this.ready,
                );
            }
            if (this.failed) {
                vscode.window.showErrorMessage(
                    "LeetCode failed to start. Open the LeetCode output channel for details.",
                );
                return undefined;
            }
            return handler(...args);
        };
    }

    public succeed(): void {
        this.settle(false);
    }

    public fail(): void {
        this.settle(true);
    }

    private settle(failed: boolean): void {
        if (this.settled) {
            return;
        }
        this.failed = failed;
        this.settled = true;
        this.resolveReady();
    }
}
