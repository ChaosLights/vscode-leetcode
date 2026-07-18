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
import { PairingAuditFields, pairingAuditLog } from "./pairingAuditLog";

const electionWindowMs: number = 3_000;
const candidateLifetimeMs: number = 45_000;
const pollIntervalMs: number = 3_000;
const codespaceOpenRetryMs: number = 20_000;
const codespaceOpenMaxAttempts: number = 3;
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
        pairingAuditLog.event("auto_host.monitor_started", {
            remoteName: vscode.env.remoteName || "none",
            workspaceCount: (vscode.workspace.workspaceFolders || []).length,
        });
        const auditPath: string | undefined = pairingAuditLog.getPath();
        if (auditPath) {
            leetCodeChannel.appendLine(`[pairing] Timestamped audit log: ${auditPath}`);
        }
        // The local launcher window can change into a Codespace workspace.
        // Keep a lightweight monitor alive and let checkForHostRequest()
        // recognize the elected Codespace after the remote resolver attaches.
        void this.checkForHostRequest();
        this.autoHostTimer = setInterval(() => void this.checkForHostRequest(), 15_000);
    }

    public async startFromCommand(): Promise<void> {
        pairingAuditLog.event("pairing.command_requested");
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
        const launcherRunId: string = query.get("runId") || "none";
        pairingAuditLog.event("pairing.launcher_uri_received", {
            launcherRunId: /^[a-f0-9-]{8,64}$/i.test(launcherRunId) ? launcherRunId : "invalid",
            repository: requested.repository,
            issueNumber: requested.issueNumber,
            branch: requested.branch,
        });
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
            pairingAuditLog.event("pairing.start_deduplicated");
            await this.activeStart;
            return;
        }
        pairingAuditLog.event("pairing.start", {
            repository: target.repository,
            issueNumber: target.issueNumber,
            branch: target.branch,
        });
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
                pairingAuditLog.event("pairing.cancelled");
                return;
            }
            const message: string = this.errorMessage(error);
            leetCodeChannel.appendLine(`[pairing] ${message}`);
            pairingAuditLog.event("pairing.failed", { error: this.safeStateError(error) });
            void vscode.window.showErrorMessage(`LeetCode Pairing failed: ${message}`);
        } finally {
            pairingAuditLog.event("pairing.start_finished");
            this.activeStart = undefined;
        }
    }

    private async coordinate(
        target: IPairingTarget,
        progress: vscode.Progress<{ message?: string }>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        await this.ensureLocalExtensionKinds();
        const api: ILiveShareApi = await this.requireLiveShareApi();
        progress.report({ message: "Checking GitHub session..." });
        const login: string = await this.github.getLogin();
        pairingAuditLog.event("github.login_ready", { login });

        for (let attempt: number = 0; attempt < 4; attempt++) {
            try {
                this.throwIfCancelled(token);
                const state: IPairingState = await this.github.getIssueState(target);
                this.auditState("coordinator.state_read", state, { attempt: attempt + 1 });
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
                pairingAuditLog.event("election.retry", {
                    attempt: attempt + 1,
                    reason: this.safeStateError(error),
                });
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
        const ownComment = await this.github.upsertCandidate(target, login, renderCandidateComment(candidate));
        pairingAuditLog.event("election.candidate_posted", {
            generation,
            login,
            commentId: ownComment.id,
        });
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
        pairingAuditLog.event("election.winner_selected", {
            generation,
            winnerLogin: winner.candidate.login,
            winnerCommentId: winner.commentId,
            ownCommentId: ownComment.id,
        });
        if (winner.commentId !== ownComment.id) {
            progress.report({ message: `Waiting for ${winner.candidate.login} to start Live Share...` });
            await this.waitForLease(
                target, generation, login, nonce, api, progress, token, undefined, winner.candidate.login,
            );
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
        this.auditState("lease.starting_published", starting);

        try {
            progress.report({ message: "Preparing your Codespace..." });
            const codespaceName: string = await this.getOrCreateCodespace(target);
            pairingAuditLog.event("codespace.selected", { generation, codespaceName });
            starting.codespaceName = codespaceName;
            starting.updatedAt = new Date().toISOString();
            starting.leaseExpiresAt = new Date(Date.now() + startingLeaseMs).toISOString();
            await this.github.updateIssueState(target, starting);
            this.auditState("lease.codespace_published", starting);

            await this.ensureCodespaceAvailable(codespaceName, progress, token);
            progress.report({ message: "Opening the host Codespace..." });
            pairingAuditLog.event("codespace.open_requested", { generation, codespaceName, attempt: 1 });
            await this.openCodespace(codespaceName, login, progress);
            await this.waitForLease(
                target, generation, login, nonce, api, progress, token, codespaceName, login,
            );
        } catch (error) {
            const failed: IPairingState = createIdleState(generation, this.safeStateError(error));
            await this.github.updateIssueState(target, failed).catch(() => undefined);
            this.auditState("lease.error_published", failed);
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
        expectedHostLogin?: string,
    ): Promise<void> {
        const deadline: number = Date.now() + startingLeaseMs;
        const stateAdvanceDeadline: number = Date.now() + candidateLifetimeMs;
        let nextCodespaceOpenAt: number = hostCodespaceName ? Date.now() + codespaceOpenRetryMs : Number.MAX_VALUE;
        let openAttempt: number = 1;
        while (Date.now() < deadline) {
            this.throwIfCancelled(token);
            const state: IPairingState = await this.github.getIssueState(target);
            this.auditState("lease.wait_poll", state, {
                expectedGeneration: generation,
                openAttempt,
            });
            if (state.generation < generation && Date.now() >= stateAdvanceDeadline) {
                throw this.hostFailure(
                    login, expectedHostLogin, "The elected candidate did not claim the host lease.",
                );
            }
            if (state.generation > generation || (state.generation === generation && !isLeaseActive(state))) {
                throw this.hostFailure(
                    login, expectedHostLogin, "The host lease expired before Live Share became ready.",
                );
            }
            if (state.generation === generation && state.status === "ready" && isLeaseActive(state)) {
                await this.followActiveLease(target, state, login, nonce, api, progress, token);
                return;
            }
            const now: number = Date.now();
            if (hostCodespaceName && now >= nextCodespaceOpenAt &&
                canRetryCodespaceOpen(state, generation, login, hostCodespaceName, now)) {
                if (openAttempt >= codespaceOpenMaxAttempts) {
                    throw new Error(
                        `VS Code did not connect to Codespace ${hostCodespaceName} after ` +
                        `${codespaceOpenMaxAttempts} attempts. Open the GitHub Codespaces output channel for details.`,
                    );
                }
                openAttempt++;
                progress.report({ message: `Codespace did not connect; reopening it (attempt ${openAttempt})...` });
                leetCodeChannel.appendLine("[pairing] Codespace did not publish readiness; retrying its open request.");
                pairingAuditLog.event("codespace.open_requested", {
                    generation,
                    codespaceName: hostCodespaceName,
                    attempt: openAttempt,
                });
                try {
                    await this.openCodespace(hostCodespaceName, login, progress);
                } catch (error) {
                    leetCodeChannel.appendLine(`[pairing] Codespace reopen failed: ${this.errorMessage(error)}`);
                    throw error;
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
        throw this.hostFailure(login, expectedHostLogin, "Timed out waiting for the host.");
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
                target, state.generation, login, nonce || "", api, progress, token,
                recoverCodespaceName, state.hostLogin || undefined,
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
            pairingAuditLog.event("live_share.join_skipped_already_guest", { generation: state.generation });
            return;
        }
        if (api.session.role === LiveShareRole.Host) {
            throw new Error("End your current Live Share host session before joining another host.");
        }
        progress.report({ message: `Joining ${state.hostLogin || "your friend"}'s Live Share session...` });
        pairingAuditLog.event("live_share.join_started", {
            generation: state.generation,
            hostLogin: state.hostLogin,
        });
        try {
            await api.join(vscode.Uri.parse(state.joinUrl), { newWindow: false });
            pairingAuditLog.event("live_share.join_succeeded", {
                generation: state.generation,
                hostLogin: state.hostLogin,
            });
        } catch (error) {
            pairingAuditLog.event("live_share.join_failed", {
                generation: state.generation,
                hostLogin: state.hostLogin,
                error: this.safeStateError(error),
            });
            if (!this.isInactiveLiveShareSessionError(error) ||
                !await this.clearUnchangedStaleReadyLease(target, state)) {
                throw error;
            }
            leetCodeChannel.appendLine("[pairing] Removed an inactive Live Share invitation; restarting host election.");
            if (state.hostLogin !== login) {
                throw new Error(
                    `The previous Live Share session from ${state.hostLogin || "the host"} ended. ` +
                    "The waiting participant will not become host automatically; ask the original host to rerun the launcher.",
                );
            }
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
        pairingAuditLog.event("lease.stale_ready_cleared", {
            generation: latest.generation,
            hostLogin: latest.hostLogin,
        });
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
            this.auditState("auto_host.state_read", state, { login, codespaceName });
            if ((state.status !== "starting" && state.status !== "ready") || !isLeaseActive(state) ||
                state.hostLogin !== login || state.codespaceName !== codespaceName || !state.hostNonce) {
                return;
            }

            const api: ILiveShareApi = await this.requireLiveShareApi();
            pairingAuditLog.event("auto_host.live_share_ready", {
                generation: state.generation,
                role: api.session.role,
                codespaceName,
            });
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
            pairingAuditLog.event("live_share.share_started", {
                generation: state.generation,
                codespaceName,
                priorRole: api.session.role,
            });
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
            pairingAuditLog.event("live_share.share_succeeded", {
                generation: state.generation,
                codespaceName,
                invitationOrigin: this.describeLinkOrigin(link),
            });

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
            this.auditState("lease.ready_published", ready);
            this.hostedTarget = target;
            this.hostedGeneration = ready.generation;
            this.hostedNonce = ready.hostNonce || undefined;
            this.startHeartbeat();
            this.ensureSessionSubscription(api);
            void vscode.window.showInformationMessage("LeetCode Pairing is hosting. Your friend will join automatically.");
        } catch (error) {
            leetCodeChannel.appendLine(`[pairing] Auto-host check failed: ${this.errorMessage(error)}`);
            pairingAuditLog.event("auto_host.failed", { error: this.safeStateError(error) });
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
            this.auditState("lease.heartbeat", state);
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
                pairingAuditLog.event("lease.released", { generation: state.generation });
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
        if (reusable) {
            pairingAuditLog.event("codespace.reused", {
                codespaceName: reusable.name,
                state: reusable.state,
            });
            return reusable.name;
        }
        pairingAuditLog.event("codespace.create_started", { repository: target.repository });
        const created: string = await this.github.createCodespace(target);
        pairingAuditLog.event("codespace.create_succeeded", { codespaceName: created });
        return created;
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
            pairingAuditLog.event("codespace.state_read", { codespaceName: name, state });
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

    private async openCodespace(
        name: string,
        expectedLogin: string,
        progress: vscode.Progress<{ message?: string }>,
    ): Promise<void> {
        if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) {
            throw new Error("Refusing to open an invalid Codespace name.");
        }
        const codespacesExtension: vscode.Extension<unknown> | undefined =
            vscode.extensions.getExtension("GitHub.codespaces");
        if (!codespacesExtension) {
            throw new Error("GitHub Codespaces is not installed in this local VS Code profile.");
        }
        await codespacesExtension.activate();
        pairingAuditLog.event("codespace.extension_activated", {
            version: codespacesExtension.packageJSON.version || "unknown",
            extensionKind: codespacesExtension.extensionKind,
        });

        let accounts: readonly vscode.AuthenticationSessionAccountInformation[] =
            await vscode.authentication.getAccounts("github");
        if (!accounts.some((account) => account.label.toLowerCase() === expectedLogin.toLowerCase())) {
            progress.report({ message: `Signing VS Code into GitHub as ${expectedLogin}...` });
            const signInCommand: string = accounts.length === 0
                ? "github.codespaces.signIn"
                : "github.codespaces.switchUserAccount";
            await vscode.commands.executeCommand(signInCommand);
            accounts = await vscode.authentication.getAccounts("github");
        }
        if (!accounts.some((account) => account.label.toLowerCase() === expectedLogin.toLowerCase())) {
            const visibleAccounts: string = accounts.map((account) => account.label).join(", ") || "none";
            throw new Error(
                `VS Code GitHub account (${visibleAccounts}) does not match GitHub CLI account ` +
                `(${expectedLogin}). Use 'Codespaces: Switch User Account' and select ${expectedLogin}.`,
            );
        }

        leetCodeChannel.appendLine(`[pairing] Asking GitHub Codespaces to connect to ${name}.`);
        pairingAuditLog.event("codespace.connect_command_started", {
            codespaceName: name,
            expectedLogin,
        });
        await vscode.commands.executeCommand("github.codespaces.connect", { codespaceName: name });
        pairingAuditLog.event("codespace.connect_command_returned", { codespaceName: name });
    }

    private async ensureLocalExtensionKinds(): Promise<void> {
        const configuration: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("remote");
        const existing: { [extensionId: string]: string[] } =
            configuration.get<{ [extensionId: string]: string[] }>("extensionKind", {});
        const required: { [extensionId: string]: string[] } = {
            "LeetCode.vscode-leetcode": ["ui"],
            "GitHub.codespaces": ["ui"],
            "ms-vsliveshare.vsliveshare": ["ui"],
            "pomdtr.excalidraw-editor": ["ui"],
        };
        const merged: { [extensionId: string]: string[] } = { ...existing, ...required };
        const changed: boolean = Object.keys(required).some((extensionId: string) =>
            JSON.stringify(existing[extensionId]) !== JSON.stringify(required[extensionId]),
        );
        if (changed) {
            await configuration.update("extensionKind", merged, vscode.ConfigurationTarget.Global);
        }
        pairingAuditLog.event("extension_kinds.verified", {
            changed,
            liveShare: (merged["ms-vsliveshare.vsliveshare"] || []).join(","),
            codespaces: (merged["GitHub.codespaces"] || []).join(","),
        });
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

    private auditState(event: string, state: IPairingState, fields: PairingAuditFields = {}): void {
        pairingAuditLog.event(event, {
            generation: state.generation,
            status: state.status,
            hostLogin: state.hostLogin,
            codespaceName: state.codespaceName,
            updatedAt: state.updatedAt,
            leaseExpiresAt: state.leaseExpiresAt,
            hasJoinUrl: Boolean(state.joinUrl),
            error: state.error,
            ...fields,
        });
    }

    private namedError(name: string, message: string): Error {
        const error: Error = new Error(message);
        error.name = name;
        return error;
    }

    private hostFailure(login: string, expectedHostLogin: string | undefined, message: string): Error {
        if (expectedHostLogin && expectedHostLogin !== login) {
            return new Error(
                `${message} ${expectedHostLogin} must rerun the launcher; ` +
                `${login} will remain a guest and will not open another Codespace automatically.`,
            );
        }
        return this.namedError(retryElectionErrorName, message);
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
