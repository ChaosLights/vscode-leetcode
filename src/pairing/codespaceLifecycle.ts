// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

// Codespace lifecycle decisions for the pairing host.
//
// The overriding rule is that the launcher must never hide a participant's
// work by silently creating a fresh Codespace while an existing one is still
// recoverable. GitHub reports transitional states such as `ShuttingDown` for
// up to a few minutes after an idle stop, so any allow-list of "healthy"
// states eventually misses one. Only states proving that GitHub no longer
// holds the workspace may cause a replacement to be created.

export interface ICodespaceSummary {
    name: string;
    state: string;
    lastUsedAt: string;
}

export interface ICodespaceStartupHooks {
    getState(): Promise<string>;
    start(): Promise<void>;
    wait(ms: number): Promise<void>;
    throwIfCancelled(): void;
    now(): number;
    onState(state: string): void;
    report(message: string): void;
}

// The workspace no longer exists; a replacement may be created.
const discardedStates: ReadonlySet<string> = new Set<string>(["Deleted"]);

// The workspace may still hold unpushed work, but GitHub will not start it
// through the public API. The participant must recover it explicitly.
const blockedStates: ReadonlySet<string> = new Set<string>(["Deleted", "Failed", "Unavailable", "Archived"]);

export function selectReusableCodespace(codespaces: ICodespaceSummary[]): ICodespaceSummary | undefined {
    const ranked: Array<{ codespace: ICodespaceSummary; index: number; lastUsed: number }> = codespaces
        .filter((codespace: ICodespaceSummary) => !discardedStates.has(codespace.state))
        .map((codespace: ICodespaceSummary, index: number) => ({
            codespace,
            index,
            lastUsed: parseTimestamp(codespace.lastUsedAt),
        }))
        .sort((left, right) => (right.lastUsed - left.lastUsed) || (left.index - right.index));
    return ranked.length > 0 ? ranked[0].codespace : undefined;
}

export async function waitForCodespaceAvailable(
    name: string,
    hooks: ICodespaceStartupHooks,
    timeoutMs: number,
    pollIntervalMs: number = 5_000,
): Promise<void> {
    const deadline: number = hooks.now() + timeoutMs;
    let startRequested: boolean = false;
    while (hooks.now() < deadline) {
        hooks.throwIfCancelled();
        const state: string = await hooks.getState();
        hooks.onState(state);
        if (state === "Available") {
            return;
        }
        if (blockedStates.has(state)) {
            throw new Error(describeBlockedCodespace(name, state));
        }
        if (state === "Shutdown" && !startRequested) {
            hooks.report("Starting the host Codespace...");
            await hooks.start();
            startRequested = true;
        } else if (state === "ShuttingDown") {
            hooks.report("Waiting for the previous session's Codespace to finish stopping...");
        } else {
            hooks.report(`Waiting for the host Codespace (${state})...`);
        }
        await hooks.wait(pollIntervalMs);
    }
    throw new Error(
        `Codespace ${name} did not become available within ${Math.round(timeoutMs / 60_000)} minutes. ` +
        "No replacement Codespace was created; rerun the launcher to keep waiting for it.",
    );
}

export function describeBlockedCodespace(name: string, state: string): string {
    return `Codespace ${name} cannot be started automatically (state: ${state}). ` +
        "To protect any uncommitted work it still holds, no replacement Codespace was created. " +
        "Recover or delete it at github.com/codespaces, then rerun the launcher.";
}

function parseTimestamp(value: string): number {
    const parsed: number = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
