// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import {
    IPairingCandidateComment,
    IPairingState,
    IPairingTarget,
    parsePairingState,
    renderPairingIssueBody,
} from "./pairingProtocol";

interface IGitHubIssueResponse {
    body: string | null;
}

interface IGitHubCommentResponse {
    id: number;
    created_at: string;
    body: string;
}

export interface ICodespaceSummary {
    name: string;
    state: string;
    lastUsedAt: string;
}

export class GitHubCli {
    public async getLogin(): Promise<string> {
        const login: string = (await this.run(["api", "user", "--jq", ".login"])).trim();
        if (!/^[A-Za-z0-9-]{1,100}$/.test(login)) {
            throw new Error("GitHub CLI returned an invalid login. Run 'gh auth login' again.");
        }
        return login;
    }

    public async getIssueState(target: IPairingTarget): Promise<IPairingState> {
        const response: IGitHubIssueResponse = this.parseJson<IGitHubIssueResponse>(
            await this.run(["api", this.issueEndpoint(target)]),
            "pairing issue",
        );
        return parsePairingState(response.body);
    }

    public async updateIssueState(target: IPairingTarget, state: IPairingState): Promise<void> {
        await this.run([
            "api",
            "--method", "PATCH",
            this.issueEndpoint(target),
            "-f", `body=${renderPairingIssueBody(state)}`,
            "--silent",
        ]);
    }

    public async postCandidate(target: IPairingTarget, body: string): Promise<IPairingCandidateComment> {
        const response: IGitHubCommentResponse = this.parseJson<IGitHubCommentResponse>(
            await this.run([
                "api",
                "--method", "POST",
                `${this.issueEndpoint(target)}/comments`,
                "-f", `body=${body}`,
            ]),
            "candidate comment",
        );
        return this.toCandidateComment(response);
    }

    public async listCandidates(target: IPairingTarget): Promise<IPairingCandidateComment[]> {
        const pages: IGitHubCommentResponse[][] = this.parseJson<IGitHubCommentResponse[][]>(
            await this.run([
                "api",
                `${this.issueEndpoint(target)}/comments?per_page=100`,
                "--paginate",
                "--slurp",
            ]),
            "candidate comments",
        );
        return pages.reduce(
            (all: IPairingCandidateComment[], page: IGitHubCommentResponse[]) =>
                all.concat(page.map((comment: IGitHubCommentResponse) => this.toCandidateComment(comment))),
            [],
        );
    }

    public async listCodespaces(repository: string): Promise<ICodespaceSummary[]> {
        const result: ICodespaceSummary[] = this.parseJson<ICodespaceSummary[]>(
            await this.run([
                "codespace", "list",
                "-R", repository,
                "--limit", "100",
                "--json", "name,state,lastUsedAt",
            ], 60_000),
            "Codespaces list",
        );
        return result.filter((entry: ICodespaceSummary) =>
            typeof entry.name === "string" && typeof entry.state === "string" && typeof entry.lastUsedAt === "string",
        );
    }

    public async createCodespace(target: IPairingTarget): Promise<string> {
        const output: string = await this.run([
            "codespace", "create",
            "-R", target.repository,
            "-b", target.branch,
            "--display-name", "LeetCode Pairing",
            "--idle-timeout", "30m",
            "--retention-period", "72h",
        ], 5 * 60_000);
        const name: string = output.trim().split(/\r?\n/).pop() || "";
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("GitHub CLI created a Codespace but did not return its name.");
        }
        return name;
    }

    public async openCodespace(name: string): Promise<void> {
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("Refusing to open an invalid Codespace name.");
        }
        await this.run(["codespace", "code", "-c", name], 2 * 60_000);
    }

    private async run(args: string[], timeoutMs: number = 30_000): Promise<string> {
        return await new Promise<string>((resolve, reject) => {
            cp.execFile("gh", args, {
                windowsHide: true,
                timeout: timeoutMs,
                maxBuffer: 8 * 1024 * 1024,
                encoding: "utf8",
            }, (error: cp.ExecFileException | null, stdout: string, stderr: string) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                const detail: string = this.safeError(stderr || error.message);
                reject(new Error(`GitHub CLI failed: ${detail}`));
            });
        });
    }

    private issueEndpoint(target: IPairingTarget): string {
        return `repos/${target.repository}/issues/${target.issueNumber}`;
    }

    private parseJson<T>(value: string, description: string): T {
        try {
            return JSON.parse(value) as T;
        } catch (_error) {
            throw new Error(`GitHub CLI returned invalid JSON for ${description}.`);
        }
    }

    private toCandidateComment(comment: IGitHubCommentResponse): IPairingCandidateComment {
        return { id: comment.id, createdAt: comment.created_at, body: comment.body };
    }

    private safeError(value: string): string {
        const firstLine: string = value.trim().split(/\r?\n/)[0] || "unknown error";
        return firstLine.replace(/https:\/\/\S+/g, "[redacted URL]").substring(0, 500);
    }
}
