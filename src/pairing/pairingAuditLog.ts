// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type PairingAuditFields = { [key: string]: string | number | boolean | null | undefined };

class PairingAuditLog implements vscode.Disposable {
    private logPath: string | undefined;

    public initialize(context: vscode.ExtensionContext): void {
        if (this.logPath) {
            return;
        }
        const root: string = process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, "LeetCodePairing", "logs")
            : path.join(context.globalStorageUri.fsPath, "logs");
        fs.mkdirSync(root, { recursive: true });
        const timestamp: string = new Date().toISOString().replace(/[:.]/g, "-");
        this.logPath = path.join(root, `${timestamp}-vscode-${process.pid}.jsonl`);
        this.event("extension_host.started", {
            extensionVersion: context.extension.packageJSON.version,
            vscodeVersion: vscode.version,
            remoteName: vscode.env.remoteName || "none",
            uiKind: vscode.env.uiKind,
            platform: process.platform,
            arch: process.arch,
        });
    }

    public event(name: string, fields: PairingAuditFields = {}): void {
        if (!this.logPath) {
            return;
        }
        const record: PairingAuditFields = {
            timestampUtc: new Date().toISOString(),
            event: name,
            pid: process.pid,
            ...fields,
        };
        try {
            fs.appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
        } catch (_error) {
            // Diagnostics must never interrupt pairing.
        }
    }

    public getPath(): string | undefined {
        return this.logPath;
    }

    public dispose(): void {
        this.event("extension_host.stopped");
    }
}

export const pairingAuditLog: PairingAuditLog = new PairingAuditLog();
