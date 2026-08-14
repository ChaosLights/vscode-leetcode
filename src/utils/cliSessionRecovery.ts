// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export type JudgeOperationKind = "submit" | "test";

export interface ICliSessionRecoveryHooks {
    onRepair?: () => void;
    onRetry?: (attempt: number, delayMilliseconds: number) => void;
    wait?: (delayMilliseconds: number) => Promise<void>;
}

const firstRetryDelayMilliseconds: number = 5000;
const repairedRetryDelayMilliseconds: number = 10000;

export function isCliSessionExpiredError(error: any): boolean {
    return /(?:\[ERROR\]\s*)?session expired,?\s*please login again/i.test(getCliErrorOutput(error));
}

export function isCliCloudflareChallengeError(error: any): boolean {
    return /Cloudflare security challenge blocked this code payload/i.test(getCliErrorOutput(error));
}

export function canSafelyRetryJudgeOperation(error: any, operationKind: JudgeOperationKind): boolean {
    if (!isCliSessionExpiredError(error)) {
        return false;
    }

    // A test run can be repeated without creating a permanent submission.
    if (operationKind === "test") {
        return true;
    }

    const output: string = getCliErrorOutput(error);
    // Never submit the same solution again if the first process had already
    // received a judge task. The POST is safe to repeat only when the CLI was
    // rejected while it still displayed "Sending code to judge".
    return /Sending code to judge/i.test(output) && !/Waiting for judge result/i.test(output);
}

export async function runWithCliSessionRecovery<T>(
    operationKind: JudgeOperationKind,
    operation: () => Promise<T>,
    repairCliSession: () => Promise<boolean>,
    hooks: ICliSessionRecoveryHooks = {},
): Promise<T> {
    const wait: (delayMilliseconds: number) => Promise<void> = hooks.wait || delay;

    try {
        return await operation();
    } catch (firstError) {
        if (!canSafelyRetryJudgeOperation(firstError, operationKind)) {
            throw firstError;
        }

        hooks.onRetry?.(1, firstRetryDelayMilliseconds);
        await wait(firstRetryDelayMilliseconds);
        try {
            return await operation();
        } catch (secondError) {
            if (!canSafelyRetryJudgeOperation(secondError, operationKind)) {
                throw secondError;
            }

            hooks.onRepair?.();
            if (!await repairCliSession()) {
                throw secondError;
            }

            hooks.onRetry?.(2, repairedRetryDelayMilliseconds);
            await wait(repairedRetryDelayMilliseconds);
            return await operation();
        }
    }
}

function getCliErrorOutput(error: any): string {
    if (!error) {
        return "";
    }
    return [error.result, error.stderr, error.message]
        .filter((value: unknown) => typeof value === "string")
        .join("\n");
}

function delay(delayMilliseconds: number): Promise<void> {
    return new Promise((resolve: () => void) => setTimeout(resolve, delayMilliseconds));
}
