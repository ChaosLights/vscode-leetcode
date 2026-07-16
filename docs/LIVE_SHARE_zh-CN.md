# Live Share 独立账号支持

## 目标

主机和每个来宾都在自己的电脑上运行 LeetCode 扩展，使用各自电脑上的 LeetCode 登录会话。任一参与者点击 `Submit`、`Test`、`Solution` 或 `Description` 时，请求和结果界面只属于点击者。

## 原问题

1. CodeLens provider 只注册了 `file:`。Live Share 来宾看到的共享文件是 `vsls:`，所以来宾本地扩展不会生成 CodeLens。
2. 来宾看到的是 Live Share 从主机转发的 CodeLens。若来宾本地扩展也注册 `vsls:` CodeLens，就会同时出现两套入口；其中一套命令还会在主机扩展宿主执行。
3. Submission、Solution 和 Description 使用 `window.createWebviewPanel`。命令既然在主机执行，Webview 也只会出现在主机窗口。
4. Submit/Test 把 `Uri.fsPath` 直接交给 CLI。来宾没有主机文件系统路径，即使强制命令在来宾执行，CLI 仍无法读取 `vsls:` 文档。

这不是 cookie 选择错误，而是命令执行位置错误。复制、转发或临时切换主机 cookie 会泄露凭据，并且无法解决 UI 出现在主机的问题。

## 改造

- `package.json` 声明 `extensionKind: ["ui"]`，将该账号型扩展固定在每位用户的本地 UI 扩展宿主。
- 使用 `onStartupFinished` 激活每位参与者的本地扩展。
- 不再注册任何 CodeLens provider，从根源上消除“主持人转发一套、来宾本地再生成一套”的重复问题。题目文件激活时，编辑器标题栏会显示本地火箭按钮；右键菜单也保留 `LeetCode` 操作。两者都是点击者本地 UI 扩展贡献的命令，不会作为语言服务结果被 Live Share 转发。
- Solution/Description 使用 VS Code 的 `openTextDocument(Uri)` 读取共享文档，并从 `@lc ... id=...` 头部取得题号，不再读取 `Uri.fsPath`。
- Submit/Test 将共享文档的当前文本写入点击者电脑的临时目录，调用点击者本地 CLI，完成后在成功、失败和取消路径统一清理临时目录。
- 本地 CLI 恢复使用官方扩展的独立 `node` 子进程执行，不再把 `Code.exe` 或 Electron Worker 当作脚本运行器。每位参与者需要在本机安装 Node.js 并确保 `node` 位于 `PATH`；也可以在 `leetcode.nodePath` 中填写完整路径。
- 仓库可在 `.vscode/settings.json` 中用 `leetcode.workspaceFolderByUser` 保存“LeetCode 用户名 → 工作区相对目录”映射。每个本地 UI 扩展根据自己的登录账号选择目录，无需个人 User Settings；缺少映射时会明确报错，不会回退到工作区根目录。
- 从 Explorer 选择 `Show Problem` 时，Codespace 主持人使用 `workspace.fs.createDirectory/writeFile` 和原始 `vscode-remote:` URI 写入云端工作区。Live Share 读写来宾会把“相对路径 + 题目模板”通过固定版本的 Live Share RPC 发给主持人；主持人端验证目标仍在所选工作区后，直接通过主持人的工作区 URI 落盘，不检查模板大小、不弹确认框，并覆盖同一路径的已有文件。请求不会使用点击者本地路径。
- 结果仍使用原有 Webview。由于命令现在在点击者本地执行，结果自然只显示在点击者窗口。
- Explorer 内置固定的 `NeetCode 150` 根分类和 18 个子分类。它只筛选当前 LeetCode 题目列表，不包含题面，也不改变 Premium 权限。

CLI 的配置文件位于执行机器用户目录下的 `.lc/config.json`。扩展将 Cookie 保存在该用户本地 VS Code 的加密 SecretStorage 中，用户状态保存在 globalState；Live Share 不共享这些位置。

## 登录持久化

登录成功后，扩展同时维护两份状态：

1. VS Code SecretStorage 保存完整 Cookie，作为可恢复的本地凭据。
2. LeetCode CLI 将解析后的 session 写入执行机器用户目录下的 `.lc` 缓存。

启动时优先检查 CLI。如果 `.lc` 因清理或环境变化而丢失，扩展会验证 SecretStorage 中的 Cookie，并自动重建 CLI 登录。临时网络错误或 CLI 启动失败不会再删除已保存 Cookie；只有显式执行 `LeetCode: Sign Out` 才会清除 SecretStorage 和 CLI 状态。

使用桌面版 VS Code 并把扩展安装在本地 UI 侧时，Codespace rebuild 不会清除本地 SecretStorage。以下情况仍需要重新登录：LeetCode Cookie 已过期或被服务端撤销、用户显式退出、切换 LeetCode/LeetCode CN endpoint、新电脑或新的 VS Code Profile，以及只使用浏览器版 Codespaces。

## 安装

1. 主机和所有来宾都从 [v0.19.11 Release](https://github.com/ChaosLights/vscode-leetcode/releases/tag/v0.19.11) 下载并在各自桌面版 VS Code 本地安装同一个 `vscode-leetcode-live-share-0.19.11.vsix`，不要把它安装到 Codespace 容器。
2. 两端执行 `Developer: Reload Window`。
3. 两端分别执行 `LeetCode: Sign In`，登录各自账号，并选择各自需要的 LeetCode endpoint。
4. 主机开始 Live Share，会话来宾打开主机分享的 LeetCode 题目文件。编辑器标题栏的火箭按钮和右键 `LeetCode` 菜单是本地账号操作入口。来宾从 Explorer 创建题目时，经过安全校验后直接进入 Codespace，不要求主持人逐次确认。
5. 可通过 `Developer: Show Running Extensions` 确认 LeetCode 运行在每一端的 Local/UI extension host。

共享仓库可以按账号配置不同目录，而不修改任何一端的 User Settings：

```json
"leetcode.workspaceFolderByUser": {
    "wucan": "code/wucan",
    "wangchu": "code/wangchu"
}
```

键必须是插件状态栏显示的 LeetCode 用户名，值必须是当前共享工作区内的相对目录。

来宾不需要把 `liveshare.languages.allowGuestCommandControl` 设置为 `true`。本 fork 不发布 CodeLens；该设置继续保持默认 `false`，防止其他扩展把主机命令暴露给来宾。

`.devcontainer/devcontainer.json` 的 `customizations.vscode.extensions` 和容器生命周期脚本中执行的 `code --install-extension` 安装到 Codespace/Remote 侧，不会安装到桌面 VS Code 的 Local 侧。不要用这两种方式安装本定制 VSIX；它们仍适合安装需要访问 Codespace 工具链的语言、调试和 Lint 扩展。

## 双机验收

在主机账号 A、来宾账号 B 下分别检查：

| 操作 | 发起方应看到 | 另一方应看到 | 使用账号 |
| --- | --- | --- | --- |
| Test | 本地测试输入框、进度和 Submission Webview | 不弹窗 | 发起方账号 |
| Submit | 本地进度和 Submission Webview | 不弹窗 | 发起方账号 |
| Solution | 本地语言选择和 Solution Webview | 不弹窗 | 发起方账号 |
| Description | 本地 Description Webview | 不弹窗 | 发起方账号 |
| Show Problem（主持人发起） | 文件直接出现在 Codespace | 实时看到新文件 | 发起方只负责拉取题面，文件属于共享工作区 |
| Show Problem（来宾发起） | 自动打开共享文件 | 实时看到新文件 | 来宾本地账号拉取题面，主持人自动代理写入 Codespace |

提交后分别刷新两端 LeetCode Explorer，题目状态应只反映各自账号。来宾取消 Test、CLI 报错或 WSL 路径转换失败后，本机临时目录中不应残留 `vscode-leetcode-*` 目录。

## 运行条件

- 每位参与者需要桌面版 VS Code、此定制扩展，以及本机 `PATH` 中可执行的外部 Node.js；这是官方扩展原有的 CLI 运行方式。
- VS Code Web 没有本地 Node extension host，本扩展的 CLI 架构不支持在浏览器版中完成这套本地账号流程。
- 主机从桌面版 VS Code 连接 Codespace 时，题目文件位于云端 `/workspaces/...`，但 LeetCode 扩展、账号和 CLI 仍在主机本地运行；共享文档会临时物化到本地后再交给 CLI。
- Live Share 官方说明来宾文档使用 `vsls:` 且来宾没有主机文件系统访问权；这正是来宾创建文件必须走主持人 RPC、不能只替换成 `workspace.fs` 后就宣称完成的原因，参见 [Extensions and ecosystem support](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/extensions)。
- Live Share RPC 只有在两端都安装本 fork 且主持人正在提供服务时可用。只读会话会拒绝请求；读写请求只校验协议字段、路径长度，以及目标没有通过绝对路径或 `..` 跳出所选工作区。模板没有大小限制，同一路径的已有文件会被直接覆盖。
- VS Code 的 `extensionKind` 运行位置语义参见 [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)。
