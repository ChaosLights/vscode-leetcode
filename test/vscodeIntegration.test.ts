// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as assert from "assert";
import * as vscode from "vscode";
import { workspaceTextFileExists, writeWorkspaceTextFile } from "../src/utils/remoteFileWriter";

interface IPendingFile {
    content: Uint8Array;
    remainingInvisibleReads: number;
}

class InMemoryFileSystemProvider implements vscode.FileSystemProvider {
    private readonly directories: Set<string> = new Set<string>(["/", "/~0"]);
    private readonly files: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    private readonly pendingFiles: Map<string, IPendingFile> = new Map<string, IPendingFile>();
    private readonly symbolicDirectories: Set<string> = new Set<string>();
    private readonly unknownStats: Set<string> = new Set<string>();
    private readonly changeEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]> =
        new vscode.EventEmitter<vscode.FileChangeEvent[]>();

    public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event;

    constructor(private readonly delayedReadCount: number = 0) {}

    public watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    public stat(uri: vscode.Uri): vscode.FileStat {
        if (this.unknownStats.has(uri.path)) {
            return { type: vscode.FileType.Unknown, ctime: 0, mtime: 0, size: 0 };
        }
        const content: Uint8Array | undefined = this.files.get(uri.path);
        if (content) {
            return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.byteLength };
        }
        if (this.directories.has(uri.path)) {
            const type: vscode.FileType = this.symbolicDirectories.has(uri.path)
                // tslint:disable-next-line:no-bitwise
                ? vscode.FileType.Directory | vscode.FileType.SymbolicLink
                : vscode.FileType.Directory;
            return { type, ctime: 0, mtime: 0, size: 0 };
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    public readDirectory(uri: vscode.Uri): Array<[string, vscode.FileType]> {
        if (!this.directories.has(uri.path)) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return [];
    }

    public createDirectory(uri: vscode.Uri): void {
        const segments: string[] = uri.path.split("/").filter((segment: string) => Boolean(segment));
        let currentPath: string = "";
        this.directories.add("/");
        for (const segment of segments) {
            currentPath += `/${segment}`;
            this.directories.add(currentPath);
        }
    }

    public addSymbolicDirectory(uri: vscode.Uri): void {
        this.createDirectory(uri);
        this.symbolicDirectories.add(uri.path);
    }

    public addUnknownStat(uri: vscode.Uri): void {
        this.unknownStats.add(uri.path);
    }

    public readFile(uri: vscode.Uri): Uint8Array {
        const pending: IPendingFile | undefined = this.pendingFiles.get(uri.path);
        if (pending) {
            if (pending.remainingInvisibleReads > 0) {
                pending.remainingInvisibleReads--;
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            this.pendingFiles.delete(uri.path);
            this.files.set(uri.path, pending.content);
        }
        const content: Uint8Array | undefined = this.files.get(uri.path);
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return content;
    }

    public writeFile(uri: vscode.Uri, content: Uint8Array): void {
        const copiedContent: Uint8Array = Uint8Array.from(content);
        if (this.delayedReadCount > 0) {
            this.pendingFiles.set(uri.path, {
                content: copiedContent,
                remainingInvisibleReads: this.delayedReadCount,
            });
        } else {
            this.files.set(uri.path, copiedContent);
        }
    }

    public delete(uri: vscode.Uri): void {
        this.files.delete(uri.path);
        this.directories.delete(uri.path);
    }

    public rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        const content: Uint8Array | undefined = this.files.get(oldUri.path);
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        this.files.delete(oldUri.path);
        this.files.set(newUri.path, content);
    }
}

export async function run(): Promise<void> {
    const provider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider(2);
    const registration: vscode.Disposable = vscode.workspace.registerFileSystemProvider("vsls", provider, {
        isCaseSensitive: true,
        isReadonly: false,
    });
    try {
        const fileUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/guest/1.two-sum.cpp");
        const parentUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/guest");
        const workspaceRootUri: vscode.Uri = vscode.Uri.parse("vsls:/~0");
        assert.strictEqual(
            await writeWorkspaceTextFile(fileUri, parentUri, "first solution\n", workspaceRootUri),
            "created",
        );
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8"),
            "first solution\n",
        );

        assert.strictEqual(
            await writeWorkspaceTextFile(
                fileUri,
                parentUri,
                "replacement must not win\n",
                workspaceRootUri,
            ),
            "existing",
        );
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8"),
            "first solution\n",
        );

        const concurrentFileUri: vscode.Uri =
            vscode.Uri.parse("vsls:/~0/code/guest/2.add-two-numbers.cpp");
        const concurrentResults: string[] = await Promise.all([
            writeWorkspaceTextFile(
                concurrentFileUri,
                parentUri,
                "first concurrent solution\n",
                workspaceRootUri,
            ),
            writeWorkspaceTextFile(
                concurrentFileUri,
                parentUri,
                "second concurrent solution must not win\n",
                workspaceRootUri,
            ),
        ]);
        assert.deepStrictEqual(concurrentResults, ["created", "existing"]);
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(concurrentFileUri)).toString("utf8"),
            "first concurrent solution\n",
        );

        const disconnectedPreflightUri: vscode.Uri =
            vscode.Uri.parse("vsls:/~0/code/guest/3.longest-substring.cpp");
        provider.addUnknownStat(disconnectedPreflightUri);
        await assert.rejects(
            workspaceTextFileExists(disconnectedPreflightUri),
            /reconnect to the Live Share session/i,
        );

        const disconnectedWriteUri: vscode.Uri =
            vscode.Uri.parse("vsls:/~0/code/guest/4.median-of-two-sorted-arrays.cpp");
        provider.addUnknownStat(disconnectedWriteUri);
        await assert.rejects(
            writeWorkspaceTextFile(
                disconnectedWriteUri,
                parentUri,
                "solution\n",
                workspaceRootUri,
            ),
            /reconnect to the Live Share session/i,
        );

        const symbolicParentUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/link");
        provider.addSymbolicDirectory(symbolicParentUri);
        await assert.rejects(
            writeWorkspaceTextFile(
                vscode.Uri.parse("vsls:/~0/code/link/3.longest-substring.cpp"),
                symbolicParentUri,
                "solution\n",
                workspaceRootUri,
            ),
            /symbolic-link/i,
        );
    } finally {
        registration.dispose();
    }

    const readOnlyProvider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider();
    const readOnlyRegistration: vscode.Disposable = vscode.workspace.registerFileSystemProvider(
        "vsls-readonly",
        readOnlyProvider,
        { isReadonly: true },
    );
    try {
        await assert.rejects(
            writeWorkspaceTextFile(
                vscode.Uri.parse("vsls-readonly:/~0/code/guest/2.add-two-numbers.cpp"),
                vscode.Uri.parse("vsls-readonly:/~0/code/guest"),
                "solution\n",
            ),
            /read-only/i,
        );
    } finally {
        readOnlyRegistration.dispose();
    }
}
