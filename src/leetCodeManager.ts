// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { Endpoint, IQuickItemEx, loginArgsMapping, urls, urlsCn, UserStatus } from "./shared";
import { createEnvOption } from "./utils/cpUtils";
import { DialogType, openUrl, promptForOpenOutputChannel } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";
import { getLeetCodeEndpoint } from "./commands/plugin";
import { globalState } from "./globalState";
import { queryUserData } from "./request/query-user-data";
import { parseQuery } from "./utils/toolUtils";

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;
    private readonly successRegex: RegExp = /(?:.*)Successfully .*login as (.*)/i;
    private readonly failRegex: RegExp = /.*\[ERROR\].*/i;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.handleUriSignIn = this.handleUriSignIn.bind(this);
    }

    public async getLoginStatus(): Promise<void> {
        try {
            const result: string = await leetCodeExecutor.getUserInfo();
            this.currentUser = this.tryParseUserName(result);
            this.userStatus = UserStatus.SignedIn;
        } catch (error) {
            if (!await this.restoreLoginFromStoredCookie()) {
                this.currentUser = undefined;
                this.userStatus = UserStatus.SignedOut;
            }
        } finally {
            this.emit("statusChanged");
        }
    }

    private async updateUserStatusWithCookie(cookie: string): Promise<void> {
        const data = await queryUserData(cookie);
        if (!data || !data.isSignedIn || !data.username) {
            throw new Error("The saved LeetCode cookie is invalid or expired.");
        }
        await globalState.setCookie(cookie);
        await globalState.setUserStatus(data);
        await this.setCookieToCli(cookie, data.username);
        vscode.window.showInformationMessage(`Successfully signed in as ${data.username}.`);
        this.currentUser = data.username;
        this.userStatus = UserStatus.SignedIn;
        this.emit("statusChanged");
    }

    public async handleUriSignIn(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress: vscode.Progress<{}>) => {
                progress.report({ message: "Fetching user data..." });
                const queryParams = parseQuery(uri.query);
                const cookie = queryParams["cookie"];
                if (!cookie) {
                    promptForOpenOutputChannel(`Failed to get cookie. Please log in again`, DialogType.error);
                    return;
                }

                await this.updateUserStatusWithCookie(cookie)

            });
        } catch (error) {
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async handleInputCookieSignIn(): Promise<void> {
        const cookie: string | undefined = await vscode.window.showInputBox({
            prompt: 'Enter LeetCode Cookie',
            password: true,
            ignoreFocusOut: true,
            validateInput: (s: string): string | undefined =>
                s ? undefined : 'Cookie must not be empty',
        })

        if (!cookie) {
            return
        }
        await this.updateUserStatusWithCookie(cookie)
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = []
        picks.push(
            {
                label: 'Web Authorization',
                detail: 'Open browser to authorize login on the website',
                value: 'WebAuth',
                description: '[Recommended]'
            },
            {
                label: 'LeetCode Cookie',
                detail: 'Use LeetCode cookie copied from browser to login',
                value: 'Cookie',
            }
        )

        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks)
        if (!choice) {
            return
        }
        const loginMethod: string = choice.value

        if (loginMethod === 'WebAuth') {
            openUrl(this.getAuthLoginUrl())
            return
        }

        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Fetching user data..." }, async () => {
                await this.handleInputCookieSignIn()
            });
        } catch (error) {
            promptForOpenOutputChannel(`Failed to log in. Please open the output channel for details`, DialogType.error);
        }
    }

    public async signOut(): Promise<void> {
        try {
            await leetCodeExecutor.signOut();
            vscode.window.showInformationMessage("Successfully signed out.");
        } catch (error) {
            leetCodeChannel.appendLine(`LeetCode CLI sign out failed: ${error.toString()}`);
        } finally {
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            await globalState.removeAll();
            this.emit("statusChanged");
        }
    }

    public getStatus(): UserStatus {
        return this.userStatus;
    }

    public getUser(): string | undefined {
        return this.currentUser;
    }

    private tryParseUserName(output: string): string {
        const reg: RegExp = /^\s*.\s*(.+?)\s*https:\/\/leetcode/m;
        const match: RegExpMatchArray | null = output.match(reg);
        if (match && match.length === 2) {
            return match[1].trim();
        }

        return "Unknown";
    }

    public getAuthLoginUrl(): string {
        switch (getLeetCodeEndpoint()) {
            case Endpoint.LeetCodeCN:
                return urlsCn.authLoginUrl;
            case Endpoint.LeetCode:
            default:
                return urls.authLoginUrl;
        }
    }

    public async setCookieToCli(cookie: string, name: string): Promise<void> {
        const leetCodeBinaryPath: string = await leetCodeExecutor.getLeetCodeBinaryPath();
        return new Promise((resolve: (res: void) => void, reject: (e: Error) => void) => {
            let settled: boolean = false;

            const resolveOnce = (): void => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            const rejectOnce = (error: Error): void => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };

            const childProc: cp.ChildProcess = wsl.useWsl()
                ? cp.spawn("wsl", [leetCodeExecutor.node, leetCodeBinaryPath, "user", loginArgsMapping.get("Cookie") ?? ""], {
                      shell: true,
                  })
                : cp.spawn(leetCodeExecutor.node, [leetCodeBinaryPath, "user", loginArgsMapping.get("Cookie") ?? ""], {
                      shell: true,
                      env: createEnvOption(),
                  });

            childProc.stdout?.on("data", async (data: string | Buffer) => {
                data = data.toString();
                leetCodeChannel.append(data);
                const successMatch: RegExpMatchArray | null = data.match(this.successRegex);
                if (successMatch && successMatch[1]) {
                    childProc.stdin?.end();
                    return resolveOnce();
                } else if (data.match(this.failRegex)) {
                    childProc.stdin?.end();
                    return rejectOnce(new Error("Failed to restore the LeetCode CLI login."));
                } else if (data.match(/login: /)) {
                    childProc.stdin?.write(`${name}\n`);
                } else if (data.match(/cookie: /)) {
                    childProc.stdin?.write(`${cookie}\n`);
                }
            });

            childProc.stderr?.on("data", (data: string | Buffer) => leetCodeChannel.append(data.toString()));

            childProc.on("error", rejectOnce);
            childProc.on("close", (code: number | null) => {
                if (!settled) {
                    rejectOnce(new Error(`LeetCode CLI login exited before completion with code ${code}.`));
                }
            });
        });
    }

    private async restoreLoginFromStoredCookie(): Promise<boolean> {
        const cookie: string | undefined = globalState.getCookie();
        if (!cookie) {
            return false;
        }

        try {
            const data = await queryUserData();
            if (!data || !data.isSignedIn || !data.username) {
                return false;
            }
            await globalState.setUserStatus(data);
            await this.setCookieToCli(cookie, data.username);
            this.currentUser = data.username;
            this.userStatus = UserStatus.SignedIn;
            leetCodeChannel.appendLine(`Restored LeetCode login for ${data.username} from secure storage.`);
            return true;
        } catch (error) {
            leetCodeChannel.appendLine(`Unable to restore the saved LeetCode login: ${error.toString()}`);
            return false;
        }
    }
}

export const leetCodeManager: LeetCodeManager = new LeetCodeManager();
