// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { CodeLensRecoveryController } from "./CodeLensRecoveryController";
import { EditorActionInlayHintProvider } from "./EditorActionInlayHintProvider";
import {
    findCodeLensDocumentMetadata,
    ICodeLensDocumentMetadata,
    LiveShareSafeCodeLensProvider,
} from "./LiveShareSafeCodeLensProvider";
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
    private readonly normalizingDocuments: Set<string> = new Set<string>();
    private disposed: boolean = false;

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
            vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
                this.scheduleHintRecovery();
                if (editor) {
                    this.handleRemoteDocument(editor.document);
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors((editors: readonly vscode.TextEditor[]) => {
                this.scheduleHintRecovery();
                for (const editor of editors) {
                    this.handleRemoteDocument(editor.document);
                }
            }),
            vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
                this.scheduleHintRecovery();
                this.handleRemoteDocument(document);
            }),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
                if (this.isRemoteActionDocument(event.document)) {
                    this.hintProvider.refresh();
                    void this.ensureFooterActionLine(event.document);
                } else {
                    this.provider.refresh();
                }
            }),
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
        for (const editor of vscode.window.visibleTextEditors) {
            this.handleRemoteDocument(editor.document);
        }
    }

    public refresh(): void {
        this.provider.refresh();
        this.hintProvider.refresh();
        this.recoveryController.schedule();
        this.scheduleHintRecovery();
    }

    public dispose(): void {
        this.disposed = true;
        for (const timer of this.hintRecoveryTimers) {
            clearTimeout(timer);
        }
        this.hintRecoveryTimers.clear();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private handleRemoteDocument(document: vscode.TextDocument): void {
        if (!this.isRemoteActionDocument(document)) {
            return;
        }
        this.hintProvider.refresh();
        void this.ensureFooterActionLine(document);
    }

    private isRemoteActionDocument(document: vscode.TextDocument): boolean {
        return document.uri.scheme === "vscode-remote" || document.uri.scheme === "vsls";
    }

    private async ensureFooterActionLine(document: vscode.TextDocument): Promise<void> {
        const documentKey: string = document.uri.toString();
        if (this.disposed || document.isClosed || this.normalizingDocuments.has(documentKey)) {
            return;
        }
        const metadata: ICodeLensDocumentMetadata | undefined =
            findCodeLensDocumentMetadata(document);
        if (!metadata) {
            return;
        }

        const lineAfterFooter: vscode.TextLine | undefined =
            metadata.footerLine + 1 < document.lineCount
                ? document.lineAt(metadata.footerLine + 1)
                : undefined;
        if (lineAfterFooter?.isEmptyOrWhitespace) {
            return;
        }

        const edit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
        const endOfLine: string = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        if (lineAfterFooter) {
            edit.insert(document.uri, lineAfterFooter.range.start, endOfLine);
        } else {
            edit.insert(document.uri, document.lineAt(metadata.footerLine).range.end, endOfLine);
        }

        this.normalizingDocuments.add(documentKey);
        try {
            if (await vscode.workspace.applyEdit(edit)) {
                this.hintProvider.refresh();
            }
        } finally {
            this.normalizingDocuments.delete(documentKey);
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
