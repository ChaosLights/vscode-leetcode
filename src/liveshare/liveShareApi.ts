// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const liveShareExtensionId: string = "ms-vsliveshare.vsliveshare";
const liveShareApiVersion: string = "1.0.4753";

export enum LiveShareRole {
    None = 0,
    Host = 1,
    Guest = 2,
}

export enum LiveShareAccess {
    None = 0,
    ReadOnly = 1,
    ReadWrite = 3,
    Owner = 0xFF,
}

export interface ILiveSharePeer {
    readonly role: LiveShareRole;
    readonly access: LiveShareAccess;
}

export interface ILiveShareSession extends ILiveSharePeer {
    readonly id: string | null;
}

export interface ILiveShareSharedService {
    onRequest(name: string, handler: (args: any[]) => any | Promise<any>): void;
}

export interface ILiveShareSharedServiceProxy {
    readonly isServiceAvailable: boolean;
    request(name: string, args: any[]): Promise<any>;
}

export interface ILiveShareApi {
    readonly session: ILiveShareSession;
    readonly peers: ILiveSharePeer[];
    shareService(name: string): Promise<ILiveShareSharedService | null>;
    unshareService(name: string): Promise<void>;
    getSharedService(name: string): Promise<ILiveShareSharedServiceProxy | null>;
}

interface ILiveShareExtensionExports {
    getApi?(requestedApiVersion: string, callingExtensionId: string): Promise<ILiveShareApi | null>;
    getApiAsync?(requestedApiVersion: string): Promise<ILiveShareApi | null>;
}

export async function getLiveShareApi(callingExtensionId: string): Promise<ILiveShareApi | undefined> {
    const extension: vscode.Extension<ILiveShareExtensionExports> | undefined =
        vscode.extensions.getExtension<ILiveShareExtensionExports>(liveShareExtensionId);
    if (!extension) {
        return undefined;
    }

    const extensionApi: ILiveShareExtensionExports = extension.isActive
        ? extension.exports
        : await extension.activate();
    if (extensionApi.getApi) {
        return (await extensionApi.getApi(liveShareApiVersion, callingExtensionId)) || undefined;
    }
    if (extensionApi.getApiAsync) {
        return (await extensionApi.getApiAsync(liveShareApiVersion)) || undefined;
    }
    return undefined;
}
