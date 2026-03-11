---
name: skill-creator
description: Generates high-quality, standardized SKILL.md files aligned with official specifications, ensuring strict MCP tool validation and robust XML-structured prompts.
---

# Skill Creator (Meta-Skill)

<description>
This skill activates when the Master Agent needs to create a new skill for a role that is missing required capabilities, or to upgrade an existing skill to the standardized XML format. It ensures all skills follow consistent structure and include proper tool validation.
</description>

<workflow>
### Step 0: Discover and Validate Tools (MANDATORY)
- **Tool**: Use available introspection capabilities to list MCP tools
- **Parameters**: None (environment-dependent)
- **Action**: BEFORE drafting any workflow, you MUST verify the exact MCP tool names and parameters available in the environment. Use whatever introspection method is available (e.g., `roster_check`, help commands, or documentation access) to guarantee 100% accuracy. Never hallucinate tool names or arguments - check the currently available tools to ensure they exist before writing instructions that reference them.

### Step 1: Analyze Requirements
- **Tool**: None (analysis step)
- **Parameters**: N/A
- **Action**: Determine the skill's purpose, target users, and required MCP tools. Identify what specific capabilities this skill needs to teach and what anti-patterns to prevent.

### Step 2: Draft the Skill using XML Standards
- **Tool**: File writing capability
- **Parameters**:
  - `file_path`: `.optimus/skills/<skill-name>/SKILL.md`
  - `content`: The complete skill content following the XML template
- **Action**: Generate the skill using the exact XML and Markdown hybrid structure shown in the template below. The resulting file should heavily feature structured tags to help target models parse context effectively.

<template>
---
name: "<skill-name>"
description: "<one-line actionable description of what this skill teaches>"
---

# <Skill Title>

<description>
<Brief description of when and why this skill activates, including trigger conditions and expected outcomes.>
</description>

<workflow>
### Step 1: <Action Name>
- **Tool**: `exact_mcp_tool_name`
- **Parameters**:
  - `param_1`: <explanation of expected value and format>
  - `param_2`: <explanation of expected value and format>
- **Action**: <Detailed description of what the agent should do, including decision logic>

### Step 2: <Action Name>
- **Tool**: `another_exact_tool_name` or "None (analysis step)"
- **Parameters**:
  - `param_1`: <explanation>
- **Action**: <Detailed instructions>

### Step N: <Final Action>
- **Tool**: `final_tool_name`
- **Parameters**:
  - `output_path`: <where results should be saved>
- **Action**: <Completion criteria and validation steps>
</workflow>

<error_handling>
- If `<exact_mcp_tool_name>` fails with `<Specific Error Pattern>`, THEN `<Specific recovery action>`.
- If `<condition>` occurs, THEN `<alternative approach>`.
- If all tools fail, THEN `<fallback manual procedure>`.
</error_handling>

<anti_patterns>
- <Specific things the agent MUST NOT do>
- <Common mistakes to avoid>
- <Prohibited shortcuts or assumptions>
</anti_patterns>
</template>

### Step 3: Quality & Security Validation
- **Tool**: File system validation
- **Parameters**:
  - `directory_path`: `.optimus/skills/<skill-name>/`
  - `file_path`: `.optimus/skills/<skill-name>/SKILL.md`
- **Action**: Verify the file path structure is correct and secure. Ensure the skill name only contains lowercase alphanumeric characters, dashes, and underscores (e.g. `data-analysis`). Create parent directories if needed before writing.

### Step 4: Content Verification
- **Tool**: Content review
- **Parameters**:
  - `skill_content`: The generated skill file
- **Action**: Verify the skill includes all required XML tags (description, workflow, error_handling, anti_patterns), proper tool references, and actionable instructions. Ensure examples are concrete and realistic.
</workflow>

<error_handling>
- If directory creation fails, THEN check permissions and retry with explicit directory creation commands.
- If skill name validation fails (invalid characters), THEN sanitize the name by removing/replacing invalid characters and notify the user.
- If MCP tool introspection fails, THEN document the limitation in the skill and provide fallback instructions for manual tool verification.
- If the template structure is incomplete, THEN add placeholder sections for missing XML tags and mark them for later completion.
</error_handling>

<anti_patterns>
- Do not create skills without first verifying the MCP tools they reference actually exist.
- Do not use generic or vague tool names like `github_tool` - always use exact MCP schema names.
- Do not skip the XML structure requirements - all skills must include description, workflow, error_handling, and anti_patterns tags.
- Do not write skills that reference non-existent file paths or assume specific directory structures without validation.
- Do not create overly complex workflows - break them into discrete, testable steps.
- Do not include time estimates or performance assumptions in skill instructions.
</anti_patterns>

## Reference Examples

Use the following exemplar to shape your output quality and understand the expected format:

<example>
---
name: "git-workflow"
description: "Issue-first GitHub workflow with proper PR creation and error handling."
---

# GitHub Workflow

<description>
Triggered when code needs to be committed, pushed, and reviewed via a Pull Request.
</description>

<workflow>
### Step 1: Create Tracking Issue
- **Tool**: `vcs_create_work_item`
- **Parameters**:
  - `title`: The issue title
  - `body`: Description of the bug or feature
- **Action**: Always create a tracking issue before modifying code to establish a blackboard for progress.

### Step 2: Branch and Commit
- **Tool**: None (standard CLI)
- **Parameters**: N/A
- **Action**: Checkout a new branch `feature/issue-<ID>`, make changes, and use Conventional Commits. Do not invoke tools for simple terminal git commands, use standard CLI access.
</workflow>

<error_handling>
- If `vcs_create_work_item` returns a validation error or 403 authorization error, verify credentials and stop execution. Do not proceed to commit.
- If branch already exists, append a unique hash to the new branch name and retry.
</error_handling>

<anti_patterns>
- Do not commit directly to `master` or `main`.
- Do not use generic tool names like `github_issue`; use the exact MCP schemas.
</anti_patterns>
</example>