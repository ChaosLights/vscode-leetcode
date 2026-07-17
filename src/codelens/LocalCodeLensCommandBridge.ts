// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { editorActionController } from "../editor/EditorActionController";
import { decodeCodeLensBridgeSelection } from "./LiveShareSafeCodeLensProvider";

export class LocalCodeLensCommandBridge implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[];
    private readonly lastSelections: WeakMap<vscode.TextEditor, readonly vscode.Selection[]> =
        new WeakMap<vscode.TextEditor, readonly vscode.Selection[]>();
    private readonly restoringEditors: WeakSet<vscode.TextEditor> = new WeakSet<vscode.TextEditor>();

    constructor() {
        for (const editor of vscode.window.visibleTextEditors) {
            this.rememberSelections(editor, editor.selections);
        }
        this.disposables = [
            vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
                if (editor) {
                    this.rememberSelections(editor, editor.selections);
                }
            }),
            vscode.window.onDidChangeTextEditorSelection((event: vscode.TextEditorSelectionChangeEvent) => {
                this.handleSelectionChange(event);
            }),
        ];
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private handleSelectionChange(event: vscode.TextEditorSelectionChangeEvent): void {
        const editor: vscode.TextEditor = event.textEditor;
        if (this.restoringEditors.has(editor)) {
            this.restoringEditors.delete(editor);
            this.rememberSelections(editor, event.selections);
            return;
        }
        if (event.kind !== vscode.TextEditorSelectionChangeKind.Command || event.selections.length !== 1) {
            this.rememberSelections(editor, event.selections);
            return;
        }

        const shortcut: string | undefined =
            decodeCodeLensBridgeSelection(editor.document, event.selections[0]);
        if (!shortcut) {
            this.rememberSelections(editor, event.selections);
            return;
        }

        const bridgeSelection: vscode.Selection = event.selections[0];
        let selectionsToRestore: readonly vscode.Selection[] | undefined = this.lastSelections.get(editor);
        if (!selectionsToRestore || this.areSelectionsEqual(selectionsToRestore, event.selections)) {
            const neutralPosition: vscode.Position = editor.document.lineAt(bridgeSelection.active.line).range.end;
            selectionsToRestore = [
                new vscode.Selection(neutralPosition, neutralPosition),
            ];
        }
        this.restoringEditors.add(editor);
        editor.selections = selectionsToRestore.map((selection: vscode.Selection) =>
            new vscode.Selection(selection.anchor, selection.active));

        void editorActionController.executeShortcut(shortcut, editor.document).catch((error: unknown) => {
            const message: string = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`LeetCode action failed: ${message}`);
        });
    }

    private rememberSelections(
        editor: vscode.TextEditor,
        selections: readonly vscode.Selection[],
    ): void {
        this.lastSelections.set(
            editor,
            selections.map((selection: vscode.Selection) =>
                new vscode.Selection(selection.anchor, selection.active)),
        );
    }

    private areSelectionsEqual(
        left: readonly vscode.Selection[],
        right: readonly vscode.Selection[],
    ): boolean {
        return left.length === right.length &&
            left.every((selection: vscode.Selection, index: number) =>
                selection.isEqual(right[index]));
    }
}
