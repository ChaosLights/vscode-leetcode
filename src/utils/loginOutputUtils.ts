// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

export interface ICliLoginOutputState {
    failed: boolean;
    requestsCookie: boolean;
    requestsLogin: boolean;
    succeeded: boolean;
}

export type CliLoginOutputAction = "fail" | "none" | "sendCookie" | "sendLogin" | "succeed";

export function inspectCliLoginOutput(output: string): ICliLoginOutputState {
    return {
        failed: /.*\[ERROR\].*/i.test(output),
        requestsCookie: /cookie:\s*/i.test(output),
        requestsLogin: /login:\s*/i.test(output),
        succeeded: /Successfully .*login as /i.test(output),
    };
}

export function determineCliLoginOutputAction(
    state: ICliLoginOutputState,
    sentLogin: boolean,
    sentCookie: boolean,
): CliLoginOutputAction {
    if (state.failed) {
        return "fail";
    }
    if (state.succeeded) {
        return "succeed";
    }
    if (state.requestsLogin && !sentLogin) {
        return "sendLogin";
    }
    if (state.requestsCookie && !sentCookie) {
        return "sendCookie";
    }
    return "none";
}

export function didCliLoginSucceed(
    exitCode: number | null,
    state: ICliLoginOutputState,
): boolean {
    return exitCode === 0 && !state.failed && state.succeeded;
}
