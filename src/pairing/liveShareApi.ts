// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import * as vsls from "vsls/vscode";

export enum LiveShareRole {
    None = 0,
    Host = 1,
    Guest = 2,
}

export enum LiveShareAccess {
    ReadWrite = 3,
}

export interface ILiveShareSession {
    readonly role: LiveShareRole;
}

export interface ILiveShareSessionChangeEvent {
    readonly session: ILiveShareSession;
}

export interface ILiveShareApi {
    readonly session: ILiveShareSession;
    readonly onDidChangeSession: vscode.Event<ILiveShareSessionChangeEvent>;
    share(options?: { suppressNotification?: boolean; access?: LiveShareAccess }): Promise<vscode.Uri | null>;
    join(link: vscode.Uri, options?: { newWindow?: boolean }): Promise<void>;
}

export async function getLiveShareApi(): Promise<ILiveShareApi | null> {
    // Live Share discovers the calling extension from the official adapter's
    // node_modules path. Calling its exported getApi() method directly from a
    // deeply nested compiled file makes 1.1.122 look for package.json in the
    // wrong directory and return null after activation.
    return await vsls.getApi() as ILiveShareApi | null;
}
