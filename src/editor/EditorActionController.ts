// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { getNodeIdFromContent } from "../utils/problemUtils";
import { getEditorShortcuts } from "../utils/settingUtils";

interface IEditorAction extends vscode.QuickPickItem {
    command: string;
    args: any[];
}

class EditorActionController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[];

    constructor() {
        this.disposables = [
            vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
                if (vscode.window.activeTextEditor?.document === event.document) {
                    this.updateContext();
                }
            }),
        ];
        this.updateContext();
    }

    public async show(uri?: vscode.Uri): Promise<void> {
        const document: vscode.TextDocument | undefined = await this.resolveDocument(uri);
        if (!document || !this.isLeetCodeSolution(document)) {
            vscode.window.showWarningMessage("Open a generated LeetCode solution file first.");
            return;
        }

        const actions: IEditorAction[] = this.getActions(document);
        if (!actions.length) {
            vscode.window.showInformationMessage('No editor actions are enabled in "leetcode.editor.shortcuts".');
            return;
        }

        const choice: IEditorAction | undefined = await vscode.window.showQuickPick(actions, {
            placeHolder: "Run with your local LeetCode account",
        });
        if (choice) {
            await vscode.commands.executeCommand(choice.command, ...choice.args);
        }
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        void vscode.commands.executeCommand("setContext", "leetcode.activeSolution", false);
    }

    private getActions(document: vscode.TextDocument): IEditorAction[] {
        const shortcuts: string[] = getEditorShortcuts();
        const nodeId: string = getNodeIdFromContent(document.getText());
        const node: LeetCodeNode | undefined = explorerNodeManager.getNodeById(nodeId);
        const actions: Map<string, IEditorAction | undefined> = new Map<string, IEditorAction | undefined>([
            ["submit", {
                label: "$(cloud-upload) Submit",
                description: "Submit with your local account",
                command: "leetcode.submitSolution",
                args: [document.uri],
            }],
            ["test", {
                label: "$(beaker) Test",
                description: "Run LeetCode test cases with your local account",
                command: "leetcode.testSolution",
                args: [document.uri],
            }],
            ["solution", {
                label: "$(book) Solution",
                description: "Open the top-voted solution locally",
                command: "leetcode.showSolution",
                args: [document.uri],
            }],
            ["description", {
                label: "$(preview) Description",
                description: "Open the problem description locally",
                command: "leetcode.previewProblem",
                args: [document.uri],
            }],
            ["star", node ? {
                label: node.isFavorite ? "$(star-delete) Unstar" : "$(star-add) Star",
                command: node.isFavorite ? "leetcode.removeFavorite" : "leetcode.addFavorite",
                args: [node],
            } : undefined],
        ]);

        return shortcuts
            .map((shortcut: string) => actions.get(shortcut))
            .filter((action: IEditorAction | undefined): action is IEditorAction => Boolean(action));
    }

    private async resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
        if (uri) {
            return vscode.workspace.openTextDocument(uri);
        }
        return vscode.window.activeTextEditor?.document;
    }

    private isLeetCodeSolution(document: vscode.TextDocument): boolean {
        return Boolean(getNodeIdFromContent(document.getText()));
    }

    private updateContext(): void {
        const document: vscode.TextDocument | undefined = vscode.window.activeTextEditor?.document;
        const isActive: boolean = Boolean(document && this.isLeetCodeSolution(document));
        void vscode.commands.executeCommand("setContext", "leetcode.activeSolution", isActive);
    }
}

export const editorActionController: EditorActionController = new EditorActionController();
