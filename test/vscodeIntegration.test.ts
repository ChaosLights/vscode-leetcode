// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { LiveShareCodeLensController } from "../src/codelens/LiveShareCodeLensController";
import { CODE_LENS_BRIDGE_COMMAND } from "../src/codelens/LiveShareSafeCodeLensProvider";
import { workspaceTextFileExists, writeWorkspaceTextFile } from "../src/utils/remoteFileWriter";

interface IPendingFile {
    content: Uint8Array;
    remainingInvisibleReads: number;
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
        const codeLensController: LiveShareCodeLensController = new LiveShareCodeLensController();
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
        let remotedCodeLensRegistration: vscode.Disposable | undefined;
        try {
            const guestLocalCodeLenses: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    solutionUri,
                    Number.MAX_VALUE,
                );
            assert.deepStrictEqual(guestLocalCodeLenses || [], []);

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

            remotedCodeLensRegistration = vscode.languages.registerCodeLensProvider(
                { scheme: "vsls" },
                {
                    provideCodeLenses: (document: vscode.TextDocument): vscode.CodeLens[] =>
                        (localCodeLenses || []).map((codeLens: vscode.CodeLens) =>
                            new vscode.CodeLens(codeLens.range, {
                                title: codeLens.command?.title || "",
                                command: codeLens.command?.command || "",
                                tooltip: codeLens.command?.tooltip,
                                arguments: [
                                    document.uri,
                                    new vscode.Position(
                                        codeLens.command?.arguments?.[1].line,
                                        codeLens.command?.arguments?.[1].character,
                                    ),
                                    [],
                                ],
                            })),
                },
            );
            const guestCodeLenses: vscode.CodeLens[] | undefined =
                await vscode.commands.executeCommand<vscode.CodeLens[]>(
                    "vscode.executeCodeLensProvider",
                    solutionUri,
                    Number.MAX_VALUE,
                );
            assertCodeLensActions(guestCodeLenses, solutionUri);

            const guestEditor: vscode.TextEditor =
                await vscode.window.showTextDocument(solutionDocument, { preview: false });
            const originalSelection: vscode.Selection = new vscode.Selection(2, 0, 2, 0);
            await setEditorSelection(guestEditor, originalSelection);

            const expectedCommands: string[] = [
                "leetcode.submitSolution",
                "leetcode.testSolution",
                "leetcode.showSolution",
                "leetcode.previewProblem",
            ];
            for (let index: number = 0; index < (guestCodeLenses || []).length; index++) {
                const command: vscode.Command | undefined = guestCodeLenses?.[index].command;
                assert.ok(command);
                await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
                await waitFor(
                    () => actionInvocations.length === index + 1,
                    `Guest CodeLens action ${index} did not execute locally.`,
                );
                assert.strictEqual(actionInvocations[index].command, expectedCommands[index]);
                assert.strictEqual(actionInvocations[index].uri.toString(), solutionUri.toString());
                assert.ok(guestEditor.selection.isEqual(originalSelection));
            }

            const repeatCommand: vscode.Command | undefined = guestCodeLenses?.[1].command;
            assert.ok(repeatCommand);
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
            remotedCodeLensRegistration?.dispose();
            for (const actionCommandRegistration of actionCommandRegistrations) {
                actionCommandRegistration.dispose();
            }
            codeLensController.dispose();
            await vscode.workspace.fs.delete(localSolutionUri);
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
