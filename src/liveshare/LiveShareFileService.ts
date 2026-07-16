// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { getSafeRelativePathSegments } from "../utils/workspaceUtils";
import {
    getLiveShareApi,
    ILiveShareApi,
    ILiveSharePeer,
    ILiveShareSharedService,
    ILiveShareSharedServiceProxy,
    LiveShareAccess,
    LiveShareRole,
} from "./liveShareApi";

const serviceName: string = "problem-files-v1";
const createRequestName: string = "createProblemFile";

interface ICreateProblemRequest {
    protocol: 1;
    workspaceFolderIndex: number;
    workspaceFolderName: string;
    relativePath: string;
    content: string;
}

interface ICreateProblemResponse {
    created: boolean;
    relativePath: string;
}

class LiveShareFileService implements vscode.Disposable {
    private api: ILiveShareApi | undefined;
    private initialization: Promise<void> | undefined;

    public initialize(): Promise<void> {
        if (!this.initialization) {
            this.initialization = this.initializeInternal();
        }
        return this.initialization;
    }

    public async createProblemFile(
        workspaceFolder: vscode.WorkspaceFolder,
        relativePath: string,
        content: string,
    ): Promise<ICreateProblemResponse> {
        await this.initialize();
        if (!this.api || this.api.session.role !== LiveShareRole.Guest) {
            throw new Error("The Live Share guest API is unavailable. Install Live Share locally and reconnect to the session.");
        }

        const proxy: ILiveShareSharedServiceProxy | null = await this.api.getSharedService(serviceName);
        if (!proxy || !proxy.isServiceAvailable) {
            throw new Error(
                "The host is not providing the LeetCode file service. Both participants must install the same custom VSIX, then restart the Live Share session.",
            );
        }

        const request: ICreateProblemRequest = {
            protocol: 1,
            workspaceFolderIndex: workspaceFolder.index,
            workspaceFolderName: workspaceFolder.name,
            relativePath,
            content,
        };
        const response: ICreateProblemResponse = await proxy.request(createRequestName, [request]);
        if (!response || response.relativePath !== relativePath || typeof response.created !== "boolean") {
            throw new Error("The Live Share host returned an invalid LeetCode file response.");
        }
        return response;
    }

    public dispose(): void {
        if (this.api) {
            void this.api.unshareService(serviceName).catch(() => undefined);
        }
    }

    private async initializeInternal(): Promise<void> {
        const api: ILiveShareApi | undefined = await getLiveShareApi("LeetCode.vscode-leetcode");
        if (!api) {
            return;
        }
        this.api = api;
        const service: ILiveShareSharedService | null = await api.shareService(serviceName);
        if (service) {
            service.onRequest(createRequestName, (args: any[]) => this.handleCreateRequest(args));
        }
    }

    private async handleCreateRequest(args: any[]): Promise<ICreateProblemResponse> {
        if (!this.api || this.api.session.role !== LiveShareRole.Host) {
            throw new Error("LeetCode file requests are accepted only by the Live Share host.");
        }

        const request: ICreateProblemRequest = args && args[0];
        this.validateRequest(request);
        const workspaceFolder: vscode.WorkspaceFolder = this.resolveHostWorkspaceFolder(request);
        const pathSegments: string[] = getSafeRelativePathSegments(request.relativePath);
        const finalUri: vscode.Uri = vscode.Uri.joinPath(workspaceFolder.uri, ...pathSegments);

        const hasWritableGuest: boolean = this.api.peers.some(
            (peer: ILiveSharePeer) => peer.role === LiveShareRole.Guest && peer.access >= LiveShareAccess.ReadWrite,
        );
        if (!hasWritableGuest) {
            throw new Error("The Live Share session does not currently have a read/write guest.");
        }

        const parentSegments: string[] = pathSegments.slice(0, -1);
        if (parentSegments.length) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, ...parentSegments));
        }
        await vscode.workspace.fs.writeFile(finalUri, Buffer.from(request.content, "utf8"));
        return { created: true, relativePath: request.relativePath };
    }

    private validateRequest(request: ICreateProblemRequest): void {
        if (
            !request ||
            request.protocol !== 1 ||
            !Number.isInteger(request.workspaceFolderIndex) ||
            typeof request.workspaceFolderName !== "string" ||
            typeof request.relativePath !== "string" ||
            typeof request.content !== "string"
        ) {
            throw new Error("Invalid Live Share LeetCode file request.");
        }
        if (request.relativePath.length > 1024) {
            throw new Error("The requested LeetCode file path is too long.");
        }
        getSafeRelativePathSegments(request.relativePath);
    }

    private resolveHostWorkspaceFolder(request: ICreateProblemRequest): vscode.WorkspaceFolder {
        const folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders || [];
        const indexedFolder: vscode.WorkspaceFolder | undefined = folders[request.workspaceFolderIndex];
        if (indexedFolder && indexedFolder.name === request.workspaceFolderName) {
            return indexedFolder;
        }

        const namedFolders: vscode.WorkspaceFolder[] = folders.filter(
            (folder: vscode.WorkspaceFolder) => folder.name === request.workspaceFolderName,
        );
        if (namedFolders.length !== 1) {
            throw new Error(`The host cannot resolve shared workspace folder: ${request.workspaceFolderName}`);
        }
        return namedFolders[0];
    }
}

export const liveShareFileService: LiveShareFileService = new LiveShareFileService();
