// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { leetCodeExecutor } from "../leetCodeExecutor";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeManager } from "../leetCodeManager";
import { IProblem, ProblemState, UserStatus } from "../shared";
import * as settingUtils from "../utils/settingUtils";
import { DialogType, promptForOpenOutputChannel } from "../utils/uiUtils";

export async function listProblems(): Promise<IProblem[]> {
    if (leetCodeManager.getStatus() === UserStatus.SignedOut) {
        return [];
    }

    let firstError: any;
    for (let attempt: number = 0; attempt < 2; attempt++) {
        try {
            return await loadProblems();
        } catch (error) {
            leetCodeChannel.appendLine(
                `Failed to load LeetCode problems (attempt ${attempt + 1}): ${getErrorMessage(error)}`,
            );
            firstError = firstError || error;
            if (attempt === 0 && await leetCodeManager.repairCliLogin()) {
                continue;
            }
            break;
        }
    }

    leetCodeManager.markCliSessionUnavailable();
    await promptForOpenOutputChannel(
        `Failed to list problems: ${getErrorMessage(firstError)} Please sign in again or open the output channel for details.`,
        DialogType.error,
    );
    return [];
}

async function loadProblems(): Promise<IProblem[]> {
    const useEndpointTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
    const result: string = await leetCodeExecutor.listProblems(true, useEndpointTranslation);
    const problems: IProblem[] = [];
    const lines: string[] = result.split("\n");
    const reg: RegExp = /^(.)\s(.{1,2})\s(.)\s\[\s*(\d*)\s*\]\s*(.*)\s*(Easy|Medium|Hard)\s*\((\s*\d+\.\d+ %)\)/;
    const { companies, tags } = await leetCodeExecutor.getCompaniesAndTags();
    for (const line of lines) {
        const match: RegExpMatchArray | null = line.match(reg);
        if (match && match.length === 8) {
            const id: string = match[4].trim();
            problems.push({
                id,
                isFavorite: match[1].trim().length > 0,
                locked: match[2].trim().length > 0,
                state: parseProblemState(match[3]),
                name: match[5].trim(),
                difficulty: match[6].trim(),
                passRate: match[7].trim(),
                companies: companies[id] || ["Unknown"],
                tags: tags[id] || ["Unknown"],
            });
        }
    }
    if (problems.length === 0) {
        throw new Error("The LeetCode CLI returned no recognizable problems.");
    }
    return problems.reverse();
}

function getErrorMessage(error: any): string {
    return error instanceof Error ? error.message : String(error);
}

function parseProblemState(stateOutput: string): ProblemState {
    if (!stateOutput) {
        return ProblemState.Unknown;
    }
    switch (stateOutput.trim()) {
        case "v":
        case "✔":
        case "√":
            return ProblemState.AC;
        case "X":
        case "✘":
        case "×":
            return ProblemState.NotAC;
        default:
            return ProblemState.Unknown;
    }
}
