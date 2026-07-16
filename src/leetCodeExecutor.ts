// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as requireFromString from "require-from-string";
import { ExtensionContext } from "vscode";
import { Disposable, MessageItem, version as vscodeVersion, window, workspace, WorkspaceConfiguration } from "vscode";
import { Endpoint, IProblem, leetcodeHasInited, supportedPlugins } from "./shared";
import { createCliUserRecord, ICliUserRecord } from "./utils/cliSessionUtils";
import { executeCommand, executeCommandWithProgress, spawnCommand } from "./utils/cpUtils";
import { shouldUseElectronRunAsNodeFlag } from "./utils/runtimeUtils";
import { DialogOptions, openUrl } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";

interface INodeRuntime {
    argsPrefix: string[];
    command: string;
    env: NodeJS.ProcessEnv;
    isBuiltIn: boolean;
}

export interface ICliSessionWriteResult {
    endpoint: string;
    filePath: string;
    hasFavoriteHash: boolean;
    sessionCsrfLength: number;
    sessionIdLength: number;
    size: number;
}

class LeetCodeExecutor implements Disposable {
    private leetCodeRootPath: string;

    constructor() {
        this.leetCodeRootPath = path.join(__dirname, "..", "..", "node_modules", "vsc-leetcode-cli");
    }

    public async getLeetCodeBinaryPath(): Promise<string> {
        if (wsl.useWsl()) {
            return await wsl.toWslPath(path.join(this.leetCodeRootPath, "bin", "leetcode"));
        }
        return path.join(this.leetCodeRootPath, "bin", "leetcode");
    }

    public async getRuntimeDescription(): Promise<string> {
        const runtime: INodeRuntime = await this.getNodeRuntime();
        return [
            `command=${runtime.command}`,
            `argsPrefix=${JSON.stringify(runtime.argsPrefix)}`,
            `builtIn=${runtime.isBuiltIn}`,
            `platform=${process.platform}`,
            `arch=${process.arch}`,
            `vscode=${vscodeVersion}`,
        ].join(", ");
    }

    public async meetRequirements(context: ExtensionContext): Promise<boolean> {
        const hasInited: boolean | undefined = context.globalState.get(leetcodeHasInited);
        if (!hasInited) {
            await this.removeOldCache();
        }
        const runtime: INodeRuntime = await this.getNodeRuntime();
        try {
            const nodeVersion: string = (await this.executeCommandEx(["-p", "process.version"])).trim();
            if (!/^v\d+\.\d+\.\d+/.test(nodeVersion)) {
                throw new Error(`The selected executable did not start in Node.js mode: ${nodeVersion}`);
            }
        } catch (error) {
            const message: string = runtime.isBuiltIn
                ? "LeetCode could not start the Node.js runtime included with VS Code. Reload or update desktop VS Code."
                : wsl.useWsl()
                    ? "LeetCode needs Node.js installed inside WSL when leetcode.useWsl is enabled."
                    : "LeetCode could not start the configured Node.js executable.";
            const choice: MessageItem | undefined = await window.showErrorMessage(
                message,
                DialogOptions.open,
            );
            if (choice === DialogOptions.open) {
                openUrl(runtime.isBuiltIn ? "https://code.visualstudio.com/download" : "https://nodejs.org");
            }
            return false;
        }
        for (const plugin of supportedPlugins) {
            try { // Check plugin
                await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "plugin", "-e", plugin]);
            } catch (error) { // Remove old cache that may cause the error download plugin and activate
                await this.removeOldCache();
                await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "plugin", "-i", plugin]);
            }
        }
        // Set the global state HasInited true to skip delete old cache after init
        context.globalState.update(leetcodeHasInited, true);
        return true;
    }

    public async deleteCache(): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "cache", "-d"]);
    }

    public async getUserInfo(): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "user"]);
    }

    public async signOut(): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "user", "-L"]);
    }

    public async clearLoginSession(): Promise<void> {
        const cliDirectory: string = this.getCliSessionDirectory().directory;
        await Promise.all([
            fse.remove(path.join(cliDirectory, "user.json")),
            fse.remove(path.join(cliDirectory, "cache", "problems.json")),
        ]);
    }

    public async writeLoginSession(
        cookie: string,
        username: string,
        isPremium: boolean,
        favoriteHash?: string,
    ): Promise<ICliSessionWriteResult> {
        if (wsl.useWsl()) {
            throw new Error("Direct CLI session creation is not available when leetcode.useWsl is enabled.");
        }

        const location: { directory: string, endpoint: string } = this.getCliSessionDirectory();
        const filePath: string = path.join(location.directory, "user.json");
        let existingHash: string | undefined;
        try {
            const existing: any = await fse.readJson(filePath);
            existingHash = typeof existing.hash === "string" ? existing.hash : undefined;
        } catch (error) {
            existingHash = undefined;
        }

        const record: ICliUserRecord = createCliUserRecord(
            cookie,
            username,
            isPremium,
            favoriteHash || existingHash,
        );
        await fse.ensureDir(location.directory);
        await fse.writeJson(filePath, record);
        if (process.platform !== "win32") {
            await fse.chmod(filePath, 0o600);
        }
        const stats: fse.Stats = await fse.stat(filePath);
        return {
            endpoint: location.endpoint,
            filePath,
            hasFavoriteHash: Boolean(record.hash),
            sessionCsrfLength: record.sessionCSRF.length,
            sessionIdLength: record.sessionId.length,
            size: stats.size,
        };
    }

    public async listProblems(showLocked: boolean, needTranslation: boolean): Promise<string> {
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "list"];
        if (!needTranslation) {
            cmd.push("-T"); // use -T to prevent translation
        }
        if (!showLocked) {
            cmd.push("-q");
            cmd.push("L");
        }
        return await this.executeCommandEx(cmd);
    }

    public async showProblem(problemNode: IProblem, language: string, filePath: string, showDescriptionInComment: boolean = false, needTranslation: boolean): Promise<void> {
        if (!await fse.pathExists(filePath)) {
            await fse.createFile(filePath);
            const codeTemplate: string = await this.getProblemTemplate(
                problemNode,
                language,
                showDescriptionInComment,
                needTranslation,
            );
            await fse.writeFile(filePath, codeTemplate);
        }
    }

    public async getProblemTemplate(
        problemNode: IProblem,
        language: string,
        showDescriptionInComment: boolean = false,
        needTranslation: boolean,
    ): Promise<string> {
        const templateType: string = showDescriptionInComment ? "-cx" : "-c";
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", problemNode.id, templateType, "-l", language];

        if (!needTranslation) {
            cmd.push("-T"); // use -T to force English version
        }

        return this.executeCommandWithProgressEx("Fetching problem data...", cmd);
    }

    /**
     * This function returns solution of a problem identified by input
     *
     * @remarks
     * Even though this function takes the needTranslation flag, it is important to note
     * that as of vsc-leetcode-cli 2.8.0, leetcode-cli doesn't support querying solution
     * on CN endpoint yet. So this flag doesn't have any effect right now.
     *
     * @param input - parameter to pass to cli that can identify a problem
     * @param language - the source code language of the solution desired
     * @param needTranslation - whether or not to use endPoint translation on solution query
     * @returns promise of the solution string
     */
    public async showSolution(input: string, language: string, needTranslation: boolean): Promise<string> {
        // solution don't support translation
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", input, "--solution", "-l", language];
        if (!needTranslation) {
            cmd.push("-T");
        }
        const solution: string = await this.executeCommandWithProgressEx("Fetching top voted solution from discussions...", cmd);
        return solution;
    }

    public async getDescription(problemNodeId: string, needTranslation: boolean): Promise<string> {
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", problemNodeId, "-x"];
        if (!needTranslation) {
            cmd.push("-T");
        }
        return await this.executeCommandWithProgressEx("Fetching problem description...", cmd);
    }

    public async listSessions(): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "session"]);
    }

    public async enableSession(name: string): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "session", "-e", name]);
    }

    public async createSession(id: string): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "session", "-c", id]);
    }

    public async deleteSession(id: string): Promise<string> {
        return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "session", "-d", id]);
    }

    public async submitSolution(filePath: string): Promise<string> {
        try {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", [await this.getLeetCodeBinaryPath(), "submit", filePath]);
        } catch (error) {
            if (error.result) {
                return error.result;
            }
            throw error;
        }
    }

    public async testSolution(filePath: string, testString?: string): Promise<string> {
        if (testString) {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", [await this.getLeetCodeBinaryPath(), "test", filePath, "-t", testString]);
        }
        return await this.executeCommandWithProgressEx("Submitting to LeetCode...", [await this.getLeetCodeBinaryPath(), "test", filePath]);
    }

    public async switchEndpoint(endpoint: string): Promise<string> {
        switch (endpoint) {
            case Endpoint.LeetCodeCN:
                return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "plugin", "-e", "leetcode.cn"]);
            case Endpoint.LeetCode:
            default:
                return await this.executeCommandEx([await this.getLeetCodeBinaryPath(), "plugin", "-d", "leetcode.cn"]);
        }
    }

    public async toggleFavorite(node: IProblem, addToFavorite: boolean): Promise<void> {
        const commandParams: string[] = [await this.getLeetCodeBinaryPath(), "star", node.id];
        if (!addToFavorite) {
            commandParams.push("-d");
        }
        await this.executeCommandWithProgressEx("Updating the favorite list...", commandParams);
    }

    public async getCompaniesAndTags(): Promise<{ companies: { [key: string]: string[] }, tags: { [key: string]: string[] } }> {
        // preprocess the plugin source
        const companiesTagsPath: string = path.join(this.leetCodeRootPath, "lib", "plugins", "company.js");
        const companiesTagsSrc: string = (await fse.readFile(companiesTagsPath, "utf8")).replace(
            "module.exports = plugin",
            "module.exports = { COMPONIES, TAGS }",
        );
        const { COMPONIES, TAGS } = requireFromString(companiesTagsSrc, companiesTagsPath);
        return { companies: COMPONIES, tags: TAGS };
    }

    public async spawn(args: string[], options: cp.SpawnOptions = {}): Promise<cp.ChildProcess> {
        const runtime: INodeRuntime = await this.getNodeRuntime();
        return spawnCommand(runtime.command, runtime.argsPrefix.concat(args), this.getSpawnOptions(runtime, options));
    }

    public dispose(): void {
        return;
    }

    private getNodePath(): string {
        const extensionConfig: WorkspaceConfiguration = workspace.getConfiguration("leetcode", null);
        const configuredPath: string = extensionConfig.get<string>("nodePath", "auto").trim();
        if (configuredPath.length >= 2 && configuredPath.startsWith('"') && configuredPath.endsWith('"')) {
            return configuredPath.slice(1, -1);
        }
        return configuredPath;
    }

    private getCliSessionDirectory(): { directory: string, endpoint: string } {
        const endpoint: string = workspace.getConfiguration("leetcode").get<string>("endpoint", Endpoint.LeetCode);
        const appDirectory: string = endpoint === Endpoint.LeetCodeCN ? "leetcode.cn" : "leetcode";
        const homeDirectory: string = process.env.HOME || process.env.USERPROFILE || os.homedir();
        return {
            directory: path.join(homeDirectory, ".lc", appDirectory),
            endpoint,
        };
    }

    private async getNodeRuntime(): Promise<INodeRuntime> {
        const configuredExecutable: string = this.getNodePath();
        const useAutomaticRuntime: boolean = !configuredExecutable ||
            configuredExecutable === "auto" ||
            configuredExecutable === "node";

        if (wsl.useWsl()) {
            const wslExecutable: string = useAutomaticRuntime
                ? "node"
                : await wsl.toWslPath(configuredExecutable);
            return {
                argsPrefix: [wslExecutable],
                command: "wsl",
                env: {},
                isBuiltIn: false,
            };
        }

        if (!useAutomaticRuntime) {
            if (!await fse.pathExists(configuredExecutable)) {
                return this.getBuiltInNodeRuntime();
            }
            return {
                argsPrefix: [],
                command: configuredExecutable,
                env: {},
                isBuiltIn: false,
            };
        }

        return this.getBuiltInNodeRuntime();
    }

    private getBuiltInNodeRuntime(): INodeRuntime {
        const versions: any = process.versions;
        const isElectronRuntime: boolean = Boolean(versions.electron);
        const supportsRunAsNodeFlag: boolean = shouldUseElectronRunAsNodeFlag(vscodeVersion);
        return {
            argsPrefix: isElectronRuntime && supportsRunAsNodeFlag ? ["--ms-enable-electron-run-as-node"] : [],
            command: process.execPath,
            env: isElectronRuntime ? { ELECTRON_RUN_AS_NODE: "1" } : {},
            isBuiltIn: true,
        };
    }

    private getSpawnOptions(runtime: INodeRuntime, options: cp.SpawnOptions): cp.SpawnOptions {
        return {
            ...options,
            env: { ...options.env, ...runtime.env, NODE_NO_WARNINGS: "1" },
            shell: false,
        };
    }

    private async executeCommandEx(args: string[], options: cp.SpawnOptions = {}): Promise<string> {
        const runtime: INodeRuntime = await this.getNodeRuntime();
        return await executeCommand(
            runtime.command,
            runtime.argsPrefix.concat(args),
            this.getSpawnOptions(runtime, options),
        );
    }

    private async executeCommandWithProgressEx(message: string, args: string[], options: cp.SpawnOptions = {}): Promise<string> {
        const runtime: INodeRuntime = await this.getNodeRuntime();
        return await executeCommandWithProgress(
            message,
            runtime.command,
            runtime.argsPrefix.concat(args),
            this.getSpawnOptions(runtime, options),
        );
    }

    private async removeOldCache(): Promise<void> {
        const oldPath: string = path.join(os.homedir(), ".lc");
        if (await fse.pathExists(oldPath)) {
            await fse.remove(oldPath);
        }
    }

}

export const leetCodeExecutor: LeetCodeExecutor = new LeetCodeExecutor();
