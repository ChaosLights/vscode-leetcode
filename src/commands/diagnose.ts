// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import {
    findCodeLensDocumentMetadata,
    ICodeLensDocumentMetadata,
} from "../codelens/LiveShareSafeCodeLensProvider";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";

const liveShareExtensionId: string = "ms-vsliveshare.vsliveshare";
const codeLensDiagnosticTimeoutMs: number = 5000;
const leetCodeCodeLensTitles: ReadonlySet<string> = new Set<string>([
    "Submit",
    "Test",
    "Toggle Star",
    "Solution",
    "Description",
]);

function formatConfigurationValue(value: unknown): string {
    return value === undefined || value === null ? "unset" : value.toString();
}

async function getCodeLensProviderDescription(
    document: vscode.TextDocument,
    metadata: ICodeLensDocumentMetadata,
): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        const codeLenses: vscode.CodeLens[] | undefined = await Promise.race([
            vscode.commands.executeCommand<vscode.CodeLens[]>(
                "vscode.executeCodeLensProvider",
                document.uri,
                Number.MAX_VALUE,
            ),
            new Promise<undefined>((resolve: (value: undefined) => void) => {
                timeout = setTimeout(() => resolve(undefined), codeLensDiagnosticTimeoutMs);
            }),
        ]);
        if (!codeLenses) {
            return `provider=timeout-after-${codeLensDiagnosticTimeoutMs}ms`;
        }
        const leetCodeActions: string[] = codeLenses
            .filter((codeLens: vscode.CodeLens): boolean =>
                codeLens.range.start.line === metadata.footerLine &&
                Boolean(codeLens.command && leetCodeCodeLensTitles.has(codeLens.command.title)))
            .map((codeLens: vscode.CodeLens): string => codeLens.command?.title || "");
        return `providerTotal=${codeLenses.length}, leetCodeActions=` +
            `${leetCodeActions.join("|") || "none"}`;
    } catch (error) {
        return `provider=error:${error instanceof Error ? error.name : "unknown"}`;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function getInlayHintProviderDescription(
    document: vscode.TextDocument,
): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        const lastLine: vscode.TextLine = document.lineAt(document.lineCount - 1);
        const inlayHints: vscode.InlayHint[] | undefined = await Promise.race([
            vscode.commands.executeCommand<vscode.InlayHint[]>(
                "vscode.executeInlayHintProvider",
                document.uri,
                new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character),
            ),
            new Promise<undefined>((resolve: (value: undefined) => void) => {
                timeout = setTimeout(() => resolve(undefined), codeLensDiagnosticTimeoutMs);
            }),
        ]);
        if (!inlayHints) {
            return `inlineProvider=timeout-after-${codeLensDiagnosticTimeoutMs}ms`;
        }
        const actions: string[] = [];
        for (const hint of inlayHints) {
            if (!Array.isArray(hint.label)) {
                continue;
            }
            for (const part of hint.label) {
                if (part.command && leetCodeCodeLensTitles.has(part.command.title)) {
                    actions.push(part.command.title);
                }
            }
        }
        return `inlineProviderTotal=${inlayHints.length}, inlineActions=${actions.join("|") || "none"}`;
    } catch (error) {
        return `inlineProvider=error:${error instanceof Error ? error.name : "unknown"}`;
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

export async function diagnosePairing(context: vscode.ExtensionContext): Promise<void> {
    const extensionKind: string = context.extension.extensionKind === vscode.ExtensionKind.UI ? "ui" : "workspace";
    const liveShareExtension: vscode.Extension<any> | undefined =
        vscode.extensions.getExtension(liveShareExtensionId);
    const workspaceFileSystems: string[] = (vscode.workspace.workspaceFolders || []).map(
        (folder: vscode.WorkspaceFolder): string => {
            const writable: boolean | undefined = vscode.workspace.fs.isWritableFileSystem(folder.uri.scheme);
            return `${folder.uri.scheme}:${writable === undefined ? "unknown" : writable ? "writable" : "read-only"}`;
        },
    );
    const activeDocument: vscode.TextDocument | undefined =
        vscode.window.activeTextEditor?.document || vscode.window.visibleTextEditors[0]?.document;
    const configurationScope: vscode.ConfigurationScope | undefined = activeDocument ? {
        uri: activeDocument.uri,
        languageId: activeDocument.languageId,
    } : undefined;
    const editorConfiguration: vscode.WorkspaceConfiguration =
        vscode.workspace.getConfiguration("editor", configurationScope);
    const codeLensEnabled: boolean = editorConfiguration.get<boolean>("codeLens", true);
    const codeLensInspection = editorConfiguration.inspect<boolean>("codeLens");
    const inlayConfiguration: vscode.WorkspaceConfiguration =
        vscode.workspace.getConfiguration("editor.inlayHints", configurationScope);
    const inlayHintsEnabled: string = inlayConfiguration.get<string>("enabled", "on");
    const inlayHintsInspection = inlayConfiguration.inspect<string>("enabled");
    const liveShareLanguageConfiguration: vscode.WorkspaceConfiguration =
        vscode.workspace.getConfiguration("liveshare.languages", configurationScope);
    const allowGuestCommandControl: boolean =
        liveShareLanguageConfiguration.get<boolean>("allowGuestCommandControl", false);
    const allowGuestCommandInspection =
        liveShareLanguageConfiguration.inspect<boolean>("allowGuestCommandControl");
    const metadata: ICodeLensDocumentMetadata | undefined =
        activeDocument ? findCodeLensDocumentMetadata(activeDocument) : undefined;

    leetCodeChannel.appendLine("[diagnostics] ---- LeetCode pairing diagnostics ----");
    leetCodeChannel.appendLine(
        `[diagnostics] extension=${context.extension.packageJSON.version}, kind=${extensionKind}, ` +
        `vscode=${vscode.version}, uiKind=${vscode.env.uiKind}, remote=${vscode.env.remoteName || "none"}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] platform=${process.platform}, arch=${process.arch}, trusted=${vscode.workspace.isTrusted}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] workspaces=${workspaceFileSystems.join(",") || "none"}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] liveShare=${liveShareExtension?.packageJSON.version || "not-installed"}, ` +
        `active=${liveShareExtension?.isActive || false}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] activeDocument=${activeDocument?.uri.scheme || "none"}, ` +
        `language=${activeDocument?.languageId || "none"}, recognized=${Boolean(metadata)}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] codeLens=${codeLensEnabled}, ` +
        `default=${formatConfigurationValue(codeLensInspection?.defaultValue)}, ` +
        `global=${formatConfigurationValue(codeLensInspection?.globalValue)}, ` +
        `workspace=${formatConfigurationValue(codeLensInspection?.workspaceValue)}, ` +
        `workspaceFolder=${formatConfigurationValue(codeLensInspection?.workspaceFolderValue)}, ` +
        `defaultLanguage=${formatConfigurationValue(codeLensInspection?.defaultLanguageValue)}, ` +
        `globalLanguage=${formatConfigurationValue(codeLensInspection?.globalLanguageValue)}, ` +
        `workspaceLanguage=${formatConfigurationValue(codeLensInspection?.workspaceLanguageValue)}, ` +
        `workspaceFolderLanguage=${formatConfigurationValue(codeLensInspection?.workspaceFolderLanguageValue)}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] inlayHints=${inlayHintsEnabled}, ` +
        `global=${formatConfigurationValue(inlayHintsInspection?.globalValue)}, ` +
        `workspace=${formatConfigurationValue(inlayHintsInspection?.workspaceValue)}, ` +
        `workspaceFolder=${formatConfigurationValue(inlayHintsInspection?.workspaceFolderValue)}.`,
    );
    leetCodeChannel.appendLine(
        `[diagnostics] allowGuestCommandControl=${allowGuestCommandControl}, ` +
        `global=${formatConfigurationValue(allowGuestCommandInspection?.globalValue)}, ` +
        `workspace=${formatConfigurationValue(allowGuestCommandInspection?.workspaceValue)}.`,
    );
    if (activeDocument && metadata) {
        leetCodeChannel.appendLine(
            `[diagnostics] ${await getCodeLensProviderDescription(activeDocument, metadata)}.`,
        );
        leetCodeChannel.appendLine(
            `[diagnostics] ${await getInlayHintProviderDescription(activeDocument)}.`,
        );
    }
    try {
        leetCodeChannel.appendLine(`[diagnostics] ${await leetCodeExecutor.getRuntimeDescription()}.`);
    } catch (error) {
        leetCodeChannel.appendLine("[diagnostics] node=unavailable; check leetcode.nodePath and Node.js 20+.");
    }
    leetCodeChannel.appendLine("[diagnostics] No account name, credential, token, or workspace path was collected.");
    leetCodeChannel.show();
}
