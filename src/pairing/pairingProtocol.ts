// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export type PairingStatus = "idle" | "starting" | "ready" | "error";

export interface IPairingTarget {
    repository: string;
    issueNumber: number;
    branch: string;
}

export interface IPairingState {
    version: 1;
    generation: number;
    status: PairingStatus;
    updatedAt: string;
    leaseExpiresAt: string | null;
    hostLogin: string | null;
    hostNonce: string | null;
    codespaceName: string | null;
    joinUrl: string | null;
    error: string | null;
}

export interface IPairingCandidate {
    version: 1;
    generation: number;
    login: string;
    nonce: string;
    createdAt: string;
}

export interface IPairingCandidateComment {
    id: number;
    updatedAt: string;
    authorLogin: string;
    body: string;
}

const stateStart: string = "<!-- leetcode-pairing-state";
const candidateStart: string = "<!-- leetcode-pairing-candidate";
const markerEnd: string = "-->";
const repositoryPattern: RegExp = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern: RegExp = /^[A-Za-z0-9._\/-]+$/;

export function validatePairingTarget(target: IPairingTarget): IPairingTarget {
    const repository: string = target.repository.trim();
    const branch: string = target.branch.trim();
    if (!repositoryPattern.test(repository) || repository.includes("..")) {
        throw new Error("Pairing repository must use the owner/name format.");
    }
    if (!Number.isSafeInteger(target.issueNumber) || target.issueNumber <= 0) {
        throw new Error("Pairing issue number must be a positive integer.");
    }
    if (!branchPattern.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..")) {
        throw new Error("Pairing branch contains unsupported characters.");
    }
    return { repository, issueNumber: target.issueNumber, branch };
}

export function createIdleState(generation: number = 0, error: string | null = null): IPairingState {
    return {
        version: 1,
        generation,
        status: error ? "error" : "idle",
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: null,
        hostLogin: null,
        hostNonce: null,
        codespaceName: null,
        joinUrl: null,
        error,
    };
}

export function isLeaseActive(state: IPairingState, now: number = Date.now()): boolean {
    if ((state.status !== "starting" && state.status !== "ready") || !state.leaseExpiresAt) {
        return false;
    }
    const expiresAt: number = Date.parse(state.leaseExpiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
}

export function canRetryCodespaceOpen(
    state: IPairingState,
    generation: number,
    login: string,
    codespaceName: string,
    now: number = Date.now(),
): boolean {
    return state.generation === generation &&
        state.status === "starting" &&
        state.hostLogin === login &&
        state.codespaceName === codespaceName &&
        isLeaseActive(state, now);
}

export function parsePairingState(issueBody: string | null | undefined): IPairingState {
    const parsed: unknown = parseMarker(issueBody || "", stateStart);
    if (!isPairingState(parsed)) {
        throw new Error("The pairing issue does not contain a valid state block.");
    }
    return parsed;
}

export function renderPairingIssueBody(state: IPairingState): string {
    return [
        "# LeetCode Pairing coordinator",
        "",
        "This private issue is machine-managed by the LeetCode Live Share extension.",
        "",
        "- Do not edit the state block by hand.",
        "- Candidate comments are election records; they contain no LeetCode cookie or GitHub token.",
        "- A Live Share invite is stored only while its short lease is active.",
        "",
        stateStart,
        JSON.stringify(state),
        markerEnd,
    ].join("\n");
}

export function renderCandidateComment(candidate: IPairingCandidate): string {
    return [
        `LeetCode Pairing election record for \`${candidate.login}\`. This comment is reused automatically.`,
        "",
        candidateStart,
        JSON.stringify(candidate),
        markerEnd,
    ].join("\n");
}

export function parseCandidateComment(body: string): IPairingCandidate | undefined {
    try {
        const parsed: unknown = parseMarker(body, candidateStart);
        return isPairingCandidate(parsed) ? parsed : undefined;
    } catch (_error) {
        return undefined;
    }
}

export function chooseElectionWinner(
    comments: IPairingCandidateComment[],
    generation: number,
    now: number = Date.now(),
    candidateLifetimeMs: number = 45_000,
): { commentId: number; candidate: IPairingCandidate } | undefined {
    return comments
        .map((comment: IPairingCandidateComment) => ({
            commentId: comment.id,
            serverUpdatedAt: Date.parse(comment.updatedAt),
            authorLogin: comment.authorLogin,
            candidate: parseCandidateComment(comment.body),
        }))
        .filter((entry): entry is {
            commentId: number;
            serverUpdatedAt: number;
            authorLogin: string;
            candidate: IPairingCandidate;
        } => {
            if (!entry.candidate || entry.candidate.generation !== generation || !Number.isSafeInteger(entry.commentId)) {
                return false;
            }
            if (entry.candidate.login.toLowerCase() !== entry.authorLogin.toLowerCase()) {
                return false;
            }
            return Number.isFinite(entry.serverUpdatedAt) && entry.serverUpdatedAt >= now - candidateLifetimeMs;
        })
        .sort((left, right) =>
            left.serverUpdatedAt - right.serverUpdatedAt ||
            left.commentId - right.commentId,
        )[0];
}

export function isAllowedLiveShareUrl(value: string): boolean {
    try {
        const url: URL = new URL(value);
        const host: string = url.hostname.toLowerCase();
        return url.protocol === "https:" && (
            host === "vsls.io" ||
            host.endsWith(".liveshare.vsengsaas.visualstudio.com")
        );
    } catch (_error) {
        return false;
    }
}

function parseMarker(body: string, start: string): unknown {
    const startIndex: number = body.indexOf(start);
    if (startIndex < 0) {
        throw new Error("Marker was not found.");
    }
    const valueStart: number = startIndex + start.length;
    const endIndex: number = body.indexOf(markerEnd, valueStart);
    if (endIndex < 0) {
        throw new Error("Marker is incomplete.");
    }
    return JSON.parse(body.substring(valueStart, endIndex).trim());
}

function isPairingState(value: unknown): value is IPairingState {
    if (!isRecord(value)) {
        return false;
    }
    return value.version === 1 &&
        Number.isSafeInteger(value.generation) && Number(value.generation) >= 0 &&
        ["idle", "starting", "ready", "error"].includes(String(value.status)) &&
        typeof value.updatedAt === "string" &&
        isNullableString(value.leaseExpiresAt) &&
        isNullableString(value.hostLogin) &&
        isNullableString(value.hostNonce) &&
        isNullableString(value.codespaceName) &&
        isNullableString(value.joinUrl) &&
        isNullableString(value.error);
}

function isPairingCandidate(value: unknown): value is IPairingCandidate {
    if (!isRecord(value)) {
        return false;
    }
    return value.version === 1 &&
        Number.isSafeInteger(value.generation) && Number(value.generation) > 0 &&
        typeof value.login === "string" && value.login.length > 0 && value.login.length <= 100 &&
        typeof value.nonce === "string" && /^[a-f0-9]{32}$/.test(value.nonce) &&
        typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}
