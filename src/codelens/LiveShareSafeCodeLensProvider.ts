// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { getNodeIdFromContent } from "../utils/problemUtils";
import { editorActionController, IEditorAction } from "../editor/EditorActionController";

export const CODE_LENS_BRIDGE_COMMAND: string = "editor.action.showReferences";

const HEADER_SCAN_LIMIT: number = 64;
const CODE_START_PATTERN: RegExp = /^\s*(?:\/\/|#|--|\/\*|\*)\s*@lc code=start(?:\s*\*\/)?\s*$/;
const CODE_END_MARKER: string = "@lc code=end";
const FOOTER_PATTERN: RegExp = /^\s*(?:\/\/|#|--|\/\*|\*)\s*@lc code=end(?:\s*\*\/)?\s*$/;
const ACTION_OFFSETS: ReadonlyMap<string, number> = new Map<string, number>([
    ["submit", 0],
    ["test", 1],
    ["star", 2],
    ["solution", 3],
    ["description", 4],
]);

export interface ICodeLensDocumentMetadata {
    footerLine: number;
    markerStart: number;
    nodeId: string;
}

interface ICachedCodeLensDocumentMetadata {
    metadata: ICodeLensDocumentMetadata | undefined;
    version: number;
}

export function findCodeLensDocumentMetadata(
    document: vscode.TextDocument,
): ICodeLensDocumentMetadata | undefined {
    let nodeId: string = "";
    const headerLineLimit: number = Math.min(document.lineCount, HEADER_SCAN_LIMIT);
    for (let lineNumber: number = 0; lineNumber < headerLineLimit; lineNumber++) {
        nodeId = getNodeIdFromContent(document.lineAt(lineNumber).text);
        if (nodeId) {
            break;
        }
    }
    if (!nodeId) {
        return undefined;
    }

    let firstCodeStartLine: number = -1;
    for (let lineNumber: number = 0; lineNumber < document.lineCount; lineNumber++) {
        if (CODE_START_PATTERN.test(document.lineAt(lineNumber).text)) {
            firstCodeStartLine = lineNumber;
            break;
        }
    }

    // The generated file has one authoritative code block. Search forward from
    // its first start marker so a pasted copy below it cannot steal the actions.
    // Older hand-written files without a start marker keep the forward fallback.
    const firstFooterLine: number = firstCodeStartLine >= 0 ? firstCodeStartLine + 1 : 0;
    for (let lineNumber: number = firstFooterLine; lineNumber < document.lineCount; lineNumber++) {
        const lineText: string = document.lineAt(lineNumber).text;
        if (!FOOTER_PATTERN.test(lineText)) {
            continue;
        }
        const markerStart: number = lineText.indexOf(CODE_END_MARKER);
        if (markerStart >= 0) {
            return { footerLine: lineNumber, markerStart, nodeId };
        }
    }
    return undefined;
}

export function decodeCodeLensBridgeSelection(
    document: vscode.TextDocument,
    selection: vscode.Selection,
): string | undefined {
    if (!selection.isEmpty) {
        return undefined;
    }
    const metadata: ICodeLensDocumentMetadata | undefined = findCodeLensDocumentMetadata(document);
    if (!metadata || selection.active.line !== metadata.footerLine) {
        return undefined;
    }
    const offset: number = selection.active.character - metadata.markerStart;
    for (const [shortcut, actionOffset] of ACTION_OFFSETS) {
        if (offset === actionOffset) {
            return shortcut;
        }
    }
    return undefined;
}

export class LiveShareSafeCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    private readonly metadataCache: WeakMap<vscode.TextDocument, ICachedCodeLensDocumentMetadata> =
        new WeakMap<vscode.TextDocument, ICachedCodeLensDocumentMetadata>();

    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.changeEmitter.event;

    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): vscode.CodeLens[] {
        if (token.isCancellationRequested) {
            return [];
        }
        const metadata: ICodeLensDocumentMetadata | undefined = this.getDocumentMetadata(document);
        if (!metadata) {
            return [];
        }
        const range: vscode.Range = new vscode.Range(metadata.footerLine, 0, metadata.footerLine, 0);
        return editorActionController.getActions(document, metadata.nodeId)
            .map((action: IEditorAction) => this.createCodeLens(document.uri, range, metadata, action))
            .filter((codeLens: vscode.CodeLens | undefined): codeLens is vscode.CodeLens => Boolean(codeLens));
    }

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public dispose(): void {
        this.changeEmitter.dispose();
    }

    private createCodeLens(
        documentUri: vscode.Uri,
        range: vscode.Range,
        metadata: ICodeLensDocumentMetadata,
        action: IEditorAction,
    ): vscode.CodeLens | undefined {
        const actionOffset: number | undefined = ACTION_OFFSETS.get(action.shortcut);
        if (actionOffset === undefined) {
            return undefined;
        }
        const bridgePosition: vscode.Position = new vscode.Position(
            metadata.footerLine,
            metadata.markerStart + actionOffset,
        );
        return new vscode.CodeLens(range, {
            title: action.codeLensTitle,
            command: CODE_LENS_BRIDGE_COMMAND,
            tooltip: `${action.description || action.codeLensTitle}. Runs with this window's local account.`,
            // Live Share 1.1.122 explicitly executes showReferences in the guest
            // extension host and converts all three arguments. An empty location
            // list only moves the local caret; the bridge immediately restores it.
            arguments: [documentUri, bridgePosition, []],
        });
    }

    private getDocumentMetadata(document: vscode.TextDocument): ICodeLensDocumentMetadata | undefined {
        const cached: ICachedCodeLensDocumentMetadata | undefined = this.metadataCache.get(document);
        if (cached?.version === document.version) {
            return cached.metadata;
        }
        const metadata: ICodeLensDocumentMetadata | undefined = findCodeLensDocumentMetadata(document);
        this.metadataCache.set(document, { metadata, version: document.version });
        return metadata;
    }
}
