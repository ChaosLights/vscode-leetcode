// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import * as cache from "./commands/cache";
import * as diagnose from "./commands/diagnose";
import { switchDefaultLanguage } from "./commands/language";
import * as plugin from "./commands/plugin";
import * as session from "./commands/session";
import * as show from "./commands/show";
import * as star from "./commands/star";
import * as submit from "./commands/submit";
import * as test from "./commands/test";
import { explorerNodeManager } from "./explorer/explorerNodeManager";
import { LeetCodeNode } from "./explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "./explorer/LeetCodeTreeDataProvider";
import { leetCodeTreeItemDecorationProvider } from "./explorer/LeetCodeTreeItemDecorationProvider";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { leetCodeManager } from "./leetCodeManager";
import { leetCodeStatusBarController } from "./statusbar/leetCodeStatusBarController";
import { DialogType, promptForOpenOutputChannel } from "./utils/uiUtils";
import { leetCodePreviewProvider } from "./webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "./webview/leetCodeSolutionProvider";
import { leetCodeSubmissionProvider } from "./webview/leetCodeSubmissionProvider";
import { markdownEngine } from "./webview/markdownEngine";
import { globalState } from "./globalState";
import { editorActionController } from "./editor/EditorActionController";
import { LiveShareCodeLensController } from "./codelens/LiveShareCodeLensController";
import { workspaceFileDeletionTracker } from "./utils/workspaceFileDeletionTracker";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (process.env.VSCODE_LEETCODE_TEST_MODE === "1") {
        return;
    }
    try {
        const workspaceSchemes: string[] = Array.from(new Set(
            (vscode.workspace.workspaceFolders || []).map((folder: vscode.WorkspaceFolder) => folder.uri.scheme),
        ));
        leetCodeChannel.appendLine(
            `[startup] version=${context.extension.packageJSON.version}, vscode=${vscode.version}, ` +
            `remote=${vscode.env.remoteName || "none"}, uiKind=${vscode.env.uiKind}, ` +
            `platform=${process.platform}, arch=${process.arch}, workspaceSchemes=${workspaceSchemes.join(",") || "none"}.`,
        );
        context.subscriptions.push(
            leetCodeChannel,
            leetCodeExecutor,
            vscode.commands.registerCommand("leetcode.diagnosePairing", () => diagnose.diagnosePairing(context)),
        );
        await globalState.initialize(context);
        await leetCodeExecutor.initialize(context);
        if (!(await leetCodeExecutor.meetRequirements())) {
            throw new Error("The environment doesn't meet requirements.");
        }

        leetCodeManager.on("statusChanged", () => {
            leetCodeStatusBarController.updateStatusBar(leetCodeManager.getStatus(), leetCodeManager.getUser());
            leetCodeTreeDataProvider.refresh();
        });

        leetCodeTreeDataProvider.initialize(context);
        let codeLensController: LiveShareCodeLensController | undefined;

        // Register every clickable command before exposing CodeLens or inlay
        // actions. A restored Remote/Live Share editor can request and click an
        // inlay action immediately during activation; publishing the provider
        // first leaves a short window where VS Code reports the command missing.
        context.subscriptions.push(
            leetCodeStatusBarController,
            leetCodePreviewProvider,
            leetCodeSubmissionProvider,
            leetCodeSolutionProvider,
            markdownEngine,
            editorActionController,
            workspaceFileDeletionTracker.start(),
            explorerNodeManager,
            vscode.window.registerFileDecorationProvider(leetCodeTreeItemDecorationProvider),
            vscode.window.createTreeView("leetCodeExplorer", { treeDataProvider: leetCodeTreeDataProvider, showCollapseAll: true }),
            vscode.commands.registerCommand("leetcode.deleteCache", () => cache.deleteCache()),
            vscode.commands.registerCommand("leetcode.toggleLeetCodeCn", () => plugin.switchEndpoint()),
            vscode.commands.registerCommand("leetcode.signin", () => leetCodeManager.signIn()),
            vscode.commands.registerCommand("leetcode.signout", () => leetCodeManager.signOut()),
            vscode.commands.registerCommand("leetcode.manageSessions", () => session.manageSessions()),
            vscode.commands.registerCommand("leetcode.previewProblem", (node: LeetCodeNode | vscode.Uri) => show.previewProblem(node)),
            vscode.commands.registerCommand("leetcode.showProblem", (node: LeetCodeNode) => show.showProblem(node)),
            vscode.commands.registerCommand("leetcode.pickOne", () => show.pickOne()),
            vscode.commands.registerCommand("leetcode.searchProblem", () => show.searchProblem()),
            vscode.commands.registerCommand("leetcode.showSolution", (input: LeetCodeNode | vscode.Uri) => show.showSolution(input)),
            vscode.commands.registerCommand("leetcode.refreshExplorer", () => leetCodeTreeDataProvider.refresh()),
            vscode.commands.registerCommand("leetcode.testSolution", (uri?: vscode.Uri) => test.testSolution(uri)),
            vscode.commands.registerCommand("leetcode.submitSolution", (uri?: vscode.Uri) => submit.submitSolution(uri)),
            vscode.commands.registerCommand("leetcode.switchDefaultLanguage", () => switchDefaultLanguage()),
            vscode.commands.registerCommand("leetcode.addFavorite", async (node: LeetCodeNode) => {
                await star.addFavorite(node);
                codeLensController?.refresh();
            }),
            vscode.commands.registerCommand("leetcode.removeFavorite", async (node: LeetCodeNode) => {
                await star.removeFavorite(node);
                codeLensController?.refresh();
            }),
            vscode.commands.registerCommand("leetcode.problems.sort", () => plugin.switchSortingStrategy()),
            vscode.commands.registerCommand("leetcode.showEditorActions", (uri?: vscode.Uri) => editorActionController.show(uri))
        );

        codeLensController = new LiveShareCodeLensController();
        context.subscriptions.push(
            codeLensController,
            leetCodeTreeDataProvider.onDidChangeTreeData(() => codeLensController?.refresh()),
        );

        await leetCodeExecutor.switchEndpoint(plugin.getLeetCodeEndpoint());
        context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: leetCodeManager.handleUriSignIn }));
        await leetCodeManager.getLoginStatus();
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        promptForOpenOutputChannel("Extension initialization failed. Please open output channel for details.", DialogType.error);
    }
}

export function deactivate(): void {
    // Do nothing.
}
