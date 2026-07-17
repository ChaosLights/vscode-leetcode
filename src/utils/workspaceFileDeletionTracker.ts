// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const deletionTombstoneTtlMs: number = 5 * 60 * 1000;
const expectedCreationTtlMs: number = 60 * 1000;
const deleteEventDeduplicationTtlMs: number = 35 * 1000;
const watcherEventDeduplicationTtlMs: number = 2 * 1000;
const maxDeletionTombstones: number = 256;
const internalStagingFilePattern: RegExp = /^\.vscode-leetcode-recreate-[a-f0-9]+\.tmp$/;

export type WorkspaceFileDeletionRevision = number;

interface IDeletionTombstone {
    readonly uri: vscode.Uri;
    readonly revision: WorkspaceFileDeletionRevision;
    readonly deletedAt: number;
}

interface IRecreatedPath {
    readonly deletionRevision: WorkspaceFileDeletionRevision;
    readonly createdAt: number;
}

interface IExpectedCreation {
    readonly deletionRevision: WorkspaceFileDeletionRevision | undefined;
    readonly expiresAt: number;
}

interface IDeleteIntent {
    readonly uri: vscode.Uri;
    readonly revision: WorkspaceFileDeletionRevision;
    readonly observedAt: number;
}

interface IWatcherDeletion {
    readonly revision: WorkspaceFileDeletionRevision;
    readonly observedAt: number;
}

export class WorkspaceFileDeletionTracker implements vscode.Disposable {
    private readonly recentDeletions: Map<string, IDeletionTombstone> =
        new Map<string, IDeletionTombstone>();
    private readonly recreatedPaths: Map<string, IRecreatedPath> = new Map<string, IRecreatedPath>();
    private readonly expectedCreations: Map<string, IExpectedCreation> =
        new Map<string, IExpectedCreation>();
    private readonly recentDeleteIntents: Map<string, IDeleteIntent> =
        new Map<string, IDeleteIntent>();
    private readonly recentWatcherDeletions: Map<string, IWatcherDeletion> =
        new Map<string, IWatcherDeletion>();
    private disposables: vscode.Disposable[] = [];
    private watcherDisposables: vscode.Disposable[] = [];
    private nextRevision: WorkspaceFileDeletionRevision = 1;

    public start(): vscode.Disposable {
        if (this.disposables.length) {
            return new vscode.Disposable(() => undefined);
        }

        this.disposables = [
            vscode.workspace.onDidDeleteFiles((event: vscode.FileDeleteEvent) => {
                for (const uri of event.files) {
                    this.recordDeletion(uri);
                }
            }),
            vscode.workspace.onDidCreateFiles((event: vscode.FileCreateEvent) => {
                for (const uri of event.files) {
                    this.recordCreation(uri);
                }
            }),
            vscode.workspace.onDidRenameFiles((event: vscode.FileRenameEvent) => {
                for (const file of event.files) {
                    this.recordDeletion(file.oldUri);
                    this.recordCreation(file.newUri);
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshWatchers()),
        ];
        this.refreshWatchers();
        return new vscode.Disposable(() => this.dispose());
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        for (const disposable of this.watcherDisposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.watcherDisposables = [];
        this.recentDeletions.clear();
        this.recreatedPaths.clear();
        this.expectedCreations.clear();
        this.recentDeleteIntents.clear();
        this.recentWatcherDeletions.clear();
    }

    public recordDeletion(uri: vscode.Uri): WorkspaceFileDeletionRevision | undefined {
        if (uri.scheme !== "vsls" || this.isInternalStagingUri(uri)) {
            return undefined;
        }
        this.prune();
        const normalizedUri: vscode.Uri = this.normalizeUri(uri);
        const revision: WorkspaceFileDeletionRevision =
            this.createDeletionTombstone(normalizedUri);
        const key: string = this.getKey(normalizedUri);
        this.recentDeleteIntents.delete(key);
        this.recentDeleteIntents.set(key, {
            uri: normalizedUri,
            revision,
            observedAt: Date.now(),
        });
        while (this.recentDeleteIntents.size > maxDeletionTombstones) {
            this.deleteOldest(this.recentDeleteIntents);
        }
        return revision;
    }

    public recordCreation(
        uri: vscode.Uri,
        expectedRevision?: WorkspaceFileDeletionRevision,
    ): boolean {
        if (uri.scheme !== "vsls" || this.isInternalStagingUri(uri)) {
            return false;
        }
        const currentRevision: WorkspaceFileDeletionRevision | undefined =
            this.getDeletionRevision(uri);
        if (
            currentRevision === undefined ||
            (expectedRevision !== undefined && currentRevision !== expectedRevision)
        ) {
            return false;
        }
        const key: string = this.getKey(uri);
        this.recreatedPaths.delete(key);
        this.recreatedPaths.set(key, {
            deletionRevision: currentRevision,
            createdAt: Date.now(),
        });
        while (this.recreatedPaths.size > maxDeletionTombstones) {
            this.deleteOldest(this.recreatedPaths);
        }
        return true;
    }

    public recordObservedDeletion(uri: vscode.Uri): WorkspaceFileDeletionRevision | undefined {
        if (uri.scheme !== "vsls" || this.isInternalStagingUri(uri)) {
            return undefined;
        }
        this.prune();
        const normalizedUri: vscode.Uri = this.normalizeUri(uri);
        const currentRevision: WorkspaceFileDeletionRevision | undefined =
            this.getDeletionRevision(normalizedUri);
        let matchingIntent: IDeleteIntent | undefined;
        for (const intent of this.recentDeleteIntents.values()) {
            if (
                this.covers(intent.uri, normalizedUri) &&
                Date.now() - intent.observedAt <= deleteEventDeduplicationTtlMs &&
                (!matchingIntent || intent.revision > matchingIntent.revision)
            ) {
                matchingIntent = intent;
            }
        }
        if (matchingIntent && currentRevision === matchingIntent.revision) {
            return matchingIntent.revision;
        }
        const key: string = this.getKey(normalizedUri);
        const recentWatcherDeletion: IWatcherDeletion | undefined =
            this.recentWatcherDeletions.get(key);
        const now: number = Date.now();
        if (
            recentWatcherDeletion &&
            currentRevision === recentWatcherDeletion.revision &&
            now - recentWatcherDeletion.observedAt <= watcherEventDeduplicationTtlMs
        ) {
            return recentWatcherDeletion.revision;
        }
        const revision: WorkspaceFileDeletionRevision =
            this.createDeletionTombstone(normalizedUri);
        this.recentWatcherDeletions.delete(key);
        this.recentWatcherDeletions.set(key, { revision, observedAt: now });
        while (this.recentWatcherDeletions.size > maxDeletionTombstones) {
            this.deleteOldest(this.recentWatcherDeletions);
        }
        return revision;
    }

    public expectCreation(
        uri: vscode.Uri,
        deletionRevision: WorkspaceFileDeletionRevision | undefined,
    ): void {
        if (uri.scheme !== "vsls" || this.isInternalStagingUri(uri)) {
            return;
        }
        this.prune();
        const key: string = this.getKey(uri);
        this.expectedCreations.delete(key);
        this.expectedCreations.set(key, {
            deletionRevision,
            expiresAt: Date.now() + expectedCreationTtlMs,
        });
        while (this.expectedCreations.size > maxDeletionTombstones) {
            this.deleteOldest(this.expectedCreations);
        }
    }

    public recordObservedCreation(uri: vscode.Uri): boolean {
        if (uri.scheme !== "vsls" || this.isInternalStagingUri(uri)) {
            return false;
        }
        this.prune();
        const key: string = this.getKey(uri);
        const expectation: IExpectedCreation | undefined = this.expectedCreations.get(key);
        if (expectation) {
            this.expectedCreations.delete(key);
            return expectation.deletionRevision === undefined
                ? false
                : this.recordCreation(uri, expectation.deletionRevision);
        }
        return this.recordCreation(uri);
    }

    public wasRecentlyDeleted(uri: vscode.Uri): boolean {
        return this.getDeletionRevision(uri) !== undefined;
    }

    public getDeletionRevision(uri: vscode.Uri): WorkspaceFileDeletionRevision | undefined {
        if (uri.scheme !== "vsls") {
            return undefined;
        }
        this.prune();
        const normalizedUri: vscode.Uri = this.normalizeUri(uri);
        let matchingTombstone: IDeletionTombstone | undefined;
        for (const tombstone of this.recentDeletions.values()) {
            if (
                this.covers(tombstone.uri, normalizedUri) &&
                (!matchingTombstone || tombstone.revision > matchingTombstone.revision)
            ) {
                matchingTombstone = tombstone;
            }
        }
        if (!matchingTombstone) {
            return undefined;
        }
        const recreatedPath: IRecreatedPath | undefined = this.recreatedPaths.get(this.getKey(normalizedUri));
        return recreatedPath && recreatedPath.deletionRevision >= matchingTombstone.revision
            ? undefined
            : matchingTombstone.revision;
    }

    public isDeletionRevisionCurrent(
        uri: vscode.Uri,
        revision: WorkspaceFileDeletionRevision,
    ): boolean {
        return this.getDeletionRevision(uri) === revision;
    }

    private getKey(uri: vscode.Uri): string {
        return this.normalizeUri(uri).toString();
    }

    private createDeletionTombstone(
        normalizedUri: vscode.Uri,
    ): WorkspaceFileDeletionRevision {
        const key: string = this.getKey(normalizedUri);
        const revision: WorkspaceFileDeletionRevision = this.nextRevision++;
        this.recentDeletions.delete(key);
        this.recentDeletions.set(key, {
            uri: normalizedUri,
            revision,
            deletedAt: Date.now(),
        });
        while (this.recentDeletions.size > maxDeletionTombstones) {
            this.deleteOldest(this.recentDeletions);
        }
        return revision;
    }

    private normalizeUri(uri: vscode.Uri): vscode.Uri {
        const normalizedPath: string = uri.path.length > 1
            ? uri.path.replace(/\/+$/, "")
            : uri.path;
        return uri.with({ fragment: "", path: normalizedPath, query: "" });
    }

    private covers(deletedUri: vscode.Uri, targetUri: vscode.Uri): boolean {
        return (
            deletedUri.scheme === targetUri.scheme &&
            deletedUri.authority === targetUri.authority &&
            (
                deletedUri.path === targetUri.path ||
                deletedUri.path === "/" ||
                targetUri.path.startsWith(`${deletedUri.path}/`)
            )
        );
    }

    private isInternalStagingUri(uri: vscode.Uri): boolean {
        const segments: string[] = uri.path.split("/");
        return internalStagingFilePattern.test(segments[segments.length - 1]);
    }

    private refreshWatchers(): void {
        for (const disposable of this.watcherDisposables) {
            disposable.dispose();
        }
        this.watcherDisposables = [];
        for (const folder of vscode.workspace.workspaceFolders || []) {
            if (folder.uri.scheme !== "vsls") {
                continue;
            }
            const watcher: vscode.FileSystemWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, "**/*"),
                false,
                true,
                false,
            );
            this.watcherDisposables.push(
                watcher,
                watcher.onDidDelete((uri: vscode.Uri) => this.recordObservedDeletion(uri)),
                watcher.onDidCreate((uri: vscode.Uri) => this.recordObservedCreation(uri)),
            );
        }
    }

    private deleteOldest<T>(entries: Map<string, T>): void {
        const oldestKey: string | undefined = entries.keys().next().value;
        if (oldestKey !== undefined) {
            entries.delete(oldestKey);
        }
    }

    private prune(): void {
        const cutoff: number = Date.now() - deletionTombstoneTtlMs;
        for (const [key, tombstone] of this.recentDeletions) {
            if (tombstone.deletedAt >= cutoff) {
                break;
            }
            this.recentDeletions.delete(key);
        }
        for (const [key, recreatedPath] of this.recreatedPaths) {
            if (recreatedPath.createdAt >= cutoff) {
                break;
            }
            this.recreatedPaths.delete(key);
        }
        const now: number = Date.now();
        for (const [key, expectation] of this.expectedCreations) {
            if (expectation.expiresAt <= now) {
                this.expectedCreations.delete(key);
            }
        }
        for (const [key, intent] of this.recentDeleteIntents) {
            if (now - intent.observedAt > deleteEventDeduplicationTtlMs) {
                this.recentDeleteIntents.delete(key);
            }
        }
        for (const [key, deletion] of this.recentWatcherDeletions) {
            if (now - deletion.observedAt > watcherEventDeduplicationTtlMs) {
                this.recentWatcherDeletions.delete(key);
            }
        }
    }
}

export const workspaceFileDeletionTracker: WorkspaceFileDeletionTracker =
    new WorkspaceFileDeletionTracker();
