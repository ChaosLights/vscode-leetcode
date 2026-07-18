// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const extensionId: string = "ms-vsliveshare.vsliveshare";
const apiVersion: string = "1.0.4753";

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

interface ILiveShareExtensionExports {
    getApi?: (requestedApiVersion: string, callingExtensionId?: string) => Promise<ILiveShareApi | null>;
    getApiAsync?: (requestedApiVersion: string) => Promise<ILiveShareApi | null>;
}

export async function getLiveShareApi(): Promise<ILiveShareApi | null> {
    const extension: vscode.Extension<ILiveShareExtensionExports> | undefined =
        vscode.extensions.getExtension<ILiveShareExtensionExports>(extensionId);
    if (!extension) {
        return null;
    }
    const exports: ILiveShareExtensionExports = extension.isActive ? extension.exports : await extension.activate();
    if (exports.getApi) {
        return await exports.getApi(apiVersion, "LeetCode.vscode-leetcode");
    }
    if (exports.getApiAsync) {
        return await exports.getApiAsync(apiVersion);
    }
    return null;
}
