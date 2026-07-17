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
- 恢复原生 CodeLens，但 provider 只注册 `file:`、`untitled:` 和 `vscode-remote:`，不注册来宾共享文件使用的 `vsls:`。因此主机生成一套，Live Share 只向来宾转发这一套，来宾插件不会再追加第二套。
- 每个 CodeLens 都使用 Live Share 1.1.122 明确允许在来宾本地执行的 `editor.action.showReferences`。空结果列表只在点击窗口产生一个短暂光标信号；本地桥接器立即恢复原选择，并把它还原为 Submit/Test/Solution/Description/Star 操作。最终命令参数使用点击端的 `file:`、`vscode-remote:` 或 `vsls:` URI 和本端账号，不会回到主持人账号。标题栏火箭和右键 `LeetCode` 菜单继续作为关闭 CodeLens 时的兜底。
- Codespaces 断线重连后会对可见的有效题解做两次有界 provider 刷新；Live Share 来宾首次请求若因协同版本尚未同步而返回空，也会触发两次有界的 registry 重取。重取用的是永远不匹配文档的空 provider，Live Share 的独占 provider 仍是唯一结果来源，因此不会产生第二套按钮。
- Solution/Description 使用 VS Code 的 `openTextDocument(Uri)` 读取共享文档，并从 `@lc ... id=...` 头部取得题号，不再读取 `Uri.fsPath`。
- Submit/Test 将共享文档的当前文本写入点击者电脑的临时目录，调用点击者本地 CLI，完成后在成功、失败和取消路径统一清理临时目录。
- 本地 CLI 使用独立的 Node.js 20+ 子进程执行，不把 `Code.exe` 或 Electron Worker 当作脚本运行器。每位参与者需要确保 `node` 位于 `PATH`；也可以在 `leetcode.nodePath` 中填写完整路径。
- 仓库可在 `.vscode/settings.json` 中用 `leetcode.workspaceFolderByUser` 保存“LeetCode 用户名 → 工作区相对目录”映射。每个本地 UI 扩展根据自己的登录账号选择目录，无需个人 User Settings；缺少映射时会明确报错，不会回退到工作区根目录。
- 从 Explorer 选择 `Show Problem` 时，Codespace 主持人和 Live Share 来宾都使用 VS Code 的 `workspace.fs`。主持人操作原始 `vscode-remote:` URI；来宾操作 Live Share 注册的 `vsls:` FileSystemProvider，由 Live Share 自己把新建请求送到 Codespace，并按真实发起者检查读写权限。本 fork 不再调用 Live Share 私有扩展 API，也不再注册自定义 RPC。
- 新文件写完后会读回校验，并对 Live Share 文件树传播延迟做有限重试。只读来宾会得到明确提示；路径、模板大小和符号链接会经过安全检查。同一路径已经有题解时只打开原文件，绝不覆盖。
- 结果仍使用原有 Webview。由于命令现在在点击者本地执行，结果自然只显示在点击者窗口。
- Explorer 内置固定的 `NeetCode 150` 根分类和 18 个子分类。它只筛选当前 LeetCode 题目列表，不包含题面，也不改变 Premium 权限。

CLI HOME 隔离在该 VS Code Profile 的扩展 `globalStorage` 下；它不再读取、删除或与其他 Profile 共用用户主目录的 `~/.lc`。扩展将恢复用 Cookie 保存在本地 VS Code 的加密 SecretStorage 中，用户状态保存在 globalState；这些位置都不会通过 Live Share 共享。

## 登录持久化

登录成功后，扩展同时维护两份状态：

1. VS Code SecretStorage 保存完整 Cookie，作为可恢复的本地凭据。
2. 遗留 LeetCode CLI 为执行请求会把完整运行会话写到本扩展私有的 `globalStorage/cli-home/.lc/<endpoint>/user.json`。扩展在支持的文件系统上把目录和文件权限收紧为仅当前用户可访问。

启动时先验证 SecretStorage 中的 Cookie，再复用已迁移的隔离 CLI 会话；如果会话丢失，扩展会自动重建。首次从 v0.19.x 升级会迁移到隔离目录。旧的用户级 `~/.lc` 会原样保留，避免破坏独立安装的 LeetCode CLI；本扩展以后不会再使用或删除它。只有显式执行 `LeetCode: Sign Out` 才会清除本 Profile 的 SecretStorage 和隔离 CLI 状态。

使用桌面版 VS Code 并把扩展安装在本地 UI 侧时，Codespace rebuild 不会清除本地 SecretStorage。以下情况仍需要重新登录：LeetCode Cookie 已过期或被服务端撤销、用户显式退出、切换 LeetCode/LeetCode CN endpoint、新电脑或新的 VS Code Profile，以及只使用浏览器版 Codespaces。

## 安装

1. 主机和所有来宾都使用桌面版 VS Code 1.100.0+ 和已验证的 Live Share 1.1.122，从 [v0.21.2 Release](https://github.com/ChaosLights/vscode-leetcode/releases/tag/v0.21.2) 下载并在各自桌面版 VS Code 本地安装同一个 `vscode-leetcode-live-share-0.21.2.vsix`，不要把它安装到 Codespace 容器。
2. 两端执行 `Developer: Reload Window`。
3. 两端分别执行 `LeetCode: Sign In`，登录各自账号，并选择各自需要的 LeetCode endpoint。
4. 主机开始可读写的 Live Share 会话，来宾打开主机分享的 LeetCode 题目文件。`@lc code=end` 旁的 `Submit | Test | Solution | Description` 是本地账号操作入口；两端应各自只看到一套。若没有显示，请把 `editor.codeLens` 设为 `true`，也可使用标题栏火箭或右键 `LeetCode` 菜单。来宾从 Explorer 创建题目时，由 Live Share 官方文件提供器按来宾权限写入 Codespace，不要求主持人逐次确认。
5. 可通过 `Developer: Show Running Extensions` 确认 LeetCode 运行在每一端的 Local/UI extension host。
6. 遇到问题时执行 `LeetCode: Diagnose Pairing`。输出会列出扩展/VS Code/Live Share/Node 版本、运行位置、Workspace Trust、各工作区 scheme 的可写性、当前语言作用域下的 CodeLens 配置来源，以及实际 provider 返回的按钮数量，但不会收集账号名、凭据或完整路径。

共享仓库可以按账号配置不同目录，而不修改任何一端的 User Settings：

```json
"leetcode.workspaceFolderByUser": {
    "wucan": "code/wucan",
    "wangchu": "code/wangchu"
}
```

键必须是插件状态栏显示的 LeetCode 用户名，值必须是当前共享工作区内的相对目录。

来宾不需要把 `liveshare.languages.allowGuestCommandControl` 设置为 `true`。本 fork 转发的 CodeLens 只携带 Live Share 自身白名单里的 `editor.action.showReferences`，Live Share 在来宾本地执行它；实际 LeetCode 命令不会进入主机的远程命令通道。该设置继续保持默认 `false`，防止其他扩展把主机命令暴露给来宾。

`.devcontainer/devcontainer.json` 的 `customizations.vscode.extensions` 和容器生命周期脚本中执行的 `code --install-extension` 安装到 Codespace/Remote 侧，不会安装到桌面 VS Code 的 Local 侧。不要用这两种方式安装本定制 VSIX；它们仍适合安装需要访问 Codespace 工具链的语言、调试和 Lint 扩展。

## 双机验收

在主机账号 A、来宾账号 B 下分别检查：

| 操作 | 发起方应看到 | 另一方应看到 | 使用账号 |
| --- | --- | --- | --- |
| 打开题解 | `@lc code=end` 旁只有一套 CodeLens | 来宾只收到主机转发的一套，不重复 | 尚不调用账号 |
| Test | 本地测试输入框、进度和 Submission Webview | 不弹窗 | 发起方账号 |
| Submit | 本地进度和 Submission Webview | 不弹窗 | 发起方账号 |
| Solution | 本地语言选择和 Solution Webview | 不弹窗 | 发起方账号 |
| Description | 本地 Description Webview | 不弹窗 | 发起方账号 |
| Show Problem（主持人发起） | 文件直接出现在 Codespace | 实时看到新文件 | 发起方只负责拉取题面，文件属于共享工作区 |
| Show Problem（来宾发起） | 自动打开共享文件 | 实时看到新文件 | 来宾本地账号拉取题面，Live Share 文件提供器写入 Codespace |
| 对已有题目再次 Code Now | 打开并保留当前答案 | 文件内容不变 | 不发起提交，只保护共享题解 |
| 删除生成文件后再次 Code Now | 等待 Live Share 删除缓存同步后重新生成 | 使用不覆盖的原子重命名；若别人已重建则保留对方文件 | 可取消等待，不会静默卡住同一道题 |
| 只读来宾 Code Now（新题） | 明确提示向主持人申请读写权限 | 不创建文件 | 无 |

提交后分别刷新两端 LeetCode Explorer，题目状态应只反映各自账号。来宾取消 Test、CLI 报错或 WSL 路径转换失败后，本机临时目录中不应残留 `vscode-leetcode-*` 目录。

## 运行条件

- 每位参与者需要桌面版 VS Code 1.100.0+、已验证的 Live Share 1.1.122、此定制扩展，以及本机 `PATH` 中可执行的外部 Node.js 20+。
- VS Code Web 没有本地 Node extension host，本扩展的 CLI 架构不支持在浏览器版中完成这套本地账号流程。
- 主机从桌面版 VS Code 连接 Codespace 时，题目文件位于云端 `/workspaces/...`，但 LeetCode 扩展、账号和 CLI 仍在主机本地运行；共享文档会临时物化到本地后再交给 CLI。
- Live Share 官方文档说明来宾没有主机的本地文件系统，不能使用 Node `fs`；本 fork 没有使用 Node `fs`。它使用 VS Code 的 `workspace.fs`，由当前 Live Share 注册的 `vsls:` FileSystemProvider 处理，参见 [Virtual Workspaces](https://code.visualstudio.com/api/extension-guides/virtual-workspaces) 与 [Extensions and ecosystem support](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/extensions)。
- v0.21.2 已用 VS Code 1.119 Extension Host 验证 `vscode-remote:` scheme 的 CodeLens、可见远程编辑器的延迟 provider 刷新、来宾首次空结果后的有界 registry 重取、单套结果、四个操作使用来宾 URI、重复点击和光标恢复，并继续覆盖新建、删除后重建、Live Share 正负缓存延迟、已有文件保护、符号链接拒绝和只读拒绝；实现同时针对本机 Live Share 1.1.122 的独占 selector、命令白名单、参数转换和 30 秒文件缓存检查。Live Share 已进入维护模式；若版本不同，升级后应重新做双机“不重复且各自账号”验收。
- 本 fork 不再发送任何遥测，不上报 LeetCode 用户名、题号或本地/共享路径。启动日志只记录扩展、VS Code、Node、平台和工作区 URI scheme，不记录 Cookie 或 token。
- VS Code 的 `extensionKind` 运行位置语义参见 [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)。
