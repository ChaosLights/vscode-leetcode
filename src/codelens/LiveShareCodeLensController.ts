// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { LiveShareSafeCodeLensProvider } from "./LiveShareSafeCodeLensProvider";
import { LocalCodeLensCommandBridge } from "./LocalCodeLensCommandBridge";

// A Live Share guest opens shared text documents with the vsls: scheme. Do not
// register locally for that scheme: Live Share 1.1.122 forwards the host's
// CodeLens results, so adding a guest provider would create a second set.
export const LOCAL_CODE_LENS_SELECTOR: vscode.DocumentSelector = [
    { scheme: "file" },
    { scheme: "untitled" },
    { scheme: "vscode-remote" },
];

export class LiveShareCodeLensController implements vscode.Disposable {
    private readonly provider: LiveShareSafeCodeLensProvider;
    private readonly disposables: vscode.Disposable[];

    constructor() {
        this.provider = new LiveShareSafeCodeLensProvider();
        this.disposables = [
            this.provider,
            new LocalCodeLensCommandBridge(),
            vscode.languages.registerCodeLensProvider(LOCAL_CODE_LENS_SELECTOR, this.provider),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
                if (event.affectsConfiguration("leetcode.editor.shortcuts")) {
                    this.provider.refresh();
                }
            }),
        ];
    }

    public refresh(): void {
        this.provider.refresh();
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
