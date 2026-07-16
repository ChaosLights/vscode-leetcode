// Copyright (c) leo.zhao. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";

const CookieKey = "leetcode-cookie";
const UserStatusKey = "leetcode-user-status";
const CliSessionVersionKey = "leetcode-cli-session-version";
const CurrentCliSessionVersion = 2;

export type UserDataType = {
    isSignedIn: boolean;
    isPremium: boolean;
    username: string;
    avatar: string;
    isVerified?: boolean;
};

class GlobalState {
    private _state: vscode.Memento;
    private _secrets: vscode.SecretStorage;
    private _cookie: string | undefined;
    private _userStatus: UserDataType | undefined;

    public async initialize(context: vscode.ExtensionContext): Promise<void> {
        this._state = context.globalState;
        this._secrets = context.secrets;
        this._cookie = await this._secrets.get(CookieKey);

        const legacyCookie: string | undefined = this._state.get<string>(CookieKey);
        if (!this._cookie && legacyCookie) {
            this._cookie = legacyCookie;
            await this._secrets.store(CookieKey, legacyCookie);
        }
        if (legacyCookie) {
            await this._state.update(CookieKey, undefined);
        }
    }

    public async setCookie(cookie: string): Promise<void> {
        this._cookie = cookie;
        await this._secrets.store(CookieKey, cookie);
    }

    public getCookie(): string | undefined {
        return this._cookie;
    }

    public async setUserStatus(userStatus: UserDataType): Promise<void> {
        this._userStatus = userStatus;
        await this._state.update(UserStatusKey, this._userStatus);
    }

    public getUserStatus(): UserDataType | undefined {
        return this._userStatus ?? this._state.get(UserStatusKey);
    }

    public needsCliSessionMigration(): boolean {
        return this._state.get<number>(CliSessionVersionKey) !== CurrentCliSessionVersion;
    }

    public async markCliSessionCurrent(): Promise<void> {
        await this._state.update(CliSessionVersionKey, CurrentCliSessionVersion);
    }

    public async removeCookie(): Promise<void> {
        this._cookie = undefined;
        await this._secrets.delete(CookieKey);
        await this._state.update(CookieKey, undefined);
    }

    public async removeAll(): Promise<void> {
        await this.removeCookie();
        this._userStatus = undefined;
        await this._state.update(UserStatusKey, undefined);
        await this._state.update(CliSessionVersionKey, undefined);
    }
}

export const globalState: GlobalState = new GlobalState();
