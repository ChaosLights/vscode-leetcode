// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";

interface IExecError extends Error {
    result?: string;
}

const maxCommandOutputBytes: number = 25 * 1024 * 1024;
const commandTimeoutMilliseconds: number = 3 * 60 * 1000;

export async function executeCommand(
    command: string,
    args: string[],
    options: cp.SpawnOptions = { shell: true },
    cancellationToken?: vscode.CancellationToken,
): Promise<string> {
    return new Promise((resolve: (res: string) => void, reject: (e: Error) => void): void => {
        let result: string = "";
        let outputBytes: number = 0;
        let settled: boolean = false;

        const childProc: cp.ChildProcess = spawnCommand(command, args, options);
        let timeout: NodeJS.Timeout | undefined;
        let cancellationListener: vscode.Disposable | undefined;

        const disposeResources = (): void => {
            if (timeout) {
                clearTimeout(timeout);
            }
            cancellationListener?.dispose();
        };
        const resolveOnce = (value: string): void => {
            if (!settled) {
                settled = true;
                disposeResources();
                resolve(value);
            }
        };
        const rejectOnce = (error: Error): void => {
            if (!settled) {
                settled = true;
                disposeResources();
                reject(error);
            }
        };
        timeout = setTimeout(() => {
            childProc.kill();
            rejectOnce(new Error("LeetCode CLI command timed out after 3 minutes."));
        }, commandTimeoutMilliseconds);
        cancellationListener = cancellationToken?.onCancellationRequested(() => {
            childProc.kill();
            rejectOnce(new Error("LeetCode CLI command was canceled."));
        });

        childProc.stdout?.on("data", (data: string | Buffer) => {
            const text: string = data.toString();
            outputBytes += Buffer.byteLength(text, "utf8");
            if (outputBytes > maxCommandOutputBytes) {
                childProc.kill();
                rejectOnce(new Error("LeetCode CLI output exceeded the 25 MB safety limit."));
                return;
            }
            result = result.concat(text);
            leetCodeChannel.append(text);
        });

        childProc.stderr?.on("data", (data: string | Buffer) => {
            const text: string = data.toString();
            outputBytes += Buffer.byteLength(text, "utf8");
            if (outputBytes > maxCommandOutputBytes) {
                childProc.kill();
                rejectOnce(new Error("LeetCode CLI output exceeded the 25 MB safety limit."));
                return;
            }
            leetCodeChannel.append(text);
        });

        childProc.on("error", rejectOnce);

        childProc.on("close", (code: number) => {
            if (settled) {
                return;
            }
            if (code !== 0 || /^\s*(?:\[ERROR\]|ERROR\b)/m.test(result)) {
                const error: IExecError = new Error(`LeetCode CLI command failed with exit code "${code}".`);
                if (result) {
                    error.result = result; // leetcode-cli may print useful content by exit with error code
                }
                rejectOnce(error);
            } else {
                resolveOnce(result);
            }
        });
    });
}

export function spawnCommand(command: string, args: string[], options: cp.SpawnOptions = {}): cp.ChildProcess {
    return cp.spawn(command, args, {
        ...options,
        env: createEnvOption(options.env),
    });
}

export async function executeCommandWithProgress(message: string, command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
    return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, cancellable: true },
        async (p: vscode.Progress<{}>, token: vscode.CancellationToken): Promise<string> => {
            p.report({ message });
            return await executeCommand(command, args, options, token);
        },
    );
}

// Clone process.env, apply command-specific overrides, and add the configured HTTP proxy.
export function createEnvOption(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    const proxy: string | undefined = getHttpAgent();
    if (proxy) {
        env.http_proxy = proxy;
    }
    return env;
}

function getHttpAgent(): string | undefined {
    return vscode.workspace.getConfiguration("http").get<string>("proxy");
}
