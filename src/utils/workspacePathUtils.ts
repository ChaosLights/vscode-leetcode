// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as path from "path";

export interface IUserWorkspaceFolderMap {
    [username: string]: string;
}

function normalizeSlashes(value: string): string {
    return value.replace(/\\/g, "/");
}

function normalizeRelativePath(value: string): string | undefined {
    const normalized: string = path.posix.normalize(normalizeSlashes(value));
    if (normalized === ".") {
        return "";
    }
    if (
        path.posix.isAbsolute(normalized) ||
        /^[a-z]:\//i.test(normalized) ||
        normalized === ".." ||
        normalized.startsWith("../")
    ) {
        return undefined;
    }
    return normalized;
}

export function resolveUserWorkspaceFolder(
    foldersByUser: IUserWorkspaceFolderMap,
    username: string | undefined,
    fallback: string,
): string {
    const configuredUsers: string[] = Object.keys(foldersByUser);
    if (!configuredUsers.length) {
        return fallback.trim();
    }
    if (!username) {
        throw new Error("Sign in to LeetCode before resolving leetcode.workspaceFolderByUser.");
    }

    const exactValue: string | undefined = foldersByUser[username];
    if (typeof exactValue === "string") {
        return exactValue.trim();
    }

    const caseInsensitiveMatches: string[] = configuredUsers.filter(
        (configuredUser: string) => configuredUser.toLocaleLowerCase() === username.toLocaleLowerCase(),
    );
    if (caseInsensitiveMatches.length === 1) {
        const matchedValue: string = foldersByUser[caseInsensitiveMatches[0]];
        return matchedValue.trim();
    }

    throw new Error(`No LeetCode workspace folder is configured for signed-in user '${username}'.`);
}

export function resolveRemoteWorkspaceRelativePath(
    configuredPath: string,
    remoteRootPath: string,
    remoteFolderName: string,
    allowWorkspaceNameFallback: boolean,
): string | undefined {
    const slashPath: string = normalizeSlashes(configuredPath.trim());
    if (!slashPath) {
        return "";
    }
    if (!path.posix.isAbsolute(slashPath)) {
        return normalizeRelativePath(slashPath);
    }

    const normalizedRoot: string = path.posix.normalize(normalizeSlashes(remoteRootPath));
    const normalizedConfiguredPath: string = path.posix.normalize(slashPath);
    const directRelativePath: string = path.posix.relative(normalizedRoot, normalizedConfiguredPath);
    const directResult: string | undefined = normalizeRelativePath(directRelativePath);
    if (directResult !== undefined) {
        return directResult;
    }

    if (!allowWorkspaceNameFallback) {
        return undefined;
    }

    const segments: string[] = normalizedConfiguredPath.split("/").filter((segment: string) => Boolean(segment));
    const workspaceSegmentIndex: number = segments.lastIndexOf(remoteFolderName);
    if (workspaceSegmentIndex < 0) {
        return undefined;
    }
    return normalizeRelativePath(segments.slice(workspaceSegmentIndex + 1).join("/"));
}
