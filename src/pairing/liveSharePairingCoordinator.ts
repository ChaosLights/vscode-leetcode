// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import * as crypto from "crypto";
import * as vscode from "vscode";
import { leetCodeChannel } from "../leetCodeChannel";
import { GitHubCli, ICodespaceSummary } from "./githubCli";
import {
    getLiveShareApi,
    ILiveShareApi,
    ILiveShareSessionChangeEvent,
    LiveShareAccess,
    LiveShareRole,
} from "./liveShareApi";
import {
    IPairingCandidate,
    IPairingState,
    IPairingTarget,
    canRetryCodespaceOpen,
    chooseElectionWinner,
    createIdleState,
    isAllowedLiveShareUrl,
    isLeaseActive,
    renderCandidateComment,
    validatePairingTarget,
} from "./pairingProtocol";

const electionWindowMs: number = 3_000;
const candidateLifetimeMs: number = 45_000;
const pollIntervalMs: number = 3_000;
const codespaceOpenRetryMs: number = 20_000;
const startingLeaseMs: number = 15 * 60_000;
const readyLeaseMs: number = 3 * 60_000;
const heartbeatIntervalMs: number = 60_000;
const codespaceReadyTimeoutMs: number = 10 * 60_000;

const retryElectionErrorName: string = "LeetCodePairingRetryElection";
const pairingCancelledErrorName: string = "LeetCodePairingCancelled";

export class LiveSharePairingCoordinator implements vscode.Disposable {
    private readonly github: GitHubCli = new GitHubCli();
    private activeStart: Thenable<void> | undefined;
    private autoHostTimer: NodeJS.Timeout | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private autoHostBusy: boolean = false;
    private liveShareApi: ILiveShareApi | null | undefined;
    private sessionSubscription: vscode.Disposable | undefined;
    private hostedTarget: IPairingTarget | undefined;
    private hostedGeneration: number | undefined;
    private hostedNonce: string | undefined;

    public initializeAutoHost(): void {
        // `gh codespace code` first opens a local, empty window and only then
        // changes that window to a Codespace workspace. At extension activation
        // time remoteName can therefore still be undefined. Keep a lightweight
        // monitor alive and let checkForHostRequest() decide when the window is
        // actually attached to the elected Codespace.
        void this.checkForHostRequest();
        this.autoHostTimer = setInterval(() => void this.checkForHostRequest(), 15_000);
    }

    public async startFromCommand(): Promise<void> {
        await this.start(this.getConfiguredTarget());
    }

    public async startFromUri(uri: vscode.Uri): Promise<void> {
        const configured: IPairingTarget = this.getConfiguredTarget();
        const query: URLSearchParams = new URLSearchParams(uri.query);
        const requested: IPairingTarget = validatePairingTarget({
            repository: query.get("repository") || configured.repository,
            issueNumber: query.has("issue") ? Number(query.get("issue")) : configured.issueNumber,
            branch: query.get("branch") || configured.branch,
        });
        if (requested.repository.toLowerCase() !== configured.repository.toLowerCase() ||
            requested.issueNumber !== configured.issueNumber) {
            throw new Error("The launcher target does not match this extension's configured pairing issue.");
        }
        await this.start(requested);
    }

    public dispose(): void {
        if (this.autoHostTimer) {
            clearInterval(this.autoHostTimer);
        }
        this.stopHeartbeat();
        this.sessionSubscription?.dispose();
    }

    private async start(target: IPairingTarget): Promise<void> {
        if (this.activeStart) {
            await this.activeStart;
            return;
        }
        this.activeStart = vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "LeetCode Pairing",
                cancellable: true,
            },
            async (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken): Promise<void> => {
                await this.coordinate(target, progress, token);
            },
        );
        try {
            await this.activeStart;
        } catch (error) {
            if (this.isNamedError(error, pairingCancelledErrorName)) {
                leetCodeChannel.appendLine("[pairing] Start cancelled.");
                return;
            }
            const message: string = this.errorMessage(error);
            leetCodeChannel.appendLine(`[pairing] ${message}`);
            void vscode.window.showErrorMessage(`LeetCode Pairing failed: ${message}`);
        } finally {
            this.activeStart = undefined;
        }
    }

    private async coordinate(
        target: IPairingTarget,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const api: ILiveShareApi = await this.requireLiveShareApi();
        progress.report({ message: "Checking GitHub session..." });
        const login: string = await this.github.getLogin();

        for (let attempt: number = 0; attempt < 4; attempt++) {
            try {
                this.throwIfCancelled(token);
                const state: IPairingState = await this.github.getIssueState(target);
                if (isLeaseActive(state)) {
                    await this.followActiveLease(target, state, login, undefined, api, progress, token);
                    return;
                }
                await this.runElection(target, state, login, api, progress, token);
                return;
            } catch (error) {
                if (!this.isNamedError(error, retryElectionErrorName)) {
                    throw error;
                }
            }
        }
        throw new Error("The pairing host changed repeatedly. Try the launcher again.");
    }

    private async runElection(
        target: IPairingTarget,
        baseState: IPairingState,
        login: string,
        api: ILiveShareApi,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const generation: number = baseState.generation + 1;
        const nonce: string = crypto.randomBytes(16).toString("hex");
        const candidate: IPairingCandidate = {
            version: 1,
            generation,
            login,
            nonce,
            createdAt: new Date().toISOString(),
        };
        progress.report({ message: "Electing the first participant as host..." });
        const ownComment = await this.github.postCandidate(target, renderCandidateComment(candidate));
        await this.wait(electionWindowMs, token);

        const winner = chooseElectionWinner(
            await this.github.listCandidates(target),
            generation,
            Date.now(),
            candidateLifetimeMs,
        );
        if (!winner) {
            throw this.namedError(retryElectionErrorName, "No active election candidate was found.");
        }
        if (winner.commentId !== ownComment.id) {
            progress.report({ message: `Waiting for ${winner.candidate.login} to start Live Share...` });
            await this.waitForLease(target, generation, login, nonce, api, progress, token);
            return;
        }

        const latest: IPairingState = await this.github.getIssueState(target);
        if (isLeaseActive(latest)) {
            await this.followActiveLease(target, latest, login, nonce, api, progress, token);
            return;
        }
        if (latest.generation !== baseState.generation) {
            throw this.namedError(retryElectionErrorName, "Another election advanced the pairing generation.");
        }

        const starting: IPairingState = {
            version: 1,
            generation,
            status: "starting",
            updatedAt: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + startingLeaseMs).toISOString(),
            hostLogin: login,
            hostNonce: nonce,
            codespaceName: null,
            joinUrl: null,
            error: null,
        };
        await this.github.updateIssueState(target, starting);

        try {
            progress.report({ message: "Preparing your Codespace..." });
            const codespaceName: string = await this.getOrCreateCodespace(target);
            starting.codespaceName = codespaceName;
            starting.updatedAt = new Date().toISOString();
            starting.leaseExpiresAt = new Date(Date.now() + startingLeaseMs).toISOString();
            await this.github.updateIssueState(target, starting);

            await this.ensureCodespaceAvailable(codespaceName, progress, token);
            progress.report({ message: "Opening the host Codespace..." });
            await this.github.openCodespace(codespaceName);
            await this.waitForLease(target, generation, login, nonce, api, progress, token, codespaceName);
        } catch (error) {
            const failed: IPairingState = createIdleState(generation, this.safeStateError(error));
            await this.github.updateIssueState(target, failed).catch(() => undefined);
            throw error;
        }
    }

    private async waitForLease(
        target: IPairingTarget,
        generation: number,
        login: string,
        nonce: string,
        api: ILiveShareApi,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
        hostCodespaceName?: string,
    ): Promise<void> {
        const deadline: number = Date.now() + startingLeaseMs;
        const stateAdvanceDeadline: number = Date.now() + candidateLifetimeMs;
        let nextCodespaceOpenAt: number = hostCodespaceName ? Date.now() + codespaceOpenRetryMs : Number.MAX_VALUE;
        let openAttempt: number = 1;
        while (Date.now() < deadline) {
            this.throwIfCancelled(token);
            const state: IPairingState = await this.github.getIssueState(target);
            if (state.generation < generation && Date.now() >= stateAdvanceDeadline) {
                throw this.namedError(retryElectionErrorName, "The elected candidate did not claim the host lease.");
            }
            if (state.generation > generation || (state.generation === generation && !isLeaseActive(state))) {
                throw this.namedError(retryElectionErrorName, "The host lease expired before Live Share became ready.");
            }
            if (state.generation === generation && state.status === "ready" && isLeaseActive(state)) {
                await this.followActiveLease(target, state, login, nonce, api, progress, token);
                return;
            }
            const now: number = Date.now();
            if (hostCodespaceName && now >= nextCodespaceOpenAt &&
                canRetryCodespaceOpen(state, generation, login, hostCodespaceName, now)) {
                openAttempt++;
                progress.report({ message: `Codespace did not connect; reopening it (attempt ${openAttempt})...` });
                leetCodeChannel.appendLine("[pairing] Codespace did not publish readiness; retrying its open request.");
                try {
                    await this.github.openCodespace(hostCodespaceName);
                } catch (error) {
                    leetCodeChannel.appendLine(`[pairing] Codespace reopen failed: ${this.errorMessage(error)}`);
                }
                nextCodespaceOpenAt = Date.now() + codespaceOpenRetryMs;
                await this.wait(pollIntervalMs, token);
                continue;
            }
            if (state.status === "starting" && state.hostLogin) {
                progress.report({ message: `Waiting for ${state.hostLogin}'s Codespace and Live Share...` });
            }
            await this.wait(pollIntervalMs, token);
        }
        throw this.namedError(retryElectionErrorName, "Timed out waiting for the host.");
    }

    private async followActiveLease(
        target: IPairingTarget,
        state: IPairingState,
        login: string,
        nonce: string | undefined,
        api: ILiveShareApi,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        if (state.status !== "ready") {
            const recoverCodespaceName: string | undefined = state.hostLogin === login && state.codespaceName
                ? state.codespaceName
                : undefined;
            await this.waitForLease(
                target, state.generation, login, nonce || "", api, progress, token, recoverCodespaceName,
            );
            return;
        }
        if (state.hostLogin === login && nonce && state.hostNonce === nonce) {
            progress.report({ message: "Live Share is ready in your Codespace." });
            void vscode.window.showInformationMessage("LeetCode Pairing is ready. You are the host.");
            if (!vscode.env.remoteName && (vscode.workspace.workspaceFolders || []).length === 0) {
                // The host now works in the Codespace window opened by gh; the
                // local launcher window has no remaining purpose.
                void vscode.commands.executeCommand("workbench.action.closeWindow");
            }
            return;
        }
        if (!state.joinUrl || !isAllowedLiveShareUrl(state.joinUrl)) {
            throw new Error("The pairing issue contains an invalid Live Share invitation.");
        }
        if (api.session.role === LiveShareRole.Guest) {
            return;
        }
        if (api.session.role === LiveShareRole.Host) {
            throw new Error("End your current Live Share host session before joining another host.");
        }
        progress.report({ message: `Joining ${state.hostLogin || "your friend"}'s Live Share session...` });
        try {
            await api.join(vscode.Uri.parse(state.joinUrl), { newWindow: false });
        } catch (error) {
            if (!this.isInactiveLiveShareSessionError(error) ||
                !await this.clearUnchangedStaleReadyLease(target, state)) {
                throw error;
            }
            leetCodeChannel.appendLine("[pairing] Removed an inactive Live Share invitation; restarting host election.");
            throw this.namedError(retryElectionErrorName, "The previous Live Share session ended.");
        }
    }

    private async clearUnchangedStaleReadyLease(
        target: IPairingTarget,
        attemptedState: IPairingState,
    ): Promise<boolean> {
        const latest: IPairingState = await this.github.getIssueState(target);
        if (latest.status !== "ready" ||
            latest.generation !== attemptedState.generation ||
            latest.hostNonce !== attemptedState.hostNonce ||
            latest.joinUrl !== attemptedState.joinUrl ||
            latest.updatedAt !== attemptedState.updatedAt) {
            return false;
        }
        await this.github.updateIssueState(target, createIdleState(latest.generation));
        return true;
    }

    private async checkForHostRequest(): Promise<void> {
        if (this.autoHostBusy || !this.isAutoHostEnabled()) {
            return;
        }
        this.autoHostBusy = true;
        try {
            const target: IPairingTarget = this.getConfiguredTarget();
            const codespaceName: string | undefined = this.getCurrentCodespaceName();
            if (!codespaceName) {
                return;
            }
            const login: string = await this.github.getLogin();
            const state: IPairingState = await this.github.getIssueState(target);
            if ((state.status !== "starting" && state.status !== "ready") || !isLeaseActive(state) ||
                state.hostLogin !== login || state.codespaceName !== codespaceName || !state.hostNonce) {
                return;
            }

            const api: ILiveShareApi = await this.requireLiveShareApi();
            if (api.session.role === LiveShareRole.Guest) {
                throw new Error("This Codespace is already a Live Share guest and cannot become the host.");
            }
            if (state.status === "ready" && api.session.role === LiveShareRole.Host) {
                if (this.heartbeatTimer && this.hostedGeneration === state.generation &&
                    this.hostedNonce === state.hostNonce && this.hostedTarget &&
                    this.hostedTarget.repository === target.repository &&
                    this.hostedTarget.issueNumber === target.issueNumber) {
                    return;
                }
                this.hostedTarget = target;
                this.hostedGeneration = state.generation;
                this.hostedNonce = state.hostNonce;
                await this.refreshHostLease();
                this.startHeartbeat();
                this.ensureSessionSubscription(api);
                return;
            }
            leetCodeChannel.appendLine(`[pairing] Starting Live Share for generation ${state.generation}.`);
            // Calling share() while already hosting retrieves the existing link,
            // but Live Share rejects an access-level option after the session has
            // started. This path recovers cleanly when VS Code reloads between
            // starting the session and publishing the ready lease.
            let link: vscode.Uri | null = api.session.role === LiveShareRole.Host
                ? await api.share({ suppressNotification: true })
                : await api.share({
                    suppressNotification: true,
                    access: LiveShareAccess.ReadWrite,
                });
            // Live Share 1.1.122 starts the session successfully but its public
            // share() wrapper can discard the command's link result and return
            // null. The pinned extension also exposes its invitation-creation
            // command, which returns the same current-session link without
            // touching the clipboard or showing a prompt.
            if (!link && api.session.role === LiveShareRole.Host) {
                const recoveredLink: unknown = await vscode.commands.executeCommand(
                    "liveshare.createInvitationLink",
                    {},
                );
                if (typeof recoveredLink === "string") {
                    link = vscode.Uri.parse(recoveredLink);
                }
            }
            if (!link && api.session.role === LiveShareRole.Host) {
                link = await this.recoverJoinLinkFromClipboard();
            }
            if (!link || !isAllowedLiveShareUrl(link.toString())) {
                throw new Error(
                    `Live Share returned an unexpected invitation origin (${this.describeLinkOrigin(link)}).`,
                );
            }

            const latest: IPairingState = await this.github.getIssueState(target);
            if ((latest.status !== "starting" && latest.status !== "ready") || latest.generation !== state.generation ||
                latest.hostNonce !== state.hostNonce || latest.codespaceName !== codespaceName) {
                leetCodeChannel.appendLine("[pairing] Host request changed before Live Share was ready; leaving it untouched.");
                return;
            }
            const ready: IPairingState = {
                ...latest,
                status: "ready",
                updatedAt: new Date().toISOString(),
                leaseExpiresAt: new Date(Date.now() + readyLeaseMs).toISOString(),
                joinUrl: link.toString(),
                error: null,
            };
            await this.github.updateIssueState(target, ready);
            this.hostedTarget = target;
            this.hostedGeneration = ready.generation;
            this.hostedNonce = ready.hostNonce || undefined;
            this.startHeartbeat();
            this.ensureSessionSubscription(api);
            void vscode.window.showInformationMessage("LeetCode Pairing is hosting. Your friend will join automatically.");
        } catch (error) {
            leetCodeChannel.appendLine(`[pairing] Auto-host check failed: ${this.errorMessage(error)}`);
        } finally {
            this.autoHostBusy = false;
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => void this.refreshHostLease(), heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private async refreshHostLease(): Promise<void> {
        if (!this.hostedTarget || this.hostedGeneration === undefined || !this.hostedNonce) {
            return;
        }
        try {
            const state: IPairingState = await this.github.getIssueState(this.hostedTarget);
            if (state.status !== "ready" || state.generation !== this.hostedGeneration ||
                state.hostNonce !== this.hostedNonce) {
                this.stopHeartbeat();
                return;
            }
            state.updatedAt = new Date().toISOString();
            state.leaseExpiresAt = new Date(Date.now() + readyLeaseMs).toISOString();
            await this.github.updateIssueState(this.hostedTarget, state);
        } catch (error) {
            leetCodeChannel.appendLine(`[pairing] Host heartbeat failed: ${this.errorMessage(error)}`);
        }
    }

    private ensureSessionSubscription(api: ILiveShareApi): void {
        if (this.sessionSubscription) {
            return;
        }
        this.sessionSubscription = api.onDidChangeSession((event: ILiveShareSessionChangeEvent) => {
            if (event.session.role === LiveShareRole.None) {
                void this.releaseHostLease();
            }
        });
    }

    private async releaseHostLease(): Promise<void> {
        this.stopHeartbeat();
        if (!this.hostedTarget || this.hostedGeneration === undefined || !this.hostedNonce) {
            return;
        }
        try {
            const state: IPairingState = await this.github.getIssueState(this.hostedTarget);
            if (state.generation === this.hostedGeneration && state.hostNonce === this.hostedNonce) {
                await this.github.updateIssueState(this.hostedTarget, createIdleState(state.generation));
            }
        } catch (error) {
            leetCodeChannel.appendLine(`[pairing] Unable to release host lease: ${this.errorMessage(error)}`);
        } finally {
            this.hostedTarget = undefined;
            this.hostedGeneration = undefined;
            this.hostedNonce = undefined;
        }
    }

    private async getOrCreateCodespace(target: IPairingTarget): Promise<string> {
        const codespaces: ICodespaceSummary[] = await this.github.listCodespaces(target.repository);
        const reusable: ICodespaceSummary | undefined = codespaces
            .filter((entry: ICodespaceSummary) => [
                "Available", "Shutdown", "Starting", "Queued", "Provisioning", "Rebuilding",
            ].includes(entry.state))
            .sort((left: ICodespaceSummary, right: ICodespaceSummary) =>
                Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt),
            )[0];
        return reusable ? reusable.name : await this.github.createCodespace(target);
    }

    private async ensureCodespaceAvailable(
        name: string,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const deadline: number = Date.now() + codespaceReadyTimeoutMs;
        let startRequested: boolean = false;
        while (Date.now() < deadline) {
            this.throwIfCancelled(token);
            const state: string = await this.github.getCodespaceState(name);
            if (state === "Available") {
                return;
            }
            if (["Deleted", "Failed", "Unavailable"].includes(state)) {
                throw new Error(`Codespace ${name} cannot start (state: ${state}).`);
            }
            if (state === "Shutdown" && !startRequested) {
                progress.report({ message: "Starting the host Codespace..." });
                await this.github.startCodespace(name);
                startRequested = true;
            } else {
                progress.report({ message: `Waiting for the host Codespace (${state})...` });
            }
            await this.wait(5_000, token);
        }
        throw new Error(`Codespace ${name} did not become available within 10 minutes.`);
    }

    private async requireLiveShareApi(): Promise<ILiveShareApi> {
        if (this.liveShareApi === undefined) {
            this.liveShareApi = await getLiveShareApi();
        }
        if (!this.liveShareApi) {
            throw new Error(
                "Live Share API is unavailable in this local extension host. Install Live Share locally, set " +
                "remote.extensionKind for ms-vsliveshare.vsliveshare to [\"ui\"], and reload VS Code.",
            );
        }
        return this.liveShareApi;
    }

    private getConfiguredTarget(): IPairingTarget {
        const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        return validatePairingTarget({
            repository: configuration.get<string>("pairing.repository", "ChaosLights/lc"),
            issueNumber: configuration.get<number>("pairing.issueNumber", 8),
            branch: configuration.get<string>("pairing.branch", "main"),
        });
    }

    private isAutoHostEnabled(): boolean {
        return vscode.workspace.getConfiguration("leetcode").get<boolean>("pairing.autoHost", true);
    }

    private getCurrentCodespaceName(): string | undefined {
        for (const folder of vscode.workspace.workspaceFolders || []) {
            const match: RegExpMatchArray | null = folder.uri.authority.match(/^codespaces\+([A-Za-z0-9-]+)$/i);
            if (match) {
                return match[1];
            }
        }
        return undefined;
    }

    private async wait(ms: number, token: vscode.CancellationToken): Promise<void> {
        this.throwIfCancelled(token);
        await new Promise<void>((resolve, reject) => {
            const timer: NodeJS.Timeout = setTimeout(() => {
                subscription.dispose();
                resolve();
            }, ms);
            const subscription: vscode.Disposable = token.onCancellationRequested(() => {
                clearTimeout(timer);
                subscription.dispose();
                reject(this.namedError(pairingCancelledErrorName, "Pairing was cancelled."));
            });
        });
    }

    private throwIfCancelled(token: vscode.CancellationToken): void {
        if (token.isCancellationRequested) {
            throw this.namedError(pairingCancelledErrorName, "Pairing was cancelled.");
        }
    }

    private safeStateError(error: unknown): string {
        return this.errorMessage(error).replace(/https:\/\/\S+/g, "[redacted URL]").substring(0, 300);
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private describeLinkOrigin(link: vscode.Uri | null): string {
        if (!link) {
            return "none";
        }
        try {
            const parsed: vscode.Uri = vscode.Uri.parse(link.toString());
            return `${parsed.scheme}://${parsed.authority || "none"}`;
        } catch (_error) {
            return "unparseable";
        }
    }

    private async recoverJoinLinkFromClipboard(): Promise<vscode.Uri | null> {
        const original: string = await vscode.env.clipboard.readText();
        const sentinel: string = `leetcode-pairing-${crypto.randomBytes(12).toString("hex")}`;
        await vscode.env.clipboard.writeText(sentinel);
        let recovered: string | undefined;
        try {
            // The command copies before awaiting its informational toast. Do
            // not await the command itself or automatic pairing would pause
            // until somebody manually dismisses that notification.
            void vscode.commands.executeCommand("liveshare.collaboration.link.copy").then(
                undefined,
                (error: unknown) => leetCodeChannel.appendLine(
                    `[pairing] Copy-invitation fallback failed: ${this.errorMessage(error)}`,
                ),
            );
            for (let attempt: number = 0; attempt < 20; attempt++) {
                const current: string = await vscode.env.clipboard.readText();
                if (current !== sentinel) {
                    if (isAllowedLiveShareUrl(current)) {
                        recovered = current;
                    }
                    break;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            return recovered ? vscode.Uri.parse(recovered) : null;
        } finally {
            // Do not overwrite a value the user copied concurrently while the
            // Live Share command was running.
            const current: string = await vscode.env.clipboard.readText();
            if (current === sentinel || (recovered !== undefined && current === recovered)) {
                await vscode.env.clipboard.writeText(original);
            }
        }
    }

    private namedError(name: string, message: string): Error {
        const error: Error = new Error(message);
        error.name = name;
        return error;
    }

    private isNamedError(error: unknown, name: string): boolean {
        return error instanceof Error && error.name === name;
    }

    private isInactiveLiveShareSessionError(error: unknown): boolean {
        const message: string = this.errorMessage(error).toLowerCase();
        return message.includes("collaboration session is no longer active") ||
            message.includes("session is no longer active") ||
            /\b(?:collaboration|live share)\s+session\b.*\b(?:ended|expired|inactive|not found)\b/.test(message);
    }
}
