// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export interface IOperationLease {
    release(): void;
}

export class KeyedOperationLock {
    private readonly activeOperations: Map<string, string> = new Map<string, string>();

    public acquire(key: string, operation: string): IOperationLease | undefined {
        if (this.activeOperations.has(key)) {
            return undefined;
        }
        this.activeOperations.set(key, operation);
        let released: boolean = false;
        return {
            release: (): void => {
                if (!released) {
                    released = true;
                    this.activeOperations.delete(key);
                }
            },
        };
    }

    public getActiveOperation(key: string): string | undefined {
        return this.activeOperations.get(key);
    }
}

export const solutionOperationLock: KeyedOperationLock = new KeyedOperationLock();
