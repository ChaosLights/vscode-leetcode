// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import { workspace, WorkspaceConfiguration } from "vscode";
import { DescriptionConfiguration } from "../shared";
import { IUserWorkspaceFolderMap, resolveUserWorkspaceFolder } from "./workspacePathUtils";

export function getWorkspaceConfiguration(): WorkspaceConfiguration {
    return workspace.getConfiguration("leetcode");
}

export function shouldHideSolvedProblem(): boolean {
    return getWorkspaceConfiguration().get<boolean>("hideSolved", false);
}

export function getWorkspaceFolder(username?: string): string {
    const config: WorkspaceConfiguration = getWorkspaceConfiguration();
    const foldersByUser: IUserWorkspaceFolderMap = config.get<IUserWorkspaceFolderMap>("workspaceFolderByUser", {});
    return resolveUserWorkspaceFolder(foldersByUser, username, config.get<string>("workspaceFolder", ""));
}

export function getEditorShortcuts(): string[] {
    return getWorkspaceConfiguration().get<string[]>("editor.shortcuts", ["submit", "test", "solution", "description"]);
}

export function shouldUseEndpointTranslation(): boolean {
    return getWorkspaceConfiguration().get<boolean>("useEndpointTranslation", true);
}

export function getDescriptionConfiguration(): IDescriptionConfiguration {
    const setting: string = getWorkspaceConfiguration().get<string>("showDescription", DescriptionConfiguration.InWebView);
    const config: IDescriptionConfiguration = {
        showInComment: false,
        showInWebview: true,
    };
    switch (setting) {
        case DescriptionConfiguration.Both:
            config.showInComment = true;
            config.showInWebview = true;
            break;
        case DescriptionConfiguration.None:
            config.showInComment = false;
            config.showInWebview = false;
            break;
        case DescriptionConfiguration.InFileComment:
            config.showInComment = true;
            config.showInWebview = false;
            break;
        case DescriptionConfiguration.InWebView:
            config.showInComment = false;
            config.showInWebview = true;
            break;
    }

    // To be compatible with the deprecated setting:
    if (getWorkspaceConfiguration().get<boolean>("showCommentDescription")) {
        config.showInComment = true;
    }

    return config;
}

export interface IDescriptionConfiguration {
    showInComment: boolean;
    showInWebview: boolean;
}
