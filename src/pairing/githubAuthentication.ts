// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import * as vscode from "vscode";
import { GitHubTokenProvider, summarizeGitHubError } from "./githubCli";

const cachedTokenSecretKey: string = "leetcode.pairing.githubToken.v1";
const githubScopes: readonly string[] = ["repo", "codespace"];

export function createGitHubTokenProvider(secrets: vscode.SecretStorage): GitHubTokenProvider {
    let tokenPromise: Promise<string> | undefined;
    return async (forceRefresh: boolean): Promise<string> => {
        if (forceRefresh) {
            tokenPromise = undefined;
            await secrets.delete(cachedTokenSecretKey);
        }
        if (!tokenPromise) {
            tokenPromise = resolveGitHubToken(secrets, forceRefresh).catch((error: unknown) => {
                tokenPromise = undefined;
                throw error;
            });
        }
        return tokenPromise;
    };
}

async function resolveGitHubToken(secrets: vscode.SecretStorage, forceRefresh: boolean): Promise<string> {
    // The Codespaces extension normally leaves a matching GitHub session in VS Code.
    // Reusing it avoids starting any console process at all.
    if (!forceRefresh) {
        try {
            const session: vscode.AuthenticationSession | undefined = await vscode.authentication.getSession(
                "github",
                githubScopes,
                { silent: true },
            );
            if (session?.accessToken) {
                return session.accessToken;
            }
        } catch (_error) {
            // The built-in provider may not be registered yet in a fresh profile.
            // The launcher-authenticated CLI fallback below remains available.
        }
        const cached: string | undefined = await secrets.get(cachedTokenSecretKey);
        if (cached) {
            return cached;
        }
    }

    // The launcher already bootstraps and authorizes GitHub CLI. This is a one-time
    // fallback per VS Code profile, never a polling or heartbeat subprocess.
    const token: string = (await readGitHubCliToken()).trim();
    await secrets.store(cachedTokenSecretKey, token);
    return token;
}

async function readGitHubCliToken(): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
        cp.execFile("gh", ["auth", "token", "--hostname", "github.com"], {
            windowsHide: true,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
        }, (error: cp.ExecFileException | null, stdout: string, stderr: string) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            const detail: string = summarizeGitHubError(stderr, error.message);
            reject(new Error(`Unable to read GitHub credentials: ${detail}`));
        });
    });
}
