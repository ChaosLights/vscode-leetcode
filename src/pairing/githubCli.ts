// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import {
    IPairingCandidateComment,
    IPairingState,
    IPairingTarget,
    parseCandidateComment,
    parsePairingState,
    renderPairingIssueBody,
} from "./pairingProtocol";

interface IGitHubIssueResponse {
    body: string | null;
}

interface IGitHubUserResponse {
    login: string;
}

interface IGitHubCommentResponse {
    id: number;
    created_at: string;
    updated_at: string;
    body: string;
    user: {
        login: string;
    } | null;
}

interface ICodespaceResponse {
    name: string;
    state: string;
    last_used_at?: string;
}

interface ICodespacesResponse {
    codespaces: ICodespaceResponse[];
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

export interface IGitHubHttpRequest {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    endpoint: string;
    token: string;
    timeoutMs: number;
    data?: unknown;
    params?: { [name: string]: string | number };
}

export interface IGitHubHttpResponse {
    status: number;
    data: unknown;
}

export type GitHubTokenProvider = (forceRefresh: boolean) => Promise<string>;
export type GitHubHttpRequester = (request: IGitHubHttpRequest) => Promise<IGitHubHttpResponse>;

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

export function summarizeGitHubError(detail: string, fallback: string): string {
    const statusLinePattern: RegExp = /^(?:[✓✔]\s*)?Codespaces usage for this repository is paid for by\b/i;
    const detailLines: string[] = detail
        .trim()
        .split(/\r?\n/)
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && !statusLinePattern.test(line));
    const summary: string = detailLines.length > 0 ? detailLines.join(" | ") : fallback.trim();
    return (summary || "unknown error")
        .replace(/https:\/\/\S+/g, "[redacted URL]")
        .replace(/(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted token]")
        .replace(/\s+/g, " ")
        .substring(0, 500);
}

// Retain the old export for callers and tests built against earlier releases.
export const summarizeGitHubCliError: typeof summarizeGitHubError = summarizeGitHubError;

export class GitHubCli {
    private accessTokenPromise: Promise<string> | undefined;

    public constructor(
        private readonly tokenProvider: GitHubTokenProvider,
        private readonly requester: GitHubHttpRequester = defaultGitHubHttpRequest,
    ) { }

    public async getLogin(): Promise<string> {
        const response: IGitHubUserResponse = await this.requestJson<IGitHubUserResponse>("GET", "user");
        const login: string = response.login;
        if (!/^[A-Za-z0-9-]{1,100}$/.test(login)) {
            throw new Error("GitHub returned an invalid login. Sign into GitHub again.");
        }
        return login;
    }

    public async getIssueState(target: IPairingTarget): Promise<IPairingState> {
        const response: IGitHubIssueResponse = await this.requestJson<IGitHubIssueResponse>(
            "GET",
            this.issueEndpoint(target),
        );
        return parsePairingState(response.body);
    }

    public async updateIssueState(target: IPairingTarget, state: IPairingState): Promise<void> {
        await this.requestJson("PATCH", this.issueEndpoint(target), {
            body: renderPairingIssueBody(state),
        });
    }

    public async upsertCandidate(
        target: IPairingTarget,
        login: string,
        body: string,
    ): Promise<IPairingCandidateComment> {
        const reusable: IPairingCandidateComment[] = (await this.listCandidates(target))
            .filter((comment: IPairingCandidateComment) => {
                const candidate = parseCandidateComment(comment.body);
                return comment.authorLogin.toLowerCase() === login.toLowerCase() &&
                    candidate?.login.toLowerCase() === login.toLowerCase();
            })
            .sort((left: IPairingCandidateComment, right: IPairingCandidateComment) => left.id - right.id);
        if (reusable.length > 0) {
            const canonical: IPairingCandidateComment = reusable[0];
            const updatedResponse: IGitHubCommentResponse = await this.requestJson<IGitHubCommentResponse>(
                "PATCH",
                this.commentEndpoint(target, canonical.id),
                { body },
            );
            await Promise.all(reusable.slice(1).map(async (duplicate: IPairingCandidateComment) => {
                try {
                    await this.requestJson("DELETE", this.commentEndpoint(target, duplicate.id));
                } catch (_error) {
                    // Duplicate cleanup is cosmetic and must not interrupt host election.
                }
            }));
            return this.toCandidateComment(updatedResponse);
        }

        const createdResponse: IGitHubCommentResponse = await this.requestJson<IGitHubCommentResponse>(
            "POST",
            `${this.issueEndpoint(target)}/comments`,
            { body },
        );
        return this.toCandidateComment(createdResponse);
    }

    public async listCandidates(target: IPairingTarget): Promise<IPairingCandidateComment[]> {
        const comments: IPairingCandidateComment[] = [];
        for (let page: number = 1; page <= 100; page++) {
            const response: IGitHubCommentResponse[] = await this.requestJson<IGitHubCommentResponse[]>(
                "GET",
                `${this.issueEndpoint(target)}/comments`,
                undefined,
                { per_page: 100, page },
            );
            comments.push(...response.map((comment: IGitHubCommentResponse) => this.toCandidateComment(comment)));
            if (response.length < 100) {
                return comments;
            }
        }
        throw new Error("The pairing issue has too many comments to scan safely.");
    }

    public async listCodespaces(repository: string): Promise<ICodespaceSummary[]> {
        this.validateRepository(repository);
        const response: ICodespacesResponse = await this.requestJson<ICodespacesResponse>(
            "GET",
            `repos/${repository}/codespaces`,
            undefined,
            { per_page: 100 },
            60_000,
        );
        if (!Array.isArray(response.codespaces)) {
            throw new Error("GitHub returned an invalid Codespaces list.");
        }
        return response.codespaces
            .filter((entry: ICodespaceResponse) =>
                typeof entry.name === "string" && typeof entry.state === "string" &&
                typeof entry.last_used_at === "string",
            )
            .map((entry: ICodespaceResponse) => ({
                name: entry.name,
                state: entry.state,
                lastUsedAt: entry.last_used_at || "",
            }));
    }

    public async createCodespace(target: IPairingTarget): Promise<string> {
        const response: ICodespaceMachinesResponse = await this.requestJson<ICodespaceMachinesResponse>(
            "GET",
            `repos/${target.repository}/codespaces/machines`,
            undefined,
            undefined,
            60_000,
        );
        const machine: ICodespaceMachine | undefined = Array.isArray(response.machines)
            ? selectCodespaceMachine(response.machines)
            : undefined;
        if (!machine) {
            throw new Error("GitHub did not return an available Linux Codespace machine for this account.");
        }
        const created: ICodespaceResponse = await this.requestJson<ICodespaceResponse>(
            "POST",
            `repos/${target.repository}/codespaces`,
            {
                ref: target.branch,
                machine: machine.name,
                display_name: "LeetCode Pairing",
                idle_timeout_minutes: 30,
                retention_period_minutes: 72 * 60,
                // Match `gh codespace create --default-permissions`: continue
                // non-interactively without granting extra repository access.
                multi_repo_permissions_opt_out: true,
            },
            undefined,
            5 * 60_000,
        );
        const name: string = created.name;
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("GitHub created a Codespace but did not return its name.");
        }
        return name;
    }

    public async getCodespaceState(name: string): Promise<string> {
        this.validateCodespaceName(name);
        const response: ICodespaceResponse = await this.requestJson<ICodespaceResponse>(
            "GET",
            `user/codespaces/${name}`,
            undefined,
            undefined,
            60_000,
        );
        if (typeof response.state !== "string" || !/^[A-Za-z]+$/.test(response.state)) {
            throw new Error("GitHub returned an invalid Codespace state.");
        }
        return response.state;
    }

    public async startCodespace(name: string): Promise<void> {
        this.validateCodespaceName(name);
        await this.requestJson("POST", `user/codespaces/${name}/start`, undefined, undefined, 60_000);
    }

    private async requestJson<T>(
        method: IGitHubHttpRequest["method"],
        endpoint: string,
        data?: unknown,
        params?: { [name: string]: string | number },
        timeoutMs: number = 30_000,
    ): Promise<T> {
        for (let attempt: number = 0; attempt < 2; attempt++) {
            const token: string = await this.getAccessToken(attempt > 0);
            try {
                const response: IGitHubHttpResponse = await this.requester({
                    method,
                    endpoint,
                    token,
                    timeoutMs,
                    data,
                    params,
                });
                return response.data as T;
            } catch (error) {
                const status: number | undefined = getHttpStatus(error);
                if (status === 401 && attempt === 0) {
                    this.accessTokenPromise = undefined;
                    continue;
                }
                throw new Error(`GitHub API failed: ${summarizeGitHubError(getHttpErrorMessage(error), "request failed")}`);
            }
        }
        throw new Error("GitHub authentication failed after refreshing the access token.");
    }

    private async getAccessToken(forceRefresh: boolean): Promise<string> {
        if (forceRefresh) {
            this.accessTokenPromise = undefined;
        }
        if (!this.accessTokenPromise) {
            this.accessTokenPromise = this.tokenProvider(forceRefresh).then((token: string) => {
                const trimmed: string = token.trim();
                if (!/^[^\s]{20,500}$/.test(trimmed)) {
                    throw new Error("GitHub authentication returned an invalid access token.");
                }
                return trimmed;
            }).catch((error: unknown) => {
                this.accessTokenPromise = undefined;
                throw error;
            });
        }
        return this.accessTokenPromise;
    }

    private issueEndpoint(target: IPairingTarget): string {
        return `repos/${target.repository}/issues/${target.issueNumber}`;
    }

    private commentEndpoint(target: IPairingTarget, commentId: number): string {
        if (!Number.isSafeInteger(commentId) || commentId <= 0) {
            throw new Error("Refusing to use an invalid issue comment ID.");
        }
        return `repos/${target.repository}/issues/comments/${commentId}`;
    }

    private toCandidateComment(comment: IGitHubCommentResponse): IPairingCandidateComment {
        return {
            id: comment.id,
            updatedAt: comment.updated_at || comment.created_at,
            authorLogin: comment.user?.login || "",
            body: comment.body,
        };
    }

    private validateCodespaceName(name: string): void {
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("Refusing to use an invalid Codespace name.");
        }
    }

    private validateRepository(repository: string): void {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
            throw new Error("Refusing to use an invalid GitHub repository.");
        }
    }
}

async function defaultGitHubHttpRequest(request: IGitHubHttpRequest): Promise<IGitHubHttpResponse> {
    const config: AxiosRequestConfig = {
        method: request.method,
        url: `https://api.github.com/${request.endpoint}`,
        headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${request.token}`,
            "User-Agent": "vscode-leetcode-pairing",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout: request.timeoutMs,
        maxContentLength: 8 * 1024 * 1024,
        maxBodyLength: 8 * 1024 * 1024,
        data: request.data,
        params: request.params,
        validateStatus: (status: number) => status >= 200 && status < 300,
    };
    const response: AxiosResponse = await axios(config);
    return { status: response.status, data: response.data };
}

function getHttpStatus(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) {
        return error.response?.status;
    }
    if (typeof error === "object" && error !== null && "status" in error) {
        const status: unknown = (error as { status?: unknown }).status;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}

function getHttpErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const responseMessage: unknown = error.response?.data &&
            typeof error.response.data === "object" && "message" in error.response.data
            ? (error.response.data as { message?: unknown }).message
            : undefined;
        return typeof responseMessage === "string" ? responseMessage : error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
