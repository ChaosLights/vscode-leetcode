// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { CodeLensRecoveryController } from "./CodeLensRecoveryController";
import { EditorActionInlayHintProvider } from "./EditorActionInlayHintProvider";
import { LiveShareSafeCodeLensProvider } from "./LiveShareSafeCodeLensProvider";
import { LocalCodeLensCommandBridge } from "./LocalCodeLensCommandBridge";

export const LOCAL_CODE_LENS_SELECTOR: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
];

export const REMOTE_ACTION_HINT_SELECTOR: vscode.DocumentSelector = [
    { scheme: "vscode-remote" },
    { scheme: "vsls" },
];

export class LiveShareCodeLensController implements vscode.Disposable {
    private readonly provider: LiveShareSafeCodeLensProvider;
    private readonly hintProvider: EditorActionInlayHintProvider;
    private readonly recoveryController: CodeLensRecoveryController;
    private readonly disposables: vscode.Disposable[];
    private readonly hintRecoveryTimers: Set<NodeJS.Timeout> = new Set<NodeJS.Timeout>();

    constructor(recoveryDelaysMs?: ReadonlyArray<number>) {
        this.provider = new LiveShareSafeCodeLensProvider();
        this.hintProvider = new EditorActionInlayHintProvider();
        const providerRegistration: vscode.Disposable =
            vscode.languages.registerCodeLensProvider(LOCAL_CODE_LENS_SELECTOR, this.provider);
        const hintProviderRegistration: vscode.Disposable =
            vscode.languages.registerInlayHintsProvider(REMOTE_ACTION_HINT_SELECTOR, this.hintProvider);
        this.recoveryController = new CodeLensRecoveryController(this.provider, recoveryDelaysMs);
        this.disposables = [
            this.recoveryController,
            hintProviderRegistration,
            this.hintProvider,
            providerRegistration,
            this.provider,
            new LocalCodeLensCommandBridge(),
            vscode.window.onDidChangeActiveTextEditor(() => this.scheduleHintRecovery()),
            vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleHintRecovery()),
            vscode.workspace.onDidOpenTextDocument(() => this.scheduleHintRecovery()),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (
                    event.affectsConfiguration("leetcode.editor.shortcuts") ||
                    event.affectsConfiguration("editor.inlayHints")
                ) {
                    this.refresh();
                }
            }),
        ];
        this.scheduleHintRecovery();
    }

    public refresh(): void {
        this.provider.refresh();
        this.hintProvider.refresh();
        this.recoveryController.schedule();
        this.scheduleHintRecovery();
    }

    public dispose(): void {
        for (const timer of this.hintRecoveryTimers) {
            clearTimeout(timer);
        }
        this.hintRecoveryTimers.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private scheduleHintRecovery(): void {
        for (const timer of this.hintRecoveryTimers) {
            clearTimeout(timer);
        }
        this.hintRecoveryTimers.clear();
        for (const delayMs of [0, 750, 2500]) {
            let timer: NodeJS.Timeout;
            timer = setTimeout(() => {
                this.hintRecoveryTimers.delete(timer);
                this.hintProvider.refresh();
            }, delayMs);
            this.hintRecoveryTimers.add(timer);
        }
    }
}
