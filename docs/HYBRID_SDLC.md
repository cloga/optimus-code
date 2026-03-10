# Hybrid SDLC (混合软件开发生命周期)

**Hybrid SDLC** 是 Optimus 项目中专为“多智能体 (Multi-Agent) 协同”设计的标准工作流。它的核心思想是将“AI 微观高速计算”与“人类宏观异步管理”结合在一起。

## 协同双轨制 (The Two-Track System)

1. **本地级的微观协作 (Local Blackboard)**
   - **机制**：通过在本地 `.optimus/` 目录下读写 Markdown 文件（如 Proposals, TODOs, Council Reviews）进行状态共享。
   - **目的**：实现 Agent 之间的高频交互、打草稿、并发审查（Council Review），避免污染主聊天窗口的上下文，保证 AI 执行过程的极速与隔离。

2. **云端级的宏观追踪 (GitHub Integration)**
   - **机制**：通过 MCP 工具（`github_create_issue`, `github_sync_board` 等）将关键节点的数据同步到 GitHub。
   - **目的**：将本地的 Agent 内部意图转化为人类可读的史诗级任务 (Epic)、子任务 (Task) 和代码变更 (Pull Request)。

## 核心五步工作流 (The 5-Phase Workflow)

1. **Analyze (PM 规划)**
   - PM Agent 接收需求，细化用户故事，并调用 GitHub API 创建对应的 Epic Issue 供人类追踪。
2. **Plan (Architect 设计)**
   - Architect 出具技术改造提案方案写入 `.optimus/proposals/`。
   - 如果遇到复杂变更，触发 **Council Review** 机制进行多专家会审，确保方案无致命缺陷。最后将摘要同步回 GitHub Issue。
3. **Execute (Dev 执行)**
   - 开发者角色拉取隔离的 Git 分支，严格按照评审后的提案进行编码或重构。
4. **Test (QA 测试)**
   - QA Agent 在本地运行测试，并将测试报告通过自动化流程反馈。如果有 Bug，则开具新的 Bug Issue；如果顺利，则协助准备 Pull Request。
5. **Approve (人类验收)**
   - PM Agent 汇总所有修改，引导用户（人类监督者）在 GitHub 平台对代码进行 Review 与 Merge，闭环关闭关联 Issue。