// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { getNodeIdFromContent } from "../utils/problemUtils";
import { getEditorShortcuts } from "../utils/settingUtils";

export interface IEditorAction extends vscode.QuickPickItem {
    shortcut: string;
    codeLensTitle: string;
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

    public getActions(document: vscode.TextDocument, knownNodeId?: string): IEditorAction[] {
        const shortcuts: string[] = getEditorShortcuts();
        const nodeId: string = knownNodeId || getNodeIdFromContent(document.getText());
        if (!nodeId) {
            return [];
        }
        const actions: Map<string, IEditorAction | undefined> = this.createActionMap(document, nodeId);

        return shortcuts
            .map((shortcut: string) => actions.get(shortcut))
            .filter((action: IEditorAction | undefined): action is IEditorAction => Boolean(action));
    }

    public async executeShortcut(shortcut: string, document: vscode.TextDocument): Promise<boolean> {
        const nodeId: string = getNodeIdFromContent(document.getText());
        if (!nodeId) {
            return false;
        }
        const action: IEditorAction | undefined = this.createActionMap(document, nodeId).get(shortcut);
        if (!action) {
            if (shortcut === "star") {
                vscode.window.showWarningMessage(
                    "LeetCode problem data is still loading. Refresh the Explorer and try again.",
                );
            }
            return false;
        }
        await vscode.commands.executeCommand(action.command, ...action.args);
        return true;
    }

    private createActionMap(
        document: vscode.TextDocument,
        nodeId: string,
    ): Map<string, IEditorAction | undefined> {
        const node: LeetCodeNode | undefined = explorerNodeManager.getNodeById(nodeId);
        return new Map<string, IEditorAction | undefined>([
            ["submit", {
                shortcut: "submit",
                label: "$(cloud-upload) Submit",
                codeLensTitle: "Submit",
                description: "Submit with your local account",
                command: "leetcode.submitSolution",
                args: [document.uri],
            }],
            ["test", {
                shortcut: "test",
                label: "$(beaker) Test",
                codeLensTitle: "Test",
                description: "Run LeetCode test cases with your local account",
                command: "leetcode.testSolution",
                args: [document.uri],
            }],
            ["solution", {
                shortcut: "solution",
                label: "$(book) Solution",
                codeLensTitle: "Solution",
                description: "Open the top-voted solution locally",
                command: "leetcode.showSolution",
                args: [document.uri],
            }],
            ["description", {
                shortcut: "description",
                label: "$(preview) Description",
                codeLensTitle: "Description",
                description: "Open the problem description locally",
                command: "leetcode.previewProblem",
                args: [document.uri],
            }],
            ["star", node ? {
                shortcut: "star",
                label: node.isFavorite ? "$(star-delete) Unstar" : "$(star-add) Star",
                codeLensTitle: "Toggle Star",
                command: node.isFavorite ? "leetcode.removeFavorite" : "leetcode.addFavorite",
                args: [node],
            } : undefined],
        ]);
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
