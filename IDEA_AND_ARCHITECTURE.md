# Optimus Code 🚀

> *The Ultimate Multi-Agent Orchestrator. Let models debate, you make the final call.*
> （终极多脑协同引擎。让大模型们（Copilot/Claude/Gemini）去辩论，由你来拍板。）

## 🌟 项目缘起 (Project Genesis)

这个项目的核心思想诞生于 2026 年初的一次头脑风暴。我们发现，单一的大语言模型（LLM）总有其局限性，比如 Copilot 擅长代码补全和语法（因为在编辑器底层），但可能缺乏宏观架构的洞察力；而 Claude / Gemini 长于全局思维和逻辑推理，但跨编辑器复制粘贴非常破坏心流。

如何不产生额外的 API 费用，又能让大厂的顶尖模型为我所用、互相“对线”？

**核心思路：降维打击，利用操作系统的 CLI 层。** 
由于各个 AI 均为各自生态内的“主控客户端（MCP Client）”，它们无法通过优雅的协议相互直接调用（没有人愿意做别人的 Server）。
解决方案是开发一个“拥有上帝视角的 Orchestrator（协调者/总控引擎）”，也就是本项目——**Optimus Code**。

它是作为一个 **VS Code 扩展 (Extension)**，在它的底层，它将各个现有的 AI 原生能力（如 GitHub Copilot 的 CLI 版 `gh copilot`、本地的 Llama 或者配置了环境的 API 代理等）打爆成可以通过 Node.js 标准子进程 (`child_process`) 执行的无情“Workers（工具人）”。

## 🏗️ 架构设计 (Architecture)

整体设计采用“三层模型”：

### 1. 顶层：VS Code 扩展原生界面 (UI & Context Layer)
作为极客的调度中心，直接依附在你现在写代码的编辑器上。
*   负责**提取当前上下文**：你选中的代码、光标位置、打开的文件。这也就是给后续智能体系统安上一双敏锐的眼睛。
*   负责**优美地应用成果**：利用 VS Code 的 `WorkspaceEdit` 把多方辩论得出、最后由你“拍板”的最终代码结果以 Diff (修改对比图) 呈现。

### 2. 中层：多脑总控与裁判员 (Orchestration Engine - The "Optimus")
核心逻辑！它是一个简单的内部工作流与状态机：
1.  **分发任务**：当你发起 `Optimus.SummonCouncil` ("召唤议会") 命令时，主控读取你的代码并发往各个底层子节点（如：发给节点 A 让它写初版，发给节点 B 问它有没有安全漏洞）。
2.  **强制对线**：它可以把 A 的结果通过管道发给 B，“这是另一个 AI 的代码，请指出并修改其中的致命缺陷。”
3.  **结果合成**：将吵完的结果剔掉所有的 Markdown “废话”，只精炼出 `<python> ... </python>` 的核心变动块。

### 3. 底层：白嫖与套壳调用包 (CLI Adapter Layer)
通过 Node.js 原生的 `child_process.exec()` 等系统级命令唤起大厂产品。
*   **Copilot Adapter**: 强制后台唤起 `gh copilot suggest -t generic "审核: <code>"`，劫持其终端的 stdout（并去除颜色符如 `env={"TERM":"dumb"}`）。
*   **Claude Code Adapter**: (若有必要) 调用终端内被注册过的 claude CLI 或封装的 Python API Proxy。

## 🧗 开发路径图 (Roadmap)

### 第一步：初始化脚手架 (MVP)
*   [ ] 跑 `npx yo code` 生成 Typescript 扩展。
*   [ ] 在 `extension.ts` 中注册 `OptimusCode.Debate` 命令。
*   [ ] 写一个简单的 `child_process` 封装，确保能在后台干净地成功运行并截获 `gh --version` 和 `gh copilot suggest`。

### 第二步：打通数据流
*   [ ] 当用户选中一段代码并按下快捷键时，读取 `vscode.window.activeTextEditor` 获取字符。
*   [ ] 将带有提示词（如“请简要重构”）的拼接字串通过 Adapter 传递给 CLI。

### 第三步：合成本地呈现
*   [ ] 不要破坏用户源文件。
*   [ ] 使用 `vscode.commands.executeCommand('vscode.diff', ...)` 把辩论生成的临时新代码与源文件进行双栏并排对比展示。

---
*“在架构师（你）、代码工蜂（Copilot）和审查员（Claude）的三位一体中，你只需按下按钮，喝口咖啡。”*