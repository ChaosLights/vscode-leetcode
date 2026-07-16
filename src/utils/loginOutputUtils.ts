// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export interface ICliLoginOutputState {
    failed: boolean;
    requestsCookie: boolean;
    requestsLogin: boolean;
    succeeded: boolean;
}

export function inspectCliLoginOutput(output: string): ICliLoginOutputState {
    return {
        failed: /.*\[ERROR\].*/i.test(output),
        requestsCookie: /cookie:\s*/i.test(output),
        requestsLogin: /login:\s*/i.test(output),
        succeeded: /Successfully .*login as /i.test(output),
    };
}

export function didCliLoginSucceed(
    exitCode: number | null,
    state: ICliLoginOutputState,
): boolean {
    return exitCode === 0 && !state.failed && state.succeeded;
}
