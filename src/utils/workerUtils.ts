// Copyright (c) ChaosLights. All rights reserved.
// Licensed under the MIT license.

import { Worker } from "worker_threads";

export interface IWorkerOutput {
    exitCode: number;
    stderr: string;
    stdout: string;
}

// A Worker's "exit" event can arrive before its piped stdout/stderr streams
// have finished draining, especially on Windows with large command output.
// Do not expose a partial result until both output streams have ended.
export function collectWorkerOutput(
    worker: Worker,
    onStdout?: (text: string) => void,
    onStderr?: (text: string) => void,
): Promise<IWorkerOutput> {
    return new Promise<IWorkerOutput>((resolve: (output: IWorkerOutput) => void, reject: (error: Error) => void) => {
        let exitCode: number | undefined;
        let stderr: string = "";
        let stderrEnded: boolean = false;
        let stdout: string = "";
        let stdoutEnded: boolean = false;
        let settled: boolean = false;

        const finishIfComplete = (): void => {
            if (settled || exitCode === undefined || !stdoutEnded || !stderrEnded) {
                return;
            }
            settled = true;
            resolve({ exitCode, stderr, stdout });
        };

        worker.stdout.on("data", (data: string | Buffer) => {
            const text: string = data.toString();
            stdout += text;
            if (onStdout) {
                onStdout(text);
            }
        });
        worker.stdout.on("end", () => {
            stdoutEnded = true;
            finishIfComplete();
        });
        worker.stderr.on("data", (data: string | Buffer) => {
            const text: string = data.toString();
            stderr += text;
            if (onStderr) {
                onStderr(text);
            }
        });
        worker.stderr.on("end", () => {
            stderrEnded = true;
            finishIfComplete();
        });
        worker.on("error", (error: Error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        worker.on("exit", (code: number) => {
            exitCode = code;
            finishIfComplete();
        });
    });
}
