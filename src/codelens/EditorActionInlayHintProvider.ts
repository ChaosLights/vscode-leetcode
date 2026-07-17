// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { editorActionController, IEditorAction } from "../editor/EditorActionController";
import {
    findCodeLensDocumentMetadata,
    ICodeLensDocumentMetadata,
} from "./LiveShareSafeCodeLensProvider";

export class EditorActionInlayHintProvider implements vscode.InlayHintsProvider, vscode.Disposable {
    private readonly changeEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();

    public readonly onDidChangeInlayHints: vscode.Event<void> = this.changeEmitter.event;

    public provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken,
    ): vscode.InlayHint[] {
        if (token.isCancellationRequested) {
            return [];
        }
        const metadata: ICodeLensDocumentMetadata | undefined =
            findCodeLensDocumentMetadata(document);
        if (!metadata) {
            return [];
        }
        const footerLine: vscode.TextLine = document.lineAt(metadata.footerLine);
        const lineAfterFooter: vscode.TextLine | undefined =
            metadata.footerLine + 1 < document.lineCount
                ? document.lineAt(metadata.footerLine + 1)
                : undefined;
        // Generated solutions end with an empty line after @lc code=end. Put the
        // local action strip there so it keeps the compact, separate-line layout
        // of CodeLens without forwarding commands through Live Share. Older
        // files without that trailing line safely fall back to the footer end.
        const position: vscode.Position = lineAfterFooter?.isEmptyOrWhitespace
            ? lineAfterFooter.range.end
            : footerLine.range.end;
        if (!range.contains(position)) {
            return [];
        }
        const actions: IEditorAction[] =
            editorActionController.getActions(document, metadata.nodeId);
        if (!actions.length) {
            return [];
        }

        const parts: vscode.InlayHintLabelPart[] = [];
        actions.forEach((action: IEditorAction, index: number) => {
            if (index > 0) {
                parts.push(new vscode.InlayHintLabelPart(" · "));
            }
            const part: vscode.InlayHintLabelPart =
                new vscode.InlayHintLabelPart(action.codeLensTitle);
            part.tooltip = `${action.description || action.codeLensTitle}. Runs with this window's local account.`;
            part.command = {
                title: action.codeLensTitle,
                command: action.command,
                arguments: action.args,
            };
            parts.push(part);
        });

        const hint: vscode.InlayHint = new vscode.InlayHint(
            position,
            parts,
            vscode.InlayHintKind.Type,
        );
        hint.paddingLeft = false;
        return [hint];
    }

    public refresh(): void {
        this.changeEmitter.fire();
    }

    public dispose(): void {
        this.changeEmitter.dispose();
    }
}
