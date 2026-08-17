// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

/**
 * Coalesces concurrent calls into one operation while it is in flight.
 * The completed operation is never cached, so a later call can try again
 * after either success or failure.
 */
export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
    let activeOperation: Promise<T> | undefined;

    return (): Promise<T> => {
        if (activeOperation) {
            return activeOperation;
        }

        const currentOperation: Promise<T> = Promise.resolve().then(operation);
        activeOperation = currentOperation;
        const clearCurrentOperation = (): void => {
            if (activeOperation === currentOperation) {
                activeOperation = undefined;
            }
        };
        currentOperation.then(clearCurrentOperation, clearCurrentOperation);
        return currentOperation;
    };
}
