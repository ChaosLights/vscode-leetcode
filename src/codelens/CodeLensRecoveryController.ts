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
    "vscode-remote",
]);
const GUEST_CODE_LENS_SCHEME: string = "vsls";
const CODE_LENS_REFRESH_SELECTOR: vscode.DocumentSelector = {
    scheme: "leetcode-codelens-refresh-never",
};
const EMPTY_CODE_LENS_PROVIDER: vscode.CodeLensProvider = {
    provideCodeLenses: (): vscode.CodeLens[] => [],
};

export const DEFAULT_CODE_LENS_RECOVERY_DELAYS_MS: ReadonlyArray<number> = [1000, 3500];

interface IVisibleCodeLensDocuments {
    guestCount: number;
    localCount: number;
}

/**
 * VS Code can keep an empty CodeLens model when a Remote/Codespaces editor is
 * restored across a connection failure. Live Share can likewise return an
 * empty first request while co-editing revisions are still being acknowledged,
 * and Live Share 1.1.122 does not forward a later CodeLens refresh event.
 *
 * Retry the visible, recognized LeetCode documents a bounded number of times.
 * A provider event refreshes local/host documents. For a vsls: guest document,
 * toggling a provider whose selector can never match emits a public language
 * feature registry change; Live Share remains the only matching (exclusive)
 * provider and is asked again, so no second set of CodeLens actions is added.
 */
export class CodeLensRecoveryController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[];
    private readonly recoveryDelaysMs: ReadonlyArray<number>;
    private readonly timers: Set<NodeJS.Timeout> = new Set<NodeJS.Timeout>();
    private refreshPulseRegistration: vscode.Disposable | undefined;
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
        this.refreshPulseRegistration?.dispose();
        this.refreshPulseRegistration = undefined;
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
        let guestCount: number = 0;
        let localCount: number = 0;
        for (const editor of vscode.window.visibleTextEditors) {
            const document: vscode.TextDocument = editor.document;
            const metadata: ICodeLensDocumentMetadata | undefined =
                findCodeLensDocumentMetadata(document);
            if (!metadata || !this.isCodeLensEnabled(document)) {
                continue;
            }
            if (document.uri.scheme === GUEST_CODE_LENS_SCHEME) {
                guestCount++;
            } else if (LOCAL_CODE_LENS_SCHEMES.has(document.uri.scheme)) {
                localCount++;
            }
        }
        return { guestCount, localCount };
    }

    private isCodeLensEnabled(document: vscode.TextDocument): boolean {
        return vscode.workspace.getConfiguration("editor", {
            uri: document.uri,
            languageId: document.languageId,
        }).get<boolean>("codeLens", true);
    }

    private pulseCodeLensRegistry(): void {
        if (this.refreshPulseRegistration) {
            this.refreshPulseRegistration.dispose();
            this.refreshPulseRegistration = undefined;
            return;
        }
        this.refreshPulseRegistration =
            vscode.languages.registerCodeLensProvider(CODE_LENS_REFRESH_SELECTOR, EMPTY_CODE_LENS_PROVIDER);
    }

    private recoverVisibleDocuments(attempt: number): void {
        const documents: IVisibleCodeLensDocuments = this.getVisibleCodeLensDocuments();
        if (!documents.localCount && !documents.guestCount) {
            return;
        }
        if (documents.guestCount) {
            this.pulseCodeLensRegistry();
        } else {
            this.localProvider.refresh();
        }
        leetCodeChannel.appendLine(
            `[codelens] recovery attempt=${attempt}, local=${documents.localCount}, ` +
            `guest=${documents.guestCount}.`,
        );
    }
}
