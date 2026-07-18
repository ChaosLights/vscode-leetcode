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

interface ICodespaceResponse {
    state: string;
}

interface ICodespaceMachinesResponse {
    machines: ICodespaceMachine[];
}

export interface ICodespaceMachine {
    name: string;
    display_name: string;
    operating_system: string;
    cpus: number;
    memory_in_bytes: number;
    storage_in_bytes: number;
}

export interface ICodespaceSummary {
    name: string;
    state: string;
    lastUsedAt: string;
}

export function selectCodespaceMachine(machines: ICodespaceMachine[]): ICodespaceMachine | undefined {
    return machines
        .filter((machine: ICodespaceMachine) =>
            machine.operating_system.toLowerCase() === "linux" &&
            /^[A-Za-z0-9-]{1,100}$/.test(machine.name) &&
            Number.isFinite(machine.cpus) &&
            Number.isFinite(machine.memory_in_bytes) &&
            Number.isFinite(machine.storage_in_bytes),
        )
        .sort((left: ICodespaceMachine, right: ICodespaceMachine) =>
            left.cpus - right.cpus ||
            left.memory_in_bytes - right.memory_in_bytes ||
            left.storage_in_bytes - right.storage_in_bytes ||
            left.name.localeCompare(right.name),
        )[0];
}

export function summarizeGitHubCliError(stderr: string, fallback: string): string {
    const statusLinePattern: RegExp = /^(?:[✓✔]\s*)?Codespaces usage for this repository is paid for by\b/i;
    const stderrLines: string[] = stderr
        .trim()
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !statusLinePattern.test(line));
    const detail: string = stderrLines.length > 0 ? stderrLines.join(" | ") : fallback.trim();
    return (detail || "unknown error")
        .replace(/https:\/\/\S+/g, "[redacted URL]")
        .replace(/\s+/g, " ")
        .substring(0, 500);
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
        const response: ICodespaceMachinesResponse = this.parseJson<ICodespaceMachinesResponse>(
            await this.run(["api", `repos/${target.repository}/codespaces/machines`], 60_000),
            "Codespace machines",
        );
        const machine: ICodespaceMachine | undefined = Array.isArray(response.machines)
            ? selectCodespaceMachine(response.machines)
            : undefined;
        if (!machine) {
            throw new Error("GitHub did not return an available Linux Codespace machine for this account.");
        }
        const output: string = await this.run([
            "codespace", "create",
            "-R", target.repository,
            "-b", target.branch,
            "--machine", machine.name,
            "--default-permissions",
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

    public async getCodespaceState(name: string): Promise<string> {
        this.validateCodespaceName(name);
        const response: ICodespaceResponse = this.parseJson<ICodespaceResponse>(
            await this.run(["api", `user/codespaces/${name}`], 60_000),
            "Codespace state",
        );
        if (typeof response.state !== "string" || !/^[A-Za-z]+$/.test(response.state)) {
            throw new Error("GitHub CLI returned an invalid Codespace state.");
        }
        return response.state;
    }

    public async startCodespace(name: string): Promise<void> {
        this.validateCodespaceName(name);
        await this.run([
            "api", "--method", "POST", `user/codespaces/${name}/start`, "--silent",
        ], 60_000);
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
                const detail: string = summarizeGitHubCliError(stderr, error.message);
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

    private validateCodespaceName(name: string): void {
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("Refusing to use an invalid Codespace name.");
        }
    }

}
