// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import { EventEmitter } from "events";
import * as vscode from "vscode";
import { getLeetCodeEndpoint } from "./commands/plugin";
import { globalState, UserDataType } from "./globalState";
import { leetCodeChannel } from "./leetCodeChannel";
import { leetCodeExecutor } from "./leetCodeExecutor";
import { queryUserData } from "./request/query-user-data";
import { Endpoint, IQuickItemEx, loginArgsMapping, urls, urlsCn, UserStatus } from "./shared";
import { ICliLoginOutputState, inspectCliLoginOutput } from "./utils/loginOutputUtils";
import { parseQuery } from "./utils/toolUtils";
import { DialogType, openUrl, promptForOpenOutputChannel } from "./utils/uiUtils";

class LeetCodeManager extends EventEmitter {
    private currentUser: string | undefined;
    private userStatus: UserStatus;

    constructor() {
        super();
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.handleUriSignIn = this.handleUriSignIn.bind(this);
    }

    public async getLoginStatus(): Promise<void> {
        try {
            if (globalState.getCookie()) {
                if (!await this.restoreLoginFromStoredCookie()) {
                    this.currentUser = undefined;
                    this.userStatus = UserStatus.SignedOut;
                }
            } else {
                await this.discardUnverifiedCliSession();
                this.currentUser = undefined;
                this.userStatus = UserStatus.SignedOut;
            }
        } catch (error) {
            leetCodeChannel.appendLine(`Unable to determine the LeetCode login status: ${this.getErrorMessage(error)}`);
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
        } finally {
            this.emit("statusChanged");
        }
    }

    public async handleUriSignIn(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification },
                async (progress: vscode.Progress<{}>) => {
                    progress.report({ message: "Fetching user data..." });
                    const queryParams: { [key: string]: string } = parseQuery(uri.query);
                    const cookie: string = queryParams["cookie"];
                    if (!cookie) {
                        await promptForOpenOutputChannel("Failed to get cookie. Please log in again", DialogType.error);
                        return;
                    }

                    await this.updateUserStatusWithCookie(cookie);
                },
            );
        } catch (error) {
            leetCodeChannel.appendLine(`Web authorization failed: ${this.getErrorMessage(error)}`);
            await promptForOpenOutputChannel(
                "Failed to log in. Please open the output channel for details",
                DialogType.error,
            );
        }
    }

    public async handleInputCookieSignIn(): Promise<void> {
        const cookie: string | undefined = await vscode.window.showInputBox({
            prompt: "Enter LeetCode Cookie",
            password: true,
            ignoreFocusOut: true,
            validateInput: (value: string): string | undefined => value ? undefined : "Cookie must not be empty",
        });

        if (!cookie) {
            return;
        }
        await this.updateUserStatusWithCookie(cookie);
    }

    public async signIn(): Promise<void> {
        const picks: Array<IQuickItemEx<string>> = [
            {
                label: "Web Authorization",
                detail: "Open browser to authorize login on the website",
                value: "WebAuth",
                description: "[Recommended]",
            },
            {
                label: "LeetCode Cookie",
                detail: "Use LeetCode cookie copied from browser to login",
                value: "Cookie",
            },
        ];

        const choice: IQuickItemEx<string> | undefined = await vscode.window.showQuickPick(picks);
        if (!choice) {
            return;
        }

        if (choice.value === "WebAuth") {
            openUrl(this.getAuthLoginUrl());
            return;
        }

        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: "Fetching user data..." },
                async () => this.handleInputCookieSignIn(),
            );
        } catch (error) {
            leetCodeChannel.appendLine(`Cookie login failed: ${this.getErrorMessage(error)}`);
            await promptForOpenOutputChannel(
                "Failed to log in. Please open the output channel for details",
                DialogType.error,
            );
        }
    }

    public async signOut(): Promise<void> {
        try {
            await leetCodeExecutor.signOut();
            await vscode.window.showInformationMessage("Successfully signed out.");
        } catch (error) {
            leetCodeChannel.appendLine(`LeetCode CLI sign out failed: ${this.getErrorMessage(error)}`);
        } finally {
            this.currentUser = undefined;
            this.userStatus = UserStatus.SignedOut;
            await globalState.removeAll();
            await leetCodeExecutor.clearLoginSession();
            this.emit("statusChanged");
        }
    }

    public getStatus(): UserStatus {
        return this.userStatus;
    }

    public getUser(): string | undefined {
        return this.currentUser;
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
        const childProc: cp.ChildProcess = await leetCodeExecutor.spawn([
            leetCodeBinaryPath,
            "user",
            loginArgsMapping.get("Cookie") ?? "",
        ]);

        return new Promise((resolve: () => void, reject: (error: Error) => void) => {
            let output: string = "";
            let sentCookie: boolean = false;
            let sentLogin: boolean = false;
            let settled: boolean = false;
            let timeout: NodeJS.Timeout;

            const resolveOnce = (): void => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve();
                }
            };
            const rejectOnce = (error: Error): void => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(error);
                }
            };

            timeout = setTimeout(() => {
                childProc.kill();
                rejectOnce(new Error("LeetCode CLI login timed out."));
            }, 45000);

            childProc.stdout?.on("data", (data: string | Buffer) => {
                const text: string = data.toString();
                output += text;
                leetCodeChannel.append(text);
                const state: ICliLoginOutputState = inspectCliLoginOutput(output);
                if (state.failed) {
                    childProc.stdin?.end();
                    childProc.kill();
                    rejectOnce(new Error("The LeetCode CLI rejected the cookie."));
                } else if (state.requestsLogin && !sentLogin) {
                    sentLogin = true;
                    childProc.stdin?.write(`${name}\n`);
                } else if (state.requestsCookie && !sentCookie) {
                    sentCookie = true;
                    childProc.stdin?.write(`${cookie}\n`);
                }
            });

            childProc.stderr?.on("data", (data: string | Buffer) => leetCodeChannel.append(data.toString()));
            childProc.on("error", rejectOnce);
            childProc.on("close", (code: number | null) => {
                const state: ICliLoginOutputState = inspectCliLoginOutput(output);
                if (code === 0 && state.succeeded) {
                    resolveOnce();
                } else {
                    rejectOnce(new Error(`LeetCode CLI login exited before completion with code ${code}.`));
                }
            });
        });
    }

    public async repairCliLogin(): Promise<boolean> {
        const cookie: string | undefined = globalState.getCookie();
        if (!cookie) {
            return false;
        }

        try {
            const data: UserDataType = await queryUserData(cookie);
            if (!data || !data.isSignedIn || !data.username) {
                leetCodeChannel.appendLine("The saved LeetCode cookie is invalid or expired; clearing the local session.");
                await globalState.removeAll();
                await this.discardUnverifiedCliSession();
                this.setSignedOut();
                return false;
            }

            await this.setCookieToCli(cookie, data.username);
            await leetCodeExecutor.deleteCache();
            await this.saveVerifiedLogin(cookie, data, false);
            leetCodeChannel.appendLine(`Rebuilt the LeetCode CLI session for ${data.username}.`);
            return true;
        } catch (error) {
            leetCodeChannel.appendLine(`Unable to rebuild the LeetCode CLI session: ${this.getErrorMessage(error)}`);
            return false;
        }
    }

    public markCliSessionUnavailable(): void {
        this.setSignedOut();
    }

    private async updateUserStatusWithCookie(cookie: string): Promise<void> {
        const data: UserDataType = await queryUserData(cookie);
        if (!data || !data.isSignedIn || !data.username) {
            throw new Error("The saved LeetCode cookie is invalid or expired.");
        }

        await this.setCookieToCli(cookie, data.username);
        await leetCodeExecutor.deleteCache();
        await this.saveVerifiedLogin(cookie, data);
        await vscode.window.showInformationMessage(`Successfully signed in as ${data.username}.`);
    }

    private async restoreLoginFromStoredCookie(): Promise<boolean> {
        const cookie: string | undefined = globalState.getCookie();
        if (!cookie) {
            return false;
        }

        try {
            const data: UserDataType = await queryUserData(cookie);
            if (!data || !data.isSignedIn || !data.username) {
                leetCodeChannel.appendLine("The saved LeetCode cookie is invalid or expired; clearing the local session.");
                await globalState.removeAll();
                await this.discardUnverifiedCliSession();
                return false;
            }

            await this.setCookieToCli(cookie, data.username);
            if (globalState.needsCliSessionMigration()) {
                await leetCodeExecutor.deleteCache();
            }
            await this.saveVerifiedLogin(cookie, data, false);
            leetCodeChannel.appendLine(`Restored LeetCode login for ${data.username} from secure storage.`);
            return true;
        } catch (error) {
            leetCodeChannel.appendLine(`Unable to restore the saved LeetCode login: ${this.getErrorMessage(error)}`);
            return false;
        }
    }

    private async saveVerifiedLogin(
        cookie: string,
        data: UserDataType,
        emitStatusChanged: boolean = true,
    ): Promise<void> {
        await globalState.setCookie(cookie);
        await globalState.setUserStatus(data);
        await globalState.markCliSessionCurrent();
        this.currentUser = data.username;
        this.userStatus = UserStatus.SignedIn;
        if (emitStatusChanged) {
            this.emit("statusChanged");
        }
    }

    private async discardUnverifiedCliSession(): Promise<void> {
        try {
            await leetCodeExecutor.clearLoginSession();
        } catch (error) {
            leetCodeChannel.appendLine(`Unable to clear the unverified LeetCode CLI session: ${this.getErrorMessage(error)}`);
        }
    }

    private setSignedOut(): void {
        this.currentUser = undefined;
        this.userStatus = UserStatus.SignedOut;
        this.emit("statusChanged");
    }

    private getErrorMessage(error: any): string {
        return error instanceof Error ? error.message : String(error);
    }
}

export const leetCodeManager: LeetCodeManager = new LeetCodeManager();
