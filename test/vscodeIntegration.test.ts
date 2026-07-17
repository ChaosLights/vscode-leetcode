// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as showCommands from "../src/commands/show";
import { LiveShareCodeLensController } from "../src/codelens/LiveShareCodeLensController";
import { CODE_LENS_BRIDGE_COMMAND } from "../src/codelens/LiveShareSafeCodeLensProvider";
import { LeetCodeNode } from "../src/explorer/LeetCodeNode";
import { leetCodeExecutor } from "../src/leetCodeExecutor";
import { DescriptionConfiguration, IProblem, ProblemState } from "../src/shared";
import {
    createWorkspaceTextFileAtomically,
    workspaceTextFileExists,
    writeWorkspaceTextFile,
} from "../src/utils/remoteFileWriter";
import {
    WorkspaceFileDeletionTracker,
    WorkspaceFileDeletionRevision,
    workspaceFileDeletionTracker,
} from "../src/utils/workspaceFileDeletionTracker";
import * as uiUtils from "../src/utils/uiUtils";
import * as workspaceUtils from "../src/utils/workspaceUtils";

const stagingFilePattern: RegExp = /\/\.vscode-leetcode-recreate-[a-f0-9]+\.tmp$/;

interface IPendingFile {
    content: Uint8Array;
    remainingInvisibleReads: number;
}

interface IStaleDeletedFile {
    content: Uint8Array;
    deletionVisible: boolean;
    recreatedFileVisible: boolean;
}

interface IRenameCall {
    oldPath: string;
    newPath: string;
    overwrite: boolean;
}

function assertCodeLensActions(codeLenses: vscode.CodeLens[] | undefined, expectedUri: vscode.Uri): void {
    assert.ok(codeLenses);
    assert.strictEqual(codeLenses.length, 4);
    assert.deepStrictEqual(
        codeLenses.map((codeLens: vscode.CodeLens) => codeLens.command?.title),
        ["Submit", "Test", "Solution", "Description"],
    );
    for (const codeLens of codeLenses) {
        assert.strictEqual(codeLens.command?.command, CODE_LENS_BRIDGE_COMMAND);
        const actionUri: vscode.Uri = codeLens.command?.arguments?.[0];
        assert.strictEqual(actionUri.toString(), expectedUri.toString());
        assert.strictEqual(actionUri.scheme, expectedUri.scheme);
        const bridgePosition: vscode.Position = codeLens.command?.arguments?.[1];
        assert.ok(bridgePosition instanceof vscode.Position);
        assert.strictEqual(bridgePosition.line, codeLens.range.start.line);
        assert.deepStrictEqual(codeLens.command?.arguments?.[2], []);
    }
}

function assertInlayHintActions(
    inlayHints: vscode.InlayHint[] | undefined,
    expectedUri: vscode.Uri,
): vscode.Command[] {
    assert.ok(inlayHints);
    assert.strictEqual(inlayHints.length, 1);
    const label: string | vscode.InlayHintLabelPart[] = inlayHints[0].label;
    assert.ok(Array.isArray(label));
    const commands: vscode.Command[] = (label as vscode.InlayHintLabelPart[])
        .map((part: vscode.InlayHintLabelPart) => part.command)
        .filter((command: vscode.Command | undefined): command is vscode.Command => Boolean(command));
    assert.deepStrictEqual(
        commands.map((command: vscode.Command) => command.title),
        ["Submit", "Test", "Solution", "Description"],
    );
    assert.deepStrictEqual(
        commands.map((command: vscode.Command) => command.command),
        [
            "leetcode.submitSolution",
            "leetcode.testSolution",
            "leetcode.showSolution",
            "leetcode.previewProblem",
        ],
    );
    for (const command of commands) {
        const actionUri: vscode.Uri = command.arguments?.[0];
        assert.strictEqual(actionUri.toString(), expectedUri.toString());
        assert.strictEqual(actionUri.scheme, expectedUri.scheme);
    }
    return commands;
}

async function getInlayHints(document: vscode.TextDocument): Promise<vscode.InlayHint[] | undefined> {
    const lastLine: vscode.TextLine = document.lineAt(document.lineCount - 1);
    return vscode.commands.executeCommand<vscode.InlayHint[]>(
        "vscode.executeInlayHintProvider",
        document.uri,
        new vscode.Range(0, 0, lastLine.lineNumber, lastLine.range.end.character),
    );
}

async function waitFor(
    predicate: () => boolean,
    failureMessage: string,
    timeoutMs: number = 3000,
): Promise<void> {
    const deadline: number = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(failureMessage);
}

async function setEditorSelection(
    editor: vscode.TextEditor,
    selection: vscode.Selection,
): Promise<void> {
    let observed: boolean = false;
    const registration: vscode.Disposable =
        vscode.window.onDidChangeTextEditorSelection((event: vscode.TextEditorSelectionChangeEvent) => {
            if (event.textEditor === editor && event.selections.length === 1 &&
                event.selections[0].isEqual(selection)) {
                observed = true;
            }
        });
    try {
        editor.selection = selection;
        await waitFor(() => observed, "The requested editor selection was not observed.");
    } finally {
        registration.dispose();
    }
}

async function expectSettledWithin(
    operation: Promise<void>,
    timeoutMs: number,
    failureMessage: string,
): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            operation,
            new Promise<void>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function testWorkspaceFileDeletionTrackerRevisions(): void {
    const tracker: WorkspaceFileDeletionTracker = new WorkspaceFileDeletionTracker();
    const parentUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/guest");
    const childUri: vscode.Uri = vscode.Uri.joinPath(parentUri, "1.two-sum.cpp");
    const siblingUri: vscode.Uri = vscode.Uri.joinPath(parentUri, "2.add-two-numbers.cpp");
    const parentRevision: WorkspaceFileDeletionRevision | undefined =
        tracker.recordDeletion(parentUri);
    assert.ok(parentRevision);
    assert.strictEqual(tracker.getDeletionRevision(childUri), parentRevision);
    assert.strictEqual(tracker.getDeletionRevision(siblingUri), parentRevision);
    assert.strictEqual(tracker.recordCreation(childUri, parentRevision), true);
    assert.strictEqual(tracker.getDeletionRevision(childUri), undefined);
    assert.strictEqual(tracker.getDeletionRevision(siblingUri), parentRevision);

    const secondRevision: WorkspaceFileDeletionRevision | undefined =
        tracker.recordDeletion(childUri);
    assert.ok(secondRevision);
    assert.notStrictEqual(secondRevision, parentRevision);
    assert.strictEqual(tracker.recordCreation(childUri, parentRevision), false);
    assert.strictEqual(tracker.getDeletionRevision(childUri), secondRevision);
    assert.strictEqual(tracker.recordObservedDeletion(childUri), secondRevision);

    tracker.expectCreation(childUri, secondRevision);
    const thirdRevision: WorkspaceFileDeletionRevision | undefined =
        tracker.recordDeletion(childUri);
    assert.ok(thirdRevision);
    assert.strictEqual(tracker.recordObservedCreation(childUri), false);
    assert.strictEqual(tracker.getDeletionRevision(childUri), thirdRevision);
    assert.strictEqual(tracker.recordObservedCreation(childUri), true);
    assert.strictEqual(tracker.getDeletionRevision(childUri), undefined);
    const watcherOnlySecondDeletion: WorkspaceFileDeletionRevision | undefined =
        tracker.recordObservedDeletion(childUri);
    assert.ok(watcherOnlySecondDeletion);
    assert.notStrictEqual(watcherOnlySecondDeletion, thirdRevision);
    assert.strictEqual(
        tracker.recordObservedDeletion(childUri),
        watcherOnlySecondDeletion,
    );
    assert.strictEqual(
        tracker.recordCreation(childUri, watcherOnlySecondDeletion),
        true,
    );
    const watcherDeletionAfterRecreation: WorkspaceFileDeletionRevision | undefined =
        tracker.recordObservedDeletion(childUri);
    assert.ok(watcherDeletionAfterRecreation);
    assert.notStrictEqual(watcherDeletionAfterRecreation, watcherOnlySecondDeletion);

    const rootRevision: WorkspaceFileDeletionRevision | undefined =
        tracker.recordDeletion(vscode.Uri.parse("vsls:/"));
    assert.ok(rootRevision);
    assert.strictEqual(
        tracker.getDeletionRevision(vscode.Uri.parse("vsls:/~0/code/root-covered.cpp")),
        rootRevision,
    );
    assert.strictEqual(
        tracker.recordDeletion(
            vscode.Uri.parse("vsls:/~0/code/.vscode-leetcode-recreate-deadbeef.tmp"),
        ),
        undefined,
    );
    assert.strictEqual(
        tracker.recordObservedCreation(
            vscode.Uri.parse("vsls:/~0/code/.vscode-leetcode-recreate-deadbeef.tmp"),
        ),
        false,
    );
    tracker.dispose();
}

async function testDetachedHintDoesNotHoldShowProblemTask(): Promise<void> {
    const workspaceUri: vscode.Uri = vscode.Uri.file(
        path.join(os.tmpdir(), `vscode-leetcode-show-lock-${process.pid}`),
    );
    await vscode.workspace.fs.createDirectory(workspaceUri);

    const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    const originalDefaultLanguage: string | undefined = config.inspect<string>("defaultLanguage")?.globalValue;
    const originalShowDescription: string | undefined = config.inspect<string>("showDescription")?.globalValue;
    const originalFilePath: object | undefined = config.inspect<object>("filePath")?.globalValue;
    const originalPromptHintMessage: any = (uiUtils as any).promptHintMessage;
    const originalShowProblem: any = (leetCodeExecutor as any).showProblem;
    const originalSelectWorkspaceFolder: any = (workspaceUtils as any).selectWorkspaceFolder;
    let coreRuns: number = 0;
    let hintCalls: number = 0;
    const neverHint: Promise<void> = new Promise<void>(() => undefined);
    try {
        await config.update("defaultLanguage", "cpp", vscode.ConfigurationTarget.Global);
        await config.update("showDescription", DescriptionConfiguration.None, vscode.ConfigurationTarget.Global);
        await config.update(
            "filePath",
            { default: { folder: "", filename: "show-task-lock.cpp" } },
            vscode.ConfigurationTarget.Global,
        );
        (workspaceUtils as any).selectWorkspaceFolder = async (): Promise<string> => workspaceUri.fsPath;
        (uiUtils as any).promptHintMessage = (): Promise<void> => {
            hintCalls++;
            return neverHint;
        };
        (leetCodeExecutor as any).showProblem = async (
            _node: IProblem,
            _language: string,
            filePath: string,
        ): Promise<void> => {
            coreRuns++;
            await vscode.workspace.fs.writeFile(
                vscode.Uri.file(filePath),
                Buffer.from("// generated by show lock regression\n", "utf8"),
            );
        };
        const node: LeetCodeNode = new LeetCodeNode({
            companies: [],
            difficulty: "Easy",
            id: "900001",
            isFavorite: false,
            locked: false,
            name: "show-task-lock-regression",
            passRate: "100%",
            state: ProblemState.Unknown,
            tags: [],
        });
        await expectSettledWithin(
            showCommands.showProblem(node),
            3000,
            "The first Code Now request remained locked on its information message.",
        );
        assert.strictEqual(coreRuns, 1);
        assert.strictEqual(hintCalls, 1);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(workspaceUri, "show-task-lock.cpp"));
        await expectSettledWithin(
            showCommands.showProblem(node),
            3000,
            "The second Code Now request reused a task whose information message was still open.",
        );
        assert.strictEqual(coreRuns, 2);
        assert.strictEqual(hintCalls, 2);
    } finally {
        (uiUtils as any).promptHintMessage = originalPromptHintMessage;
        (leetCodeExecutor as any).showProblem = originalShowProblem;
        (workspaceUtils as any).selectWorkspaceFolder = originalSelectWorkspaceFolder;
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await config.update("defaultLanguage", originalDefaultLanguage, vscode.ConfigurationTarget.Global);
        await config.update("showDescription", originalShowDescription, vscode.ConfigurationTarget.Global);
        await config.update("filePath", originalFilePath, vscode.ConfigurationTarget.Global);
        await vscode.workspace.fs.delete(workspaceUri, { recursive: true, useTrash: false });
    }
}

class InMemoryFileSystemProvider implements vscode.FileSystemProvider {
    private readonly directories: Set<string> = new Set<string>(["/", "/~0"]);
    private readonly files: Map<string, Uint8Array> = new Map<string, Uint8Array>();
    private readonly pendingFiles: Map<string, IPendingFile> = new Map<string, IPendingFile>();
    private readonly staleDeletedFiles: Map<string, IStaleDeletedFile> =
        new Map<string, IStaleDeletedFile>();
    private readonly writeCounts: Map<string, number> = new Map<string, number>();
    private readonly deleteCounts: Map<string, number> = new Map<string, number>();
    private readonly renameCalls: IRenameCall[] = [];
    private readonly symbolicDirectories: Set<string> = new Set<string>();
    private readonly unknownStats: Set<string> = new Set<string>();
    private readonly changeEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]> =
        new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private forceStagingCollision: boolean = false;

    public readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changeEmitter.event;

    constructor(private readonly delayedReadCount: number = 0) {}

    public watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    public stat(uri: vscode.Uri): vscode.FileStat {
        if (this.forceStagingCollision && stagingFilePattern.test(uri.path)) {
            return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 9 };
        }
        if (this.unknownStats.has(uri.path)) {
            return { type: vscode.FileType.Unknown, ctime: 0, mtime: 0, size: 0 };
        }
        const staleDeletedFile: IStaleDeletedFile | undefined = this.staleDeletedFiles.get(uri.path);
        if (staleDeletedFile) {
            if (!staleDeletedFile.deletionVisible) {
                return {
                    type: vscode.FileType.File,
                    ctime: 0,
                    mtime: 0,
                    size: staleDeletedFile.content.byteLength,
                };
            }
            if (!staleDeletedFile.recreatedFileVisible && this.files.has(uri.path)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
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

    public simulateStaleDeletion(uri: vscode.Uri): void {
        const content: Uint8Array | undefined = this.files.get(uri.path);
        if (!content) {
            throw new Error(`Cannot simulate deleting a missing file: ${uri.path}`);
        }
        this.files.delete(uri.path);
        this.staleDeletedFiles.set(uri.path, {
            content: Uint8Array.from(content),
            deletionVisible: false,
            recreatedFileVisible: false,
        });
    }

    public releaseStaleDeletion(uri: vscode.Uri): void {
        const staleDeletedFile: IStaleDeletedFile | undefined = this.staleDeletedFiles.get(uri.path);
        if (!staleDeletedFile) {
            return;
        }
        staleDeletedFile.deletionVisible = true;
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    public getWriteCount(uri: vscode.Uri): number {
        return this.writeCounts.get(uri.path) || 0;
    }

    public getRenameCalls(): readonly IRenameCall[] {
        return this.renameCalls;
    }

    public getStagingPaths(): string[] {
        return Array.from(this.files.keys())
            .filter((filePath: string) => filePath.indexOf("/.vscode-leetcode-recreate-") >= 0);
    }

    public isRecreatedFileVisible(uri: vscode.Uri): boolean {
        return this.staleDeletedFiles.get(uri.path)?.recreatedFileVisible === true;
    }

    public setForceStagingCollision(value: boolean): void {
        this.forceStagingCollision = value;
    }

    public getStagingDeleteCount(): number {
        return Array.from(this.deleteCounts.entries())
            .filter(([filePath]) => stagingFilePattern.test(filePath))
            .reduce((count: number, [, deleteCount]) => count + deleteCount, 0);
    }

    public readFile(uri: vscode.Uri): Uint8Array {
        if (this.forceStagingCollision && stagingFilePattern.test(uri.path)) {
            return Buffer.from("collision", "utf8");
        }
        const pending: IPendingFile | undefined = this.pendingFiles.get(uri.path);
        if (pending) {
            if (pending.remainingInvisibleReads > 0) {
                pending.remainingInvisibleReads--;
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            this.pendingFiles.delete(uri.path);
            this.files.set(uri.path, pending.content);
        }
        const staleDeletedFile: IStaleDeletedFile | undefined = this.staleDeletedFiles.get(uri.path);
        if (
            staleDeletedFile &&
            (!staleDeletedFile.deletionVisible || !staleDeletedFile.recreatedFileVisible)
        ) {
            return staleDeletedFile.content;
        }
        const content: Uint8Array | undefined = this.files.get(uri.path);
        if (content) {
            return content;
        }
        throw vscode.FileSystemError.FileNotFound(uri);
    }

    public writeFile(uri: vscode.Uri, content: Uint8Array): void {
        this.writeCounts.set(uri.path, this.getWriteCount(uri) + 1);
        const staleDeletedFile: IStaleDeletedFile | undefined = this.staleDeletedFiles.get(uri.path);
        if (staleDeletedFile && !staleDeletedFile.deletionVisible) {
            return;
        }
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
        this.deleteCounts.set(uri.path, (this.deleteCounts.get(uri.path) || 0) + 1);
        const virtualStagingCollision: boolean =
            this.forceStagingCollision && stagingFilePattern.test(uri.path);
        const existed: boolean =
            virtualStagingCollision ||
            this.files.has(uri.path) ||
            this.pendingFiles.has(uri.path) ||
            this.staleDeletedFiles.has(uri.path) ||
            this.directories.has(uri.path);
        if (!existed) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        this.files.delete(uri.path);
        this.pendingFiles.delete(uri.path);
        this.staleDeletedFiles.delete(uri.path);
        this.directories.delete(uri.path);
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
        const content: Uint8Array | undefined = this.files.get(oldUri.path);
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        if (!options.overwrite && (this.files.has(newUri.path) || this.pendingFiles.has(newUri.path))) {
            throw vscode.FileSystemError.FileExists(newUri);
        }
        this.renameCalls.push({
            oldPath: oldUri.path,
            newPath: newUri.path,
            overwrite: options.overwrite,
        });
        this.files.delete(oldUri.path);
        this.files.set(newUri.path, content);
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }]);
        setTimeout(() => {
            const staleDeletedFile: IStaleDeletedFile | undefined =
                this.staleDeletedFiles.get(newUri.path);
            if (staleDeletedFile) {
                staleDeletedFile.recreatedFileVisible = true;
            }
            this.changeEmitter.fire([{ type: vscode.FileChangeType.Created, uri: newUri }]);
        }, 150);
    }
}

export async function run(): Promise<void> {
    testWorkspaceFileDeletionTrackerRevisions();
    await testDetachedHintDoesNotHoldShowProblemTask();

    const provider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider(2);
    const registration: vscode.Disposable = vscode.workspace.registerFileSystemProvider("vsls", provider, {
        isCaseSensitive: true,
        isReadonly: false,
    });
    const remoteProvider: InMemoryFileSystemProvider = new InMemoryFileSystemProvider();
    const remoteRegistration: vscode.Disposable =
        vscode.workspace.registerFileSystemProvider("vscode-remote", remoteProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        });
    try {
        const fileUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/guest/1.two-sum.cpp");
        const parentUri: vscode.Uri = vscode.Uri.parse("vsls:/~0/code/guest");
        const workspaceRootUri: vscode.Uri = vscode.Uri.parse("vsls:/~0");

        const eventTracker: WorkspaceFileDeletionTracker = new WorkspaceFileDeletionTracker();
        const eventTracking: vscode.Disposable = eventTracker.start();
        try {
            const eventUri: vscode.Uri = vscode.Uri.joinPath(parentUri, "event-tracker.cpp");
            assert.strictEqual(
                await writeWorkspaceTextFile(eventUri, parentUri, "event tracker\n", workspaceRootUri),
                "created",
            );
            const deleteEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
            deleteEdit.deleteFile(eventUri, {
                ignoreIfNotExists: false,
                recursive: false,
            });
            assert.strictEqual(await vscode.workspace.applyEdit(deleteEdit), true);
            await waitFor(
                () => eventTracker.wasRecentlyDeleted(eventUri),
                "The production deletion listeners did not record a deleted Live Share file.",
            );
        } finally {
            eventTracking.dispose();
        }

        assert.strictEqual(
            await writeWorkspaceTextFile(fileUri, parentUri, "first solution\n", workspaceRootUri),
            "created",
        );
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8"),
            "first solution\n",
        );

        const deletedFileUri: vscode.Uri =
            vscode.Uri.parse("vsls:/~0/code/guest/7.reverse-integer.cpp");
        assert.strictEqual(
            await writeWorkspaceTextFile(
                deletedFileUri,
                parentUri,
                "generated template\n",
                workspaceRootUri,
            ),
            "created",
        );
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(deletedFileUri)).toString("utf8"),
            "generated template\n",
        );
        const directTargetWritesBeforeDelete: number = provider.getWriteCount(deletedFileUri);
        provider.simulateStaleDeletion(deletedFileUri);
        const deletionRevision: WorkspaceFileDeletionRevision | undefined =
            workspaceFileDeletionTracker.recordDeletion(deletedFileUri);
        assert.ok(deletionRevision);
        assert.strictEqual(await workspaceTextFileExists(deletedFileUri), true);
        setTimeout(() => provider.releaseStaleDeletion(deletedFileUri), 150);
        const recreatedResult: string = await createWorkspaceTextFileAtomically(
            deletedFileUri,
            parentUri,
            "generated template\n",
            workspaceRootUri,
            deletionRevision,
        );
        assert.ok(
            recreatedResult === "created" || recreatedResult === "existing",
            `Unexpected recreation result; renames=${JSON.stringify(provider.getRenameCalls())}, ` +
            `deletionCurrent=${workspaceFileDeletionTracker.isDeletionRevisionCurrent(
                deletedFileUri,
                deletionRevision,
            )}`,
        );
        assert.strictEqual(provider.isRecreatedFileVisible(deletedFileUri), true);
        assert.strictEqual(
            Buffer.from(await vscode.workspace.fs.readFile(deletedFileUri)).toString("utf8"),
            "generated template\n",
        );
        assert.strictEqual(provider.getWriteCount(deletedFileUri), directTargetWritesBeforeDelete);
        const recreateRename: IRenameCall | undefined = provider.getRenameCalls()
            .find((call: IRenameCall) => call.newPath === deletedFileUri.path);
        assert.ok(recreateRename);
        assert.strictEqual(recreateRename.overwrite, false);
        assert.match(recreateRename.oldPath, /\/\.vscode-leetcode-recreate-[a-f0-9]+\.tmp$/);
        assert.deepStrictEqual(provider.getStagingPaths(), []);
        assert.strictEqual(workspaceFileDeletionTracker.wasRecentlyDeleted(deletedFileUri), false);

        const collidingStagingDeleteCount: number = provider.getStagingDeleteCount();
        provider.setForceStagingCollision(true);
        try {
            await assert.rejects(
                createWorkspaceTextFileAtomically(
                    vscode.Uri.parse("vsls:/~0/code/guest/staging-collision.cpp"),
                    parentUri,
                    "must not delete somebody else's staging file\n",
                    workspaceRootUri,
                ),
                /unique staging file/i,
            );
            assert.strictEqual(provider.getStagingDeleteCount(), collidingStagingDeleteCount);
        } finally {
            provider.setForceStagingCollision(false);
        }

        const solutionUri: vscode.Uri =
            vscode.Uri.parse("vsls:/~0/code/guest/8.string-to-integer-atoi.cpp");
        const solutionText: string = [
            "// @lc app=leetcode id=8 lang=cpp",
            "",
            "class Solution {};",
            "",
            "// @lc code=end",
            "",
        ].join("\n");
        assert.strictEqual(
            await writeWorkspaceTextFile(solutionUri, parentUri, solutionText, workspaceRootUri),
            "created",
        );
        const solutionDocument: vscode.TextDocument = await vscode.workspace.openTextDocument(solutionUri);
        const codeLensController: LiveShareCodeLensController = new LiveShareCodeLensController([1000]);
        const actionInvocations: Array<{ command: string; uri: vscode.Uri }> = [];
        const actionCommandRegistrations: vscode.Disposable[] = [
            vscode.commands.registerCommand("leetcode.submitSolution", (uri: vscode.Uri) => {
                actionInvocations.push({ command: "leetcode.submitSolution", uri });
            }),
            vscode.commands.registerCommand("leetcode.testSolution", (uri: vscode.Uri) => {
                actionInvocations.push({ command: "leetcode.testSolution", uri });
            }),
            vscode.commands.registerCommand("leetcode.showSolution", (uri: vscode.Uri) => {
                actionInvocations.push({ command: "leetcode.showSolution", uri });
            }),
            vscode.commands.registerCommand("leetcode.previewProblem", (uri: vscode.Uri) => {
                actionInvocations.push({ command: "leetcode.previewProblem", uri });
            }),
        ];
        const localSolutionUri: vscode.Uri = vscode.Uri.file(
            path.join(os.tmpdir(), `vscode-leetcode-codelens-${process.pid}.cpp`),
        );
        await vscode.workspace.fs.writeFile(localSolutionUri, Buffer.from(solutionText, "utf8"));
        const remoteSolutionUri: vscode.Uri =
            vscode.Uri.parse("vscode-remote://probe/code/8.string-to-integer-atoi.cpp");
        remoteProvider.writeFile(
            remoteSolutionUri,
            Buffer.from(solutionText, "utf8"),
        );
        try {
            const guestCodeLenses: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    solutionUri,
                    Number.MAX_VALUE,
                );
            assert.deepStrictEqual(
                guestCodeLenses || [],
                [],
                "The plugin must not create a remoted CodeLens that Live Share can reduce to 'no commands'.",
            );

            await vscode.workspace.openTextDocument(localSolutionUri);
            const localCodeLenses: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    localSolutionUri,
                    Number.MAX_VALUE,
                );
            assertCodeLensActions(localCodeLenses, localSolutionUri);

            const localEditor: vscode.TextEditor =
                await vscode.window.showTextDocument(localSolutionUri, { preview: false });
            const localOriginalSelection: vscode.Selection = new vscode.Selection(2, 0, 2, 0);
            await setEditorSelection(localEditor, localOriginalSelection);
            const localSubmitCommand: vscode.Command | undefined = localCodeLenses?.[0].command;
            assert.ok(localSubmitCommand);
            await vscode.commands.executeCommand(
                localSubmitCommand.command,
                ...(localSubmitCommand.arguments || []),
            );
            await waitFor(
                () => actionInvocations.length === 1,
                "Host CodeLens action did not execute locally.",
            );
            assert.strictEqual(actionInvocations[0].command, "leetcode.submitSolution");
            assert.strictEqual(actionInvocations[0].uri.toString(), localSolutionUri.toString());
            assert.ok(localEditor.selection.isEqual(localOriginalSelection));
            actionInvocations.length = 0;

            const remoteDocument: vscode.TextDocument =
                await vscode.workspace.openTextDocument(remoteSolutionUri);
            await vscode.window.showTextDocument(remoteDocument, { preview: false });
            const remoteCodeLenses: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    remoteSolutionUri,
                    Number.MAX_VALUE,
                );
            assert.deepStrictEqual(remoteCodeLenses || [], []);
            const remoteHintCommands: vscode.Command[] =
                assertInlayHintActions(await getInlayHints(remoteDocument), remoteSolutionUri);
            codeLensController.refresh();
            assertInlayHintActions(await getInlayHints(remoteDocument), remoteSolutionUri);

            const guestEditor: vscode.TextEditor =
                await vscode.window.showTextDocument(solutionDocument, { preview: false });
            const originalSelection: vscode.Selection = new vscode.Selection(2, 0, 2, 0);
            await setEditorSelection(guestEditor, originalSelection);
            const guestCodeLensesAfterOpen: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    solutionUri,
                    Number.MAX_VALUE,
                );
            assert.deepStrictEqual(guestCodeLensesAfterOpen || [], []);
            const guestHintCommands: vscode.Command[] =
                assertInlayHintActions(await getInlayHints(solutionDocument), solutionUri);

            const expectedCommands: string[] = [
                "leetcode.submitSolution",
                "leetcode.testSolution",
                "leetcode.showSolution",
                "leetcode.previewProblem",
            ];
            for (let index: number = 0; index < guestHintCommands.length; index++) {
                const command: vscode.Command = guestHintCommands[index];
                await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
                await waitFor(
                    () => actionInvocations.length === index + 1,
                    `Guest inline action ${index} did not execute locally.`,
                );
                assert.strictEqual(actionInvocations[index].command, expectedCommands[index]);
                assert.strictEqual(actionInvocations[index].uri.toString(), solutionUri.toString());
                assert.ok(guestEditor.selection.isEqual(originalSelection));
            }

            const repeatCommand: vscode.Command = guestHintCommands[1];
            await vscode.commands.executeCommand(
                repeatCommand.command,
                ...(repeatCommand.arguments || []),
            );
            await waitFor(
                () => actionInvocations.length === expectedCommands.length + 1,
                "Repeated guest CodeLens action did not execute.",
            );
            assert.strictEqual(
                actionInvocations[actionInvocations.length - 1].command,
                "leetcode.testSolution",
            );
            assert.strictEqual(
                actionInvocations[actionInvocations.length - 1].uri.toString(),
                solutionUri.toString(),
            );
            assert.strictEqual(remoteHintCommands.length, guestHintCommands.length);

            const fakeMarkerUri: vscode.Uri = vscode.Uri.file(
                path.join(os.tmpdir(), `vscode-leetcode-fake-codelens-${process.pid}.cpp`),
            );
            await vscode.workspace.fs.writeFile(
                fakeMarkerUri,
                Buffer.from([
                    "// @lc app=leetcode id=8 lang=cpp",
                    "const char* marker = \"@lc code=end\";",
                ].join("\n"), "utf8"),
            );
            try {
                const fakeMarkerDocument: vscode.TextDocument =
                    await vscode.workspace.openTextDocument(fakeMarkerUri);
                const fakeMarkerCodeLenses: vscode.CodeLens[] | undefined =
                    await vscode.commands.executeCommand<vscode.CodeLens[]>(
                        "vscode.executeCodeLensProvider",
                        fakeMarkerUri,
                        Number.MAX_VALUE,
                    );
                assert.deepStrictEqual(fakeMarkerCodeLenses || [], []);

                const makeValidEdit: vscode.WorkspaceEdit = new vscode.WorkspaceEdit();
                makeValidEdit.insert(
                    fakeMarkerUri,
                    fakeMarkerDocument.lineAt(fakeMarkerDocument.lineCount - 1).range.end,
                    "\n// @lc code=end\n",
                );
                assert.strictEqual(await vscode.workspace.applyEdit(makeValidEdit), true);
                const newlyValidCodeLenses: vscode.CodeLens[] | undefined =
                    await vscode.commands.executeCommand<vscode.CodeLens[]>(
                        "vscode.executeCodeLensProvider",
                        fakeMarkerUri,
                        Number.MAX_VALUE,
                    );
                assertCodeLensActions(newlyValidCodeLenses, fakeMarkerUri);
            } finally {
                await vscode.workspace.fs.delete(fakeMarkerUri);
            }
        } finally {
            for (const actionCommandRegistration of actionCommandRegistrations) {
                actionCommandRegistration.dispose();
            }
            codeLensController.dispose();
            await vscode.workspace.fs.delete(localSolutionUri);
            await vscode.workspace.fs.delete(remoteSolutionUri);
        }

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
        remoteRegistration.dispose();
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
