// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import {
    findCodeLensDocumentMetadata,
    ICodeLensDocumentMetadata,
    LiveShareSafeCodeLensProvider,
} from "./LiveShareSafeCodeLensProvider";

const LOCAL_CODE_LENS_SCHEMES: ReadonlySet<string> = new Set<string>([
    "file",
    "untitled",
]);

export const DEFAULT_CODE_LENS_RECOVERY_DELAYS_MS: ReadonlyArray<number> = [1000, 3500];

interface IVisibleCodeLensDocuments {
    localCount: number;
}

/**
 * Retry visible local CodeLens documents a bounded number of times after an
 * editor switch or restore. Remote/Codespaces and Live Share documents use the
 * local inline-action provider instead, because forwarding a parameterized
 * CodeLens through Live Share can discard its command between extension hosts.
 */
export class CodeLensRecoveryController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[];
    private readonly recoveryDelaysMs: ReadonlyArray<number>;
    private readonly timers: Set<NodeJS.Timeout> = new Set<NodeJS.Timeout>();
    private scheduleGeneration: number = 0;

    constructor(
        private readonly localProvider: LiveShareSafeCodeLensProvider,
        recoveryDelaysMs: ReadonlyArray<number> = DEFAULT_CODE_LENS_RECOVERY_DELAYS_MS,
    ) {
        this.recoveryDelaysMs = recoveryDelaysMs;
        this.disposables = [
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
            vscode.workspace.onDidOpenTextDocument(() => this.schedule()),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration("editor.codeLens")) {
                    this.schedule();
                }
            }),
        ];
        this.schedule();
    }

    public schedule(): void {
        this.cancelScheduledRecoveries();
        const generation: number = ++this.scheduleGeneration;
        this.recoveryDelaysMs.forEach((delayMs: number, index: number) => {
            let timer: NodeJS.Timeout;
            timer = setTimeout(() => {
                this.timers.delete(timer);
                if (generation === this.scheduleGeneration) {
                    this.recoverVisibleDocuments(index + 1);
                }
            }, delayMs);
            this.timers.add(timer);
        });
    }

    public dispose(): void {
        this.scheduleGeneration++;
        this.cancelScheduledRecoveries();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private cancelScheduledRecoveries(): void {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private getVisibleCodeLensDocuments(): IVisibleCodeLensDocuments {
        let localCount: number = 0;
        for (const editor of vscode.window.visibleTextEditors) {
            const document: vscode.TextDocument = editor.document;
            const metadata: ICodeLensDocumentMetadata | undefined =
                findCodeLensDocumentMetadata(document);
            if (!metadata || !this.isCodeLensEnabled(document)) {
                continue;
            }
            if (LOCAL_CODE_LENS_SCHEMES.has(document.uri.scheme)) {
                localCount++;
            }
        }
        return { localCount };
    }

    private isCodeLensEnabled(document: vscode.TextDocument): boolean {
        return vscode.workspace.getConfiguration("editor", {
            uri: document.uri,
            languageId: document.languageId,
        }).get<boolean>("codeLens", true);
    }

    private recoverVisibleDocuments(attempt: number): void {
        const documents: IVisibleCodeLensDocuments = this.getVisibleCodeLensDocuments();
        if (!documents.localCount) {
            return;
        }
        this.localProvider.refresh();
        leetCodeChannel.appendLine(
            `[codelens] recovery attempt=${attempt}, local=${documents.localCount}.`,
        );
    }
}
