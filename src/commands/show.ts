// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as _ from "lodash";
import * as path from "path";
import * as unescapeJS from "unescape-js";
import * as vscode from "vscode";
import { explorerNodeManager } from "../explorer/explorerNodeManager";
import { LeetCodeNode } from "../explorer/LeetCodeNode";
import { leetCodeTreeDataProvider } from "../explorer/LeetCodeTreeDataProvider";
import { leetCodeChannel } from "../leetCodeChannel";
import { leetCodeExecutor } from "../leetCodeExecutor";
import { leetCodeManager } from "../leetCodeManager";
import { Endpoint, IProblem, IQuickItemEx, languages, PREMIUM_URL_CN, PREMIUM_URL_GLOBAL, ProblemState } from "../shared";
import { genFileExt, genFileName, getNodeIdFromContent } from "../utils/problemUtils";
import * as settingUtils from "../utils/settingUtils";
import { IDescriptionConfiguration } from "../utils/settingUtils";
import {
    DialogOptions,
    DialogType,
    openSettingsEditor,
    openUrl,
    promptForOpenOutputChannel,
    promptForSignIn,
    promptHintMessage,
} from "../utils/uiUtils";
import {
    getSafeRelativePathSegments,
    selectRemoteWorkspaceFolder,
    selectWorkspaceFolder,
} from "../utils/workspaceUtils";
import * as wsl from "../utils/wslUtils";
import { leetCodePreviewProvider } from "../webview/leetCodePreviewProvider";
import { leetCodeSolutionProvider } from "../webview/leetCodeSolutionProvider";
import * as list from "./list";
import { getLeetCodeEndpoint } from "./plugin";
import { globalState } from "../globalState";
import { liveShareFileService } from "../liveshare/LiveShareFileService";

export async function previewProblem(input?: IProblem | vscode.Uri, isSideMode: boolean = false): Promise<void> {
    let node: IProblem;
    const problemInput: IProblem | vscode.Uri | undefined = input || vscode.window.activeTextEditor?.document.uri;

    if (!problemInput) {
        vscode.window.showErrorMessage("Open a generated LeetCode solution file first.");
        return;
    }

    if (problemInput instanceof vscode.Uri) {
        const document: vscode.TextDocument = await vscode.workspace.openTextDocument(problemInput);
        const id: string = getNodeIdFromContent(document.getText());
        if (!id) {
            vscode.window.showErrorMessage(`Failed to resolve the problem id from document: ${problemInput.toString()}.`);
            return;
        }
        let cachedNode: IProblem | undefined = explorerNodeManager.getNodeById(id);
        if (!cachedNode && leetCodeManager.getUser()) {
            await leetCodeTreeDataProvider.refresh();
            cachedNode = explorerNodeManager.getNodeById(id);
        }
        if (!cachedNode) {
            vscode.window.showErrorMessage(`Failed to resolve the problem with id: ${id}.`);
            return;
        }
        node = cachedNode;
        // Move the preview page aside when triggered from an editor action.
        isSideMode = true;
    } else {
        node = problemInput;
        const { isPremium } = globalState.getUserStatus() ?? {};
        if (problemInput.locked && !isPremium) {
            const url = getLeetCodeEndpoint() === Endpoint.LeetCode ? PREMIUM_URL_GLOBAL : PREMIUM_URL_CN;
            openUrl(url);
            return;
        }
    }

    const needTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
    const descString: string = await leetCodeExecutor.getDescription(node.id, needTranslation);
    leetCodePreviewProvider.show(descString, node, isSideMode);
}

export async function pickOne(): Promise<void> {
    const problems: IProblem[] = await list.listProblems();
    const randomProblem: IProblem = problems[Math.floor(Math.random() * problems.length)];
    await showProblemInternal(randomProblem);
}

export async function showProblem(node?: LeetCodeNode): Promise<void> {
    if (!node) {
        return;
    }
    await showProblemInternal(node);
}

export async function searchProblem(): Promise<void> {
    if (!leetCodeManager.getUser()) {
        promptForSignIn();
        return;
    }
    const choice: IQuickItemEx<IProblem> | undefined = await vscode.window.showQuickPick(parseProblemsToPicks(list.listProblems()), {
        matchOnDetail: true,
        placeHolder: "Select one problem",
    });
    if (!choice) {
        return;
    }
    await showProblemInternal(choice.value);
}

export async function showSolution(input?: LeetCodeNode | vscode.Uri): Promise<void> {
    let problemInput: string | undefined;
    const source: LeetCodeNode | vscode.Uri | undefined = input || vscode.window.activeTextEditor?.document.uri;
    if (source instanceof LeetCodeNode) {
        // Triggerred from explorer
        problemInput = source.id;
    } else if (source instanceof vscode.Uri) {
        // Triggered from the local editor action/context menu.
        const document: vscode.TextDocument = await vscode.workspace.openTextDocument(source);
        problemInput = getNodeIdFromContent(document.getText());
    }

    if (!problemInput) {
        vscode.window.showErrorMessage("Invalid input to fetch the solution data.");
        return;
    }

    const language: string | undefined = await fetchProblemLanguage();
    if (!language) {
        return;
    }
    try {
        const needTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
        const solution: string = await leetCodeExecutor.showSolution(problemInput, language, needTranslation);
        leetCodeSolutionProvider.show(unescapeJS(solution));
    } catch (error) {
        leetCodeChannel.appendLine(error.toString());
        await promptForOpenOutputChannel("Failed to fetch the top voted solution. Please open the output channel for details.", DialogType.error);
    }
}

async function fetchProblemLanguage(): Promise<string | undefined> {
    const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
    let defaultLanguage: string | undefined = leetCodeConfig.get<string>("defaultLanguage");
    if (defaultLanguage && languages.indexOf(defaultLanguage) < 0) {
        defaultLanguage = undefined;
    }
    const language: string | undefined =
        defaultLanguage ||
        (await vscode.window.showQuickPick(languages, {
            placeHolder: "Select the language you want to use",
            ignoreFocusOut: true,
        }));
    // fire-and-forget default language query
    (async (): Promise<void> => {
        if (language && !defaultLanguage && leetCodeConfig.get<boolean>("hint.setDefaultLanguage")) {
            const choice: vscode.MessageItem | undefined = await vscode.window.showInformationMessage(
                `Would you like to set '${language}' as your default language?`,
                DialogOptions.yes,
                DialogOptions.no,
                DialogOptions.never
            );
            if (choice === DialogOptions.yes) {
                leetCodeConfig.update("defaultLanguage", language, true /* UserSetting */);
            } else if (choice === DialogOptions.never) {
                leetCodeConfig.update("hint.setDefaultLanguage", false, true /* UserSetting */);
            }
        }
    })();
    return language;
}

async function showProblemInternal(node: IProblem): Promise<void> {
    try {
        const language: string | undefined = await fetchProblemLanguage();
        if (!language) {
            return;
        }

        const leetCodeConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("leetcode");
        const fileFolder: string = leetCodeConfig
            .get<string>(`filePath.${language}.folder`, leetCodeConfig.get<string>(`filePath.default.folder`, ""))
            .trim();
        const fileName: string = leetCodeConfig
            .get<string>(`filePath.${language}.filename`, leetCodeConfig.get<string>(`filePath.default.filename`) || genFileName(node, language))
            .trim();

        const descriptionConfig: IDescriptionConfiguration = settingUtils.getDescriptionConfiguration();
        const needTranslation: boolean = settingUtils.shouldUseEndpointTranslation();
        const hasRemoteWorkspace: boolean = (vscode.workspace.workspaceFolders || [])
            .some((folder: vscode.WorkspaceFolder) => folder.uri.scheme !== "file");
        let finalUri: vscode.Uri;

        if (hasRemoteWorkspace) {
            const remoteFolder: vscode.WorkspaceFolder | undefined = await selectRemoteWorkspaceFolder();
            if (!remoteFolder) {
                return;
            }
            finalUri = await createRemoteProblemFile(
                remoteFolder.uri,
                fileFolder,
                fileName,
                node,
                language,
                descriptionConfig,
                needTranslation,
            );
        } else {
            const workspaceFolder: string = await selectWorkspaceFolder();
            if (!workspaceFolder) {
                return;
            }

            let finalPath: string = path.join(workspaceFolder, fileFolder, fileName);
            finalPath = await resolveRelativePath(finalPath, node, language);
            if (!finalPath) {
                leetCodeChannel.appendLine("Showing problem canceled by user.");
                return;
            }

            finalPath = wsl.useWsl() ? await wsl.toWinPath(finalPath) : finalPath;
            await leetCodeExecutor.showProblem(node, language, finalPath, descriptionConfig.showInComment, needTranslation);
            finalUri = vscode.Uri.file(finalPath);
        }

        const promises: any[] = [
            vscode.window.showTextDocument(finalUri, {
                preview: false,
                viewColumn: vscode.ViewColumn.One,
            }),
            promptHintMessage(
                "hint.commentDescription",
                'You can config how to show the problem description through "leetcode.showDescription".',
                "Open settings",
                (): Promise<any> => openSettingsEditor("leetcode.showDescription")
            ),
        ];
        if (descriptionConfig.showInWebview) {
            promises.push(showDescriptionView(node));
        }

        await Promise.all(promises);
    } catch (error) {
        await promptForOpenOutputChannel(`${error} Please open the output channel for details.`, DialogType.error);
    }
}

async function createRemoteProblemFile(
    workspaceUri: vscode.Uri,
    configuredFolder: string,
    configuredFileName: string,
    node: IProblem,
    language: string,
    descriptionConfig: IDescriptionConfiguration,
    needTranslation: boolean,
): Promise<vscode.Uri> {
    const configuredPath: string = [configuredFolder, configuredFileName]
        .filter((segment: string) => Boolean(segment))
        .join("/");
    const resolvedPath: string = await resolveRelativePath(configuredPath, node, language);
    const pathSegments: string[] = getSafeRelativePathSegments(resolvedPath);
    const finalUri: vscode.Uri = vscode.Uri.joinPath(workspaceUri, ...pathSegments);

    if (workspaceUri.scheme === "vsls") {
        const workspaceFolder: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(finalUri);
        if (!workspaceFolder) {
            throw new Error(`Unable to resolve the shared workspace for: ${finalUri.toString(true)}`);
        }
        const codeTemplate: string = await leetCodeExecutor.getProblemTemplate(
            node,
            language,
            descriptionConfig.showInComment,
            needTranslation,
        );
        await liveShareFileService.createProblemFile(workspaceFolder, resolvedPath, codeTemplate);
    } else {
        const parentSegments: string[] = pathSegments.slice(0, -1);
        if (parentSegments.length) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, ...parentSegments));
        }
        const codeTemplate: string = await leetCodeExecutor.getProblemTemplate(
            node,
            language,
            descriptionConfig.showInComment,
            needTranslation,
        );
        await vscode.workspace.fs.writeFile(finalUri, Buffer.from(codeTemplate, "utf8"));
    }

    return finalUri;
}
async function showDescriptionView(node: IProblem): Promise<void> {
    return previewProblem(node, vscode.workspace.getConfiguration("leetcode").get<boolean>("enableSideMode", true));
}
async function parseProblemsToPicks(p: Promise<IProblem[]>): Promise<Array<IQuickItemEx<IProblem>>> {
    return new Promise(async (resolve: (res: Array<IQuickItemEx<IProblem>>) => void): Promise<void> => {
        const picks: Array<IQuickItemEx<IProblem>> = (await p).map((problem: IProblem) =>
            Object.assign(
                {},
                {
                    label: `${parseProblemDecorator(problem.state, problem.locked)}${problem.id}.${problem.name}`,
                    description: "",
                    detail: `AC rate: ${problem.passRate}, Difficulty: ${problem.difficulty}`,
                    value: problem,
                }
            )
        );
        resolve(picks);
    });
}

function parseProblemDecorator(state: ProblemState, locked: boolean): string {
    switch (state) {
        case ProblemState.AC:
            return "$(check) ";
        case ProblemState.NotAC:
            return "$(x) ";
        default:
            return locked ? "$(lock) " : "";
    }
}

async function resolveRelativePath(relativePath: string, node: IProblem, selectedLanguage: string): Promise<string> {
    let tag: string = "";
    if (/\$\{tag\}/i.test(relativePath)) {
        tag = (await resolveTagForProblem(node)) || "";
    }

    let company: string = "";
    if (/\$\{company\}/i.test(relativePath)) {
        company = (await resolveCompanyForProblem(node)) || "";
    }

    return relativePath.replace(/\$\{(.*?)\}/g, (_substring: string, ...args: string[]) => {
        const placeholder: string = args[0].toLowerCase().trim();
        switch (placeholder) {
            case "id":
                return node.id;
            case "name":
                return node.name;
            case "camelcasename":
                return _.camelCase(node.name);
            case "pascalcasename":
                return _.upperFirst(_.camelCase(node.name));
            case "kebabcasename":
            case "kebab-case-name":
                return _.kebabCase(node.name);
            case "snakecasename":
            case "snake_case_name":
                return _.snakeCase(node.name);
            case "ext":
                return genFileExt(selectedLanguage);
            case "language":
                return selectedLanguage;
            case "difficulty":
                return node.difficulty.toLocaleLowerCase();
            case "tag":
                return tag;
            case "company":
                return company;
            default:
                const errorMsg: string = `The config '${placeholder}' is not supported.`;
                leetCodeChannel.appendLine(errorMsg);
                throw new Error(errorMsg);
        }
    });
}

async function resolveTagForProblem(problem: IProblem): Promise<string | undefined> {
    if (problem.tags.length === 1) {
        return problem.tags[0];
    }
    return await vscode.window.showQuickPick(problem.tags, {
        matchOnDetail: true,
        placeHolder: "Multiple tags available, please select one",
        ignoreFocusOut: true,
    });
}

async function resolveCompanyForProblem(problem: IProblem): Promise<string | undefined> {
    if (problem.companies.length === 1) {
        return problem.companies[0];
    }
    return await vscode.window.showQuickPick(problem.companies, {
        matchOnDetail: true,
        placeHolder: "Multiple tags available, please select one",
        ignoreFocusOut: true,
    });
}
