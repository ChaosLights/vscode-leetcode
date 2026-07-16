// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export interface ICliCookieParts {
    sessionCSRF: string;
    sessionId: string;
}

export interface ICliUserRecord extends ICliCookieParts {
    hash?: string;
    login: string;
    name: string;
    paid: boolean;
}

export function parseCliCookie(cookie: string): ICliCookieParts {
    const values: { [key: string]: string } = {};
    for (const item of cookie.split(";")) {
        const separator: number = item.indexOf("=");
        if (separator < 0) {
            continue;
        }
        const key: string = item.slice(0, separator).trim().toLowerCase();
        const value: string = item.slice(separator + 1).trim();
        if (key && value) {
            values[key] = value;
        }
    }

    const sessionId: string = values["leetcode_session"];
    const sessionCSRF: string = values["csrftoken"];
    if (!sessionId || !sessionCSRF) {
        throw new Error("The verified cookie does not contain both LEETCODE_SESSION and csrftoken.");
    }
    return { sessionCSRF, sessionId };
}

export function createCliUserRecord(
    cookie: string,
    username: string,
    isPremium: boolean,
    favoriteHash?: string,
): ICliUserRecord {
    const parts: ICliCookieParts = parseCliCookie(cookie);
    const record: ICliUserRecord = {
        login: username,
        name: username,
        paid: isPremium,
        sessionCSRF: parts.sessionCSRF,
        sessionId: parts.sessionId,
    };
    if (favoriteHash) {
        record.hash = favoriteHash;
    }
    return record;
}

export function countCliProblems(output: string): number {
    const problemPattern: RegExp = /^(.)\s(.{1,2})\s(.)\s\[\s*(\d*)\s*\]\s*(.*)\s*(Easy|Medium|Hard)\s*\((\s*\d+\.\d+ %)\)/;
    return output.split("\n").filter((line: string) => problemPattern.test(line)).length;
}
