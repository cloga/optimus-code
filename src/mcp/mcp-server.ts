import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { dispatchCouncilConcurrent, delegateTaskSingle, loadValidEnginesAndModels, isValidEngine, isValidModel, updateFrontmatter, loadT3UsageLog, saveT3UsageLog } from "./worker-spawner";
import { cleanStaleAgents } from "./agent-gc";
import { TaskManifestManager } from "../managers/TaskManifestManager";
import { parseGitRemote, createGitHubIssue } from "../utils/githubApi";
import { runAsyncWorker } from "./council-runner";
import { spawn, execSync } from "child_process";
import dotenv from "dotenv";
import { VcsProviderFactory } from "../adapters/vcs/VcsProviderFactory";
import { agentSignature } from "../utils/agentSignature";
import { validateRoleNotModelName, validateEngineAndModel, looksLikeModelName } from "../utils/validateMcpInput";

// Load environment variables: prefer DOTENV_PATH from mcp.json env mount, fallback to cwd
function reloadEnv() {
  if (process.env.DOTENV_PATH) {
    dotenv.config({ path: path.resolve(process.env.DOTENV_PATH), override: true });
  } else {
    dotenv.config({ override: true });
  }
}
reloadEnv();

// 1. Initialize the MCP Server (The Marionette Controller)
const server = new Server(
  {
    name: "optimus-facade",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 1.5 Register Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "optimus://system/instructions",
        name: "Optimus System Instructions",
        description: "Master workflow protocols and agnostic system instructions for Optimus agents.",
        mimeType: "text/markdown"
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "optimus://system/instructions") {
    // Resolve workspace path securely
    const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    const instructionsPath = path.resolve(workspacePath, '.optimus', 'config', 'system-instructions.md');
    
    // Security check: Ensure it doesn't escape workspace
    if (!instructionsPath.startsWith(path.resolve(workspacePath))) {
       throw new McpError(ErrorCode.InvalidRequest, `Path traversal detected`);
    }

    try {
      if (fs.existsSync(instructionsPath)) {
        const content = fs.readFileSync(instructionsPath, 'utf8');
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "text/markdown",
              text: content
            }
          ]
        };
      } else {
        // Fallback for transition
        throw new McpError(ErrorCode.InvalidRequest, `The system-instructions.md file does not exist at ${instructionsPath}`);
      }
    } catch (e: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to read instructions: ${e.message}`);
    }
  }
  throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${request.params.uri}`);
});

// 2. Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
        {
          name: "append_memory",
          description: "Write experience, architectural decisions, and important project facts into the continuous memory system to evolve the project context.",
          inputSchema: {
            type: "object",
            properties: {
              category: { type: "string", description: "The category of the memory (e.g. 'architecture-decision', 'bug-fix', 'workflow')" },
              tags: { type: "array", items: { type: "string" }, description: "A list of tags for selective loading" },
              content: { type: "string", description: "The actual memory content to solidify" }
            },
            required: ["category", "tags", "content"]
          }
        },
        {
          name: "github_update_issue",
          description: "Updates an existing issue in a GitHub repository (e.g. to close it or add comments).",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string", description: "Repository owner" },
              repo: { type: "string", description: "Repository name" },
              issue_number: { type: "number", description: "The number of the issue to update" },
              state: { type: "string", enum: ["open", "closed"], description: "State of the issue" },
              title: { type: "string", description: "New title for the issue" },
              body: { type: "string", description: "New body for the issue (overwrites existing)" },
              agent_role: { type: "string", description: "The role of the agent making this update" },
              session_id: { type: "string", description: "The session ID of the agent" }
            },
            required: ["owner", "repo", "issue_number"]
          }
        },
        {
          name: "github_sync_board",
        description: "Fetches open issues from a GitHub repository and dumps them into the local blackboard.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner (e.g. cloga)" },
            repo: { type: "string", description: "Repository name (e.g. optimus-code)" },
            workspace_path: { type: "string", description: "Absolute workspace path" }
          },
          required: ["owner", "repo", "workspace_path"]
        }
      },

      {
        name: "dispatch_council",
        description: "Trigger a map-reduce multi-expert review for an architectural proposal using the Spartan Swarm protocol.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file",
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])",
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            },
            role_descriptions: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Optional map of role name to its description. Example: { 'security': 'Security expert specializing in...' }. Used to create proper T2 role templates for council members."
            },
          },
          required: ["proposal_path", "roles"],
        },
      },
      {
        name: "roster_check",
        description: "Returns a unified directory of all available roles (T1 Local Personas and T2 Global Agents) to help the Master Agent understand current workforce capabilities before dispatching tools.",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: {
              type: "string",
              description: "The absolute path to the current project workspace to check for T1 local personas.",
            }
          },
          required: ["workspace_path"],
        }
      },
      {
        name: "delegate_task",
        description: "Delegate a specific execution task to a designated expert role.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev').",
            },
            role_description: {
              type: "string",
              description: "A short description of what this role does and its expertise (e.g., 'Security auditing expert who reviews code for vulnerabilities and enforces compliance'). Used to generate the T2 role template if the role is new.",
            },
            role_engine: {
              type: "string",
              description: "Which execution engine this role should use (e.g., 'claude-code', 'copilot-cli'). Check roster_check for available engines. If omitted, auto-resolved from available-agents.json.",
            },
            role_model: {
              type: "string",
              description: "Which model this role should use (e.g., 'claude-opus-4.6-1m', 'gpt-5.4'). If omitted, uses the first available model for the engine.",
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do.",
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report. If not already under the workspace's .optimus/ directory, it will be automatically scoped to .optimus/results/<filename> within the workspace.",
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root.",
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task.",
            },
            required_skills: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of skill names this role needs (e.g., ['council-review', 'git-workflow']). If any skill does not exist in .optimus/skills/<name>/SKILL.md, the task will be rejected with a list of missing skills so Master can create them first via a skill-creator delegation.",
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            },
          },
          required: ["role", "task_description", "output_path", "workspace_path"],
        }
      },
      {
        name: "delegate_task_async",
        description: "Delegate a specific execution task to a designated expert role asynchronously without blocking the master agent.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev').",
            },
            role_description: {
              type: "string",
              description: "A short description of what this role does and its expertise. Used to generate the T2 role template if the role is new.",
            },
            role_engine: {
              type: "string",
              description: "Which execution engine this role should use (e.g., 'claude-code', 'copilot-cli'). If omitted, auto-resolved.",
            },
            role_model: {
              type: "string",
              description: "Which model this role should use (e.g., 'claude-opus-4.6-1m'). If omitted, uses default.",
            },
            task_description: {
              type: "string",
              description: "Detailed description of what the agent needs to do.",
            },
            output_path: {
              type: "string",
              description: "The file path where the agent should write its final result or report.",
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root.",
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files.",
            },
            required_skills: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of skill names this role needs. Missing skills will cause rejection so Master can create them first.",
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            },
          },
          required: ["role", "task_description", "output_path", "workspace_path"],
        }
      },
      {
        name: "dispatch_council_async",
        description: "Trigger an async map-reduce multi-expert review for an architectural proposal.",
        inputSchema: {
          type: "object",
          properties: {
            proposal_path: {
              type: "string",
              description: "The file path to the PROPOSAL.md file",
            },
            roles: {
              type: "array",
              items: { type: "string" },
              description: "An array of expert roles to spawn concurrently (e.g., ['security-expert', 'performance-tyrant'])",
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root.",
            },
            parent_issue_number: {
              type: "number",
              description: "The GitHub issue number of the parent epic or task. Used for issue lineage tracking."
            },
            role_descriptions: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Optional map of role name to its description. Example: { 'security': 'Security expert specializing in...' }. Used to create proper T2 role templates for council members."
            },
          },
          required: ["proposal_path", "roles", "workspace_path"],
        }
      },
      {
        name: "check_task_status",
        description: "Poll the status of async queues or tasks.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The ID of the task to check.",
            },
            workspace_path: {
              type: "string",
              description: "Absolute path to the project workspace root.",
            },
          },
          required: ["taskId", "workspace_path"],
        }
      },
      {
        name: "write_blackboard_artifact",
        description: "Write a file to the .optimus/ blackboard directory. Only paths within .optimus/ are allowed. Use this to create proposals, requirements docs, and other orchestration artifacts. artifact_path is relative to the .optimus/ directory (do NOT include the .optimus/ prefix).",
        inputSchema: {
          type: "object",
          properties: {
            artifact_path: { type: "string", description: "Relative path within .optimus/ directory (e.g. 'proposals/PROPOSAL_xxx.md', 'tasks/requirements_xxx.md'). Do NOT include the '.optimus/' prefix." },
            content: { type: "string", description: "The content to write to the file.", maxLength: 1048576 },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["artifact_path", "content", "workspace_path"]
        }
      },
      {
        name: "vcs_create_work_item",
        description: "Create a work item (GitHub Issue or ADO Work Item) using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Work item title" },
            body: { type: "string", description: "Work item description/body (Markdown — auto-converted to HTML for ADO)" },
            labels: { type: "array", items: { type: "string" }, description: "Labels/tags to apply" },
            work_item_type: { type: "string", description: "ADO work item type (Bug, User Story, Task). Ignored for GitHub." },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            iteration_path: { type: "string", description: "ADO Sprint/iteration path (e.g. 'Project\\Sprint 1'). Ignored for GitHub." },
            area_path: { type: "string", description: "ADO team/area path (e.g. 'Project\\Team\\Area'). Ignored for GitHub." },
            assigned_to: { type: "string", description: "ADO assigned user (email or alias). Ignored for GitHub." },
            parent_id: { type: "number", description: "ADO parent work item ID for hierarchy linking. Ignored for GitHub." },
            priority: { type: "number", description: "ADO priority (1-4, where 1=Critical). Ignored for GitHub." },
            agent_role: { type: "string", description: "The role of the agent creating this work item. Used for attribution signature." }
          },
          required: ["title", "body", "workspace_path"]
        }
      },
      {
        name: "vcs_create_pr",
        description: "Create a pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "PR title" },
            body: { type: "string", description: "PR description" },
            head: { type: "string", description: "Source branch" },
            base: { type: "string", description: "Target branch" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            agent_role: { type: "string", description: "The role of the agent creating this PR. Used for attribution signature." }
          },
          required: ["title", "body", "head", "base", "workspace_path"]
        }
      },
      {
        name: "vcs_merge_pr",
        description: "Merge a pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            pull_request_id: { type: ["string", "number"], description: "PR ID or number" },
            commit_title: { type: "string", description: "Merge commit title" },
            merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Merge strategy" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["pull_request_id", "workspace_path"]
        }
      },
      {
        name: "vcs_add_comment",
        description: "Add a comment to a work item or pull request using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            item_type: { type: "string", enum: ["workitem", "pullrequest"], description: "Type of item" },
            item_id: { type: ["string", "number"], description: "Work item or PR ID/number" },
            comment: { type: "string", description: "Comment text" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            agent_role: { type: "string", description: "The role of the agent posting this comment. Used for attribution signature." }
          },
          required: ["item_type", "item_id", "comment", "workspace_path"]
        }
      },
      {
        name: "hello",
        description: "A simple greeting tool to verify the MCP server is running.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name to greet" }
          },
          required: ["name"]
        }
      },
      {
        name: "quarantine_role",
        description: "Manually quarantine or unquarantine a T2 role. Quarantined roles cannot be dispatched until unquarantined.",
        inputSchema: {
          type: "object",
          properties: {
            role: { type: "string", description: "The role name to quarantine/unquarantine" },
            action: { type: "string", enum: ["quarantine", "unquarantine"], description: "Whether to quarantine or unquarantine the role" },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["role", "action", "workspace_path"]
        }
      }
    ],
  };
});

// 3. Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {

  if (request.params.name === "check_task_status") {
    let { taskId, workspace_path } = request.params.arguments as any;
    if (!taskId || !workspace_path) throw new Error("Missing taskId or workspace_path");
    
    TaskManifestManager.reapStaleTasks(workspace_path); // Trigger reaper
    const manifest = TaskManifestManager.loadManifest(workspace_path);
    const task = manifest[taskId];
    if (!task) {
      return { content: [{ type: "text", text: `Task ${taskId} not found in manifest.` }] };
    }

    // Enhanced multi-tier status with artifact verification
    let effectiveStatus = task.status;
    let details = '';

    if (task.status === 'running') {
      const elapsed = Math.round((Date.now() - task.startTime) / 1000);
      details = `Task ${taskId} status: **running** (${elapsed}s elapsed)\n`;
    } else if (task.status === 'verified') {
      details = `Task ${taskId} status: **verified** ✅\n\nOutput verified at ${task.output_path || 'the review path'}.`;
      if (task.type === 'dispatch_council') {
        const verdictPath = path.join(task.output_path!, 'VERDICT.md');
        if (fs.existsSync(verdictPath)) {
          details += `\nPM Verdict available at: ${verdictPath}`;
        }
      }
    } else if (task.status === 'completed') {
      // Legacy: re-verify output_path on read
      let outputExists = false;
      if (task.output_path) {
        try {
          const stat = fs.statSync(task.output_path);
          outputExists = stat.isFile() ? stat.size > 0 : fs.readdirSync(task.output_path).length > 0;
        } catch {}
      }
      effectiveStatus = outputExists ? 'verified' : 'partial';
      if (effectiveStatus === 'verified') {
        details = `Task ${taskId} status: **verified** ✅\n\nOutput is ready at ${task.output_path}.`;
      } else {
        details = `Task ${taskId} status: **partial** ⚠️\n\nProcess exited successfully but output_path is missing or empty: \`${task.output_path}\``;
      }
    } else if (task.status === 'partial') {
      details = `Task ${taskId} status: **partial** ⚠️\n\nProcess exited successfully but output artifact was not found at: \`${task.output_path}\``;
    } else if (task.status === 'failed') {
      details = `Task ${taskId} status: **failed** ❌\n\nError: ${task.error_message}`;
    } else {
      details = `Task ${taskId} status: **${task.status}**`;
    }
    
    return { content: [{ type: "text", text: details }] };
  }
  
  if (request.params.name === "delegate_task_async") {
    let { role, role_description, role_engine, role_model, task_description, output_path, workspace_path, context_files, required_skills } = request.params.arguments as any;
    if (!role || !task_description || !output_path || !workspace_path) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments");
    }

    // Input validation gateway — hard rejection with actionable messages
    validateRoleNotModelName(role);
    validateEngineAndModel(role_engine, role_model, workspace_path);

    // Resolve parent issue: explicit param > env var > undefined (with NaN guard)
    const rawParentAsync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentAsync) ? undefined : rawParentAsync);

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
    TaskManifestManager.createTask(workspace_path, {
        taskId, type: "delegate_task", role, task_description, output_path, workspacePath: workspace_path, context_files: context_files || [],
        role_description, role_engine, role_model, required_skills,
        delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10),
        parent_issue_number: parentIssueNumber,
        role_descriptions: role_descriptions || undefined
    });

    // Best-effort: auto-create GitHub Issue for traceability
    let issueInfo = '';
    const remote = parseGitRemote(workspace_path);
    if (remote) {
        const truncDesc = task_description.length > 300 ? task_description.substring(0, 300) + '...' : task_description;
        const shortTitle = task_description.split('\n')[0].substring(0, 80).trim();
        const parentRef = parentIssueNumber ? `**Parent Epic:** #${parentIssueNumber}\n\n` : '';
        const issue = await createGitHubIssue(remote.owner, remote.repo,
            `[Task] ${role}: ${shortTitle}...`,
            `${parentRef}## Auto-generated Swarm Task Tracker\n\n**Task ID:** \`${taskId}\`\n**Role:** \`${role}\`\n**Output Path:** \`${output_path}\`\n\n### Task Description\n${truncDesc}` + agentSignature(role, taskId),
            ['swarm-task', 'optimus-bot']
        );
        if (issue) {
            TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
            issueInfo = `\n**GitHub Issue**: ${issue.html_url}`;
        }
    }
    
    // Spawn background process
    const child = spawn(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
        detached: true, stdio: "ignore", windowsHide: true
    });
    child.unref();
    
    return { content: [{ type: "text", text: `✅ Task spawned successfully in background.\n\n**Task ID**: ${taskId}\n**Role**: ${role}${issueInfo}\n\nUse check_task_status tool periodically with this task ID to check its completion.` }] };
  }
  
  if (request.params.name === "dispatch_council_async") {
    let { proposal_path, roles, workspace_path, role_descriptions } = request.params.arguments as any;
    if (!proposal_path || !Array.isArray(roles) || !workspace_path) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments");
    }

    // Input validation gateway — reject model names passed as council roles
    const modelAsRole = roles.find((r: string) => looksLikeModelName(r));
    if (modelAsRole) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Council role '${modelAsRole}' looks like a model name, not a role name. ` +
            `Use role names like 'security-expert' or 'performance-tyrant'. ` +
            `Council roles do not accept engine/model parameters — they use project defaults.`
        );
    }

    // Resolve parent issue: explicit param > env var > undefined (with NaN guard)
    const rawParentAsync2 = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentAsync2) ? undefined : rawParentAsync2);

    const taskId = `council_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
    const reviewsPath = path.join(workspace_path, ".optimus", "reviews", taskId);
    TaskManifestManager.createTask(workspace_path, {
        taskId, type: "dispatch_council", roles, proposal_path, output_path: reviewsPath, workspacePath: workspace_path,
        delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10),
        parent_issue_number: parentIssueNumber
    });

    // Best-effort: auto-create GitHub Issue for traceability
    let issueInfo = '';
    const remote = parseGitRemote(workspace_path);
    if (remote) {
        const proposalName = require('path').basename(proposal_path, '.md').replace(/^PROPOSAL_/i, '').replace(/[_-]/g, ' ');
        const parentRef = parentIssueNumber ? `**Parent Epic:** #${parentIssueNumber}\n\n` : '';
        const issue = await createGitHubIssue(remote.owner, remote.repo,
            `[Council] ${proposalName} (Review)`,
            `${parentRef}## Auto-generated Council Review Tracker\n\n**Council ID:** \`${taskId}\`\n**Roles:** ${roles.map((r: string) => `\`${r}\``).join(', ')}\n**Proposal:** \`${proposal_path}\`\n**Reviews Path:** \`${reviewsPath}\`` + agentSignature('council-orchestrator', taskId),
            ['swarm-council', 'optimus-bot']
        );
        if (issue) {
            TaskManifestManager.updateTask(workspace_path, taskId, { github_issue_number: issue.number });
            issueInfo = `\n**GitHub Issue**: ${issue.html_url}`;
        }
    }
    
    // Spawn background process
    const child = spawn(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
        detached: true, stdio: "ignore", windowsHide: true
    });
    child.unref();
    
    return { content: [{ type: "text", text: `✅ Council spawned successfully in background.\n\n**Council ID**: ${taskId}\n**Roles**: ${roles.join(", ")}${issueInfo}\n\nUse check_task_status tool periodically with this Council ID to check completion.` }] };
  }

  if (request.params.name === "dispatch_council") {

    let { proposal_path, roles, workspace_path, role_descriptions } = request.params.arguments as any;

    if (!proposal_path || !Array.isArray(roles) || roles.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires proposal_path and an array of roles");
    }

    // Input validation gateway — reject model names passed as council roles
    const modelAsRoleSync = roles.find((r: string) => looksLikeModelName(r));
    if (modelAsRoleSync) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Council role '${modelAsRoleSync}' looks like a model name, not a role name. ` +
            `Use role names like 'security-expert' or 'performance-tyrant'. ` +
            `Council roles do not accept engine/model parameters — they use project defaults.`
        );
    }

    // Resolve parent issue: explicit param > env var > undefined
    const rawParentSync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentSync) ? undefined : rawParentSync);
    
    // Resolve workspace root from the proposal_path instead of process.cwd().
    // Global MCP servers boot in the user home directory, so we must calculate the project root dynamically.
    // Assuming proposal_path is something like <ProjectRoot>/.optimus/PROPOSAL_xxx.md
    let workspacePath: string;
    const optimusIndex = proposal_path.indexOf('.optimus');
    if (optimusIndex !== -1) {
      workspacePath = proposal_path.substring(0, optimusIndex);
    } else {
      // Fallback: proposal file is not under .optimus/, treat its parent directory as the workspace root.
      // This preserves backward compatibility but callers should pass a path inside .optimus/.
      workspacePath = path.resolve(path.dirname(proposal_path));
    }

    const timestampId = Date.now();
    const reviewsPath = path.join(workspacePath, ".optimus", "reviews", timestampId.toString());
    
    fs.mkdirSync(reviewsPath, { recursive: true });

    // In Phase 2 implementation, this is where we invoke worker-spawner.js for Promise.all
    // Launching autonomous CLI instances concurrently
    console.error(`[MCP] Dispatching council with roles: ${roles.join(', ')}`);
    const results = await dispatchCouncilConcurrent(roles, proposal_path, reviewsPath, timestampId.toString(), workspacePath, undefined, parentIssueNumber, role_descriptions);

    return {
      content: [
        {
          type: "text",
          text: `⚖️ **Council Map-Reduce Review Completed**\nAll expert workers executed parallelly adhering to the Singleton Worker Rule.\n\nReviews are saved in isolated path: \`${reviewsPath}\`\n\nExecution Logs:\n${results.join('\n')}\n\nPlease read these review files to continue.`
        },
      ],
    };
        } else if (request.params.name === "append_memory") {
      let { category, tags, content } = request.params.arguments as any;
      const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
      const memoryDir = path.resolve(workspacePath, '.optimus', 'memory');
      const memoryFile = path.join(memoryDir, 'continuous-memory.md');

      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }

      // Memory Lock for concurrency within the MCP server process
      if (!(global as any).memoryLock) {
        (global as any).memoryLock = Promise.resolve();
      }

      try {
        await (global as any).memoryLock; // Wait for any pending write

        // Create new write promise
        const writePromise = new Promise<void>((resolve, reject) => {
          try {
            const timestamp = new Date().toISOString();
            const memoryId = 'mem_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            
            const freshEntry = [
              '---',
              'id: ' + memoryId,
              'category: ' + (category || 'uncategorized'),
              'tags: [' + (tags ? tags.join(', ') : '') + ']',
              'created: ' + timestamp,
              '---',
              content,
              '\n'
            ].join('\n');

            fs.appendFileSync(memoryFile, freshEntry, 'utf8');
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        
        (global as any).memoryLock = writePromise;
        await writePromise;
        
        return {
          content: [
            {
              type: "text",
              text: `✅ Experience solidifed to memory!\nTags: ${tags.join(', ')}\nMemory appended to: ${memoryFile}`
            }
          ]
        };
      } catch (err: any) {
        return {
           content: [{ type: "text", text: `Failed to append memory: ${err.message}` }],
           isError: true
        };
      }
  } else if (request.params.name === "roster_check") {

    const { workspace_path } = request.params.arguments as any;
    if (!workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires workspace_path");
    }

    const t1Dir = path.join(workspace_path, ".optimus", "agents");
    
    // Check and create T2 project-level profile directory natively
    const t2Dir = path.join(workspace_path, '.optimus', 'roles');
    if (!fs.existsSync(t2Dir)) {
        fs.mkdirSync(t2Dir, { recursive: true });
    }
    // T2 roles are created ONLY via T3 precipitation or manual user creation.
    // No lazy-sync from plugin built-in roles.

    let roster = "📋 **Spartan Swarm Active Roster**\n\n";

    roster += "### T1: Local Project Experts\n";
    if (fs.existsSync(t1Dir)) {
      const t1Files = fs.readdirSync(t1Dir).filter(f => f.endsWith('.md'));
      roster += t1Files.length > 0 ? t1Files.map(f => `- ${f.replace('.md', '')}`).join('\n') : "(No local overrides found)\n";
    } else {
      roster += "(No local personas directory found)\n";
    }

    // --- Dynamic T3 Config Loading ---
    const configPath = path.join(workspace_path, ".optimus", "config", "available-agents.json");
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        roster += "\n### ⚙️ Engine & Model Spec (T3 configuration)\n";
        roster += "**Available Execution Engines (Toolchains & Supported Models)**:\n";
        Object.keys(config.engines).forEach(engine => {
          const statusMatch = config.engines[engine].status ? ` *[Status: ${config.engines[engine].status}]*` : '';
          roster += `- [Engine: ${engine}] Models: [${config.engines[engine].available_models.join(', ')}]${statusMatch}\n`;
        });
          roster += "*Note: Append these engine and model combinations to role names to spawn customized variants. Examples: `chief-architect_claude-code_claude-3-opus`, `security-auditor_copilot-cli_o1-preview`.*\n\n";
        } catch (e) {}
    }

    roster += "\n## 👥 Roles — WHO does the work\n";
    const t2RoleNames: string[] = [];
    if (fs.existsSync(t2Dir)) {
      const t2Files = fs.readdirSync(t2Dir).filter(f => f.endsWith('.md'));
      if (t2Files.length > 0) {
        for (const f of t2Files) {
          const roleName = f.replace('.md', '');
          t2RoleNames.push(roleName);
          try {
            const content = fs.readFileSync(path.join(t2Dir, f), 'utf8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let engineInfo = '';
            let quarantineMarker = '';
            if (fmMatch) {
              const lines = fmMatch[1].split('\n');
              const engineLine = lines.find(l => l.startsWith('engine:'));
              const modelLine = lines.find(l => l.startsWith('model:'));
              const statusLine = lines.find(l => l.startsWith('status:'));
              if (engineLine || modelLine) {
                const engine = engineLine ? engineLine.split(':')[1].trim() : '?';
                const model = modelLine ? modelLine.split(':')[1].trim() : '?';
                engineInfo = ` → \`${engine}\` / \`${model}\``;
              }
              if (statusLine && statusLine.split(':')[1].trim() === 'quarantined') {
                quarantineMarker = ' **[QUARANTINED]**';
              }
            }
            roster += `- ${roleName}${engineInfo}${quarantineMarker}\n`;
          } catch {
            roster += `- ${roleName}\n`;
          }
        }
      } else {
        roster += "(No project default roles found)\n";
      }
    } else {
      roster += "(No project roles directory found)\n";
    }

    // Show T3 usage stats if available
    const t3LogPath = path.join(workspace_path, '.optimus', 'state', 't3-usage-log.json');
    if (fs.existsSync(t3LogPath)) {
      try {
        const t3Log = JSON.parse(fs.readFileSync(t3LogPath, 'utf8'));
        const entries = Object.values(t3Log) as any[];
        if (entries.length > 0) {
          roster += "\n### 📊 T3 Dynamic Role Usage Stats\n";
          for (const e of entries) {
            const rate = e.invocations > 0 ? Math.round((e.successes / e.invocations) * 100) : 0;
            roster += `- \`${e.role}\`: ${e.invocations} invocations (${rate}% success)\n`;
          }
        }
      } catch {}
    }

    roster += "\n### ⚙️ Fallback Behavior\n";
    roster += "- If no roles/agents exist, the system defaults to **PM (Master Agent)** behavior.\n";
    roster += "- If a role has no `engine`/`model` in frontmatter, the system auto-resolves from `available-agents.json`, or falls back to `claude-code`.\n";
    roster += "- T3 roles auto-precipitate to T2 immediately on first use.\n";

    // Show available skills
    const skillsDir = path.join(workspace_path, '.optimus', 'skills');
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir).filter(d => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, 'SKILL.md')); } catch { return false; }
      });
      if (skillDirs.length > 0) {
        roster += "\n## 📚 Skills — HOW to do the work\n";
        roster += "Use `required_skills` in `delegate_task` to equip agents with these skills:\n";
        for (const skill of skillDirs) {
          try {
            const content = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let desc = '';
            let isAutoGenerated = false;
            if (fmMatch) {
              const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
              if (descLine) desc = ' — ' + descLine.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
              const autoGenLine = fmMatch[1].split('\n').find(l => l.startsWith('auto_generated:'));
              if (autoGenLine && autoGenLine.split(':')[1].trim() === 'true') isAutoGenerated = true;
            }
            const isMeta = skill === 'role-creator' || skill === 'agent-creator' || skill === 'skill-creator';
            const nameCollision = t2RoleNames.includes(skill) ? ' ⚠️ name matches a role' : '';
            const autoTag = isAutoGenerated ? ' (auto-generated)' : '';
            roster += `- ${isMeta ? '🧬 ' : ''}\`${skill}\`${desc}${autoTag}${nameCollision}\n`;
          } catch {
            roster += `- \`${skill}\`\n`;
          }
        }
      }
    }

    roster += "\n> ℹ️ Roles and Skills are independent (many-to-many). Equip skills via `required_skills` parameter in `delegate_task`.\n";

    return {
      content: [{ type: "text", text: roster }]
    };
  } else if (request.params.name === "delegate_task") {
    let { role, role_description, role_engine, role_model, task_description, output_path, context_files, required_skills } = request.params.arguments as any;
    let workspace_path = (request.params.arguments as any).workspace_path;

    // Resolve parent issue: explicit param > env var > undefined
    const rawParentSync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentSync) ? undefined : rawParentSync);

    if (!role || !task_description || !output_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires role, task_description, output_path");
    }

    if (!workspace_path) {
       // fallback to project root based on output_path or cwd
       workspace_path = process.cwd();
       if (output_path.includes("optimus-code")) {
         workspace_path = output_path.split("optimus-code")[0] + "optimus-code";
       }
    }

    // Input validation gateway — hard rejection with actionable messages
    validateRoleNotModelName(role);
    validateEngineAndModel(role_engine, role_model, workspace_path);

    const sessionId = crypto.randomUUID();
    const workspacePath = workspace_path;

    // Canonicalize output_path: if it does not already live under this workspace's .optimus/,
    // scope it to .optimus/results/<basename> so no files escape to the workspace root.
    const optimusDir = path.join(workspacePath, ".optimus");
    const resolvedOutputPath = path.resolve(workspacePath, output_path);
    const canonicalOutputPath = resolvedOutputPath.startsWith(optimusDir)
      ? resolvedOutputPath
      : path.join(optimusDir, "results", path.basename(output_path));

    // 1. Write the task description into a Blackboard Artifact so the stateless worker can read it
    const tasksDir = path.join(workspacePath, ".optimus", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskArtifactPath = path.join(tasksDir, `task_${sessionId}.md`);
    fs.writeFileSync(taskArtifactPath, task_description, 'utf8');

    // Ensure the output directory exists (handles .optimus/results/ when auto-scoped)
    fs.mkdirSync(path.dirname(canonicalOutputPath), { recursive: true });

    console.error(`[MCP] Delegating task to role: ${role}, output scoped to: ${canonicalOutputPath}`);
    
    // 2. Delegate to the single worker pool (use canonicalOutputPath so agent writes inside .optimus/)
      const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files, { description: role_description, engine: role_engine, model: role_model, requiredSkills: required_skills }, undefined, parentIssueNumber);
    return {
      content: [{ type: "text", text: result }]
    };
  } else if (request.params.name === "vcs_create_work_item") {
    const { title, body, labels, work_item_type, workspace_path,
            iteration_path, area_path, assigned_to, parent_id, priority, agent_role } = request.params.arguments as any;
    if (!title || !body || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires title, body, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      const result = await vcsProvider.createWorkItem(title, finalBody, labels, work_item_type, {
        iteration_path,
        area_path,
        assigned_to,
        parent_id,
        priority
      });

      return {
        content: [{
          type: "text",
          text: `✅ Work item created successfully on ${vcsProvider.getProviderName()}\n\n**Title:** ${result.title}\n**ID:** ${result.id}${result.number ? `\n**Number:** ${result.number}` : ''}\n**URL:** ${result.url}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to create work item: ${error.message}`);
    }
  } else if (request.params.name === "vcs_create_pr") {
    const { title, body, head, base, workspace_path, agent_role } = request.params.arguments as any;
    if (!title || !body || !head || !base || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires title, body, head, base, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      const result = await vcsProvider.createPullRequest(title, finalBody, head, base);

      return {
        content: [{
          type: "text",
          text: `✅ Pull request created successfully on ${vcsProvider.getProviderName()}\n\n**Title:** ${result.title}\n**Number:** ${result.number}\n**ID:** ${result.id}\n**URL:** ${result.url}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to create pull request: ${error.message}`);
    }
  } else if (request.params.name === "vcs_merge_pr") {
    const { pull_request_id, commit_title, merge_method, workspace_path } = request.params.arguments as any;
    if (!pull_request_id || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires pull_request_id and workspace_path");
    }

    const PROTECTED_BRANCHES = ['master', 'main', 'develop', 'release'];

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);

      // Pre-merge build verification (configurable physical gate)
      const vcsConfigPath = path.join(workspace_path, '.optimus', 'config', 'vcs.json');
      if (fs.existsSync(vcsConfigPath)) {
        try {
          const vcsConfig = JSON.parse(fs.readFileSync(vcsConfigPath, 'utf8'));
          const buildGate = vcsConfig.pre_merge_build;
          if (buildGate?.enabled) {
            const buildCmd = buildGate.command || 'npm run build';
            const buildCwd = buildGate.cwd
              ? path.resolve(workspace_path, buildGate.cwd)
              : workspace_path;

            // Security: validate cwd stays within workspace
            const normalizedCwd = path.normalize(buildCwd);
            const normalizedWorkspace = path.normalize(workspace_path);
            if (!normalizedCwd.startsWith(normalizedWorkspace + path.sep) && normalizedCwd !== normalizedWorkspace) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Pre-Merge Build Gate: configured cwd '${buildGate.cwd}' resolves outside workspace boundary. Aborting.`
              );
            }

            console.error(`[Pre-Merge Gate] Running build verification: ${buildCmd} in ${buildCwd}`);
            execSync(buildCmd, {
              cwd: buildCwd,
              encoding: 'utf8',
              timeout: 120000 // 2 minute timeout
            });
            console.error('[Pre-Merge Gate] Build passed');
          }
        } catch (buildErr: any) {
          if (buildErr instanceof McpError) throw buildErr; // Re-throw our own errors
          throw new McpError(
            ErrorCode.InternalError,
            `Pre-Merge Build Failed: Cannot merge PR #${pull_request_id} \u2014 build verification failed.\n\n` +
            `Build output:\n${buildErr.stderr || buildErr.stdout || buildErr.message}\n\n` +
            'Fix the build errors and try again.'
          );
        }
      }

      const result = await vcsProvider.mergePullRequest(pull_request_id, commit_title, merge_method);

      if (!result.merged) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to merge pull request #${pull_request_id} on ${vcsProvider.getProviderName()}`
          }]
        };
      }

      // Local branch cleanup (best-effort)
      let branchCleanupMsg = '';
      if (result.headBranch && !PROTECTED_BRANCHES.includes(result.headBranch)) {
        try {
          // Check if we're currently on the head branch
          const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspace_path, encoding: 'utf8' }).trim();
          if (currentBranch === result.headBranch) {
            const checkoutTarget = result.baseBranch || 'master';
            execSync(`git checkout ${checkoutTarget}`, { cwd: workspace_path, encoding: 'utf8' });
          }
          execSync(`git branch -d ${result.headBranch}`, { cwd: workspace_path, encoding: 'utf8' });
          branchCleanupMsg = ` Branch '${result.headBranch}' cleaned up.`;
          console.error(`[Branch Cleanup] Deleted branch '${result.headBranch}' after merging PR #${pull_request_id}`);
        } catch (cleanupErr: any) {
          branchCleanupMsg = ` ⚠️ Branch cleanup warning: ${cleanupErr.message}`;
          console.error(`[Branch Cleanup] Warning: ${cleanupErr.message}`);
        }
      }

      // Post-merge: sync local master with remote
      let syncMsg = '';
      try {
        const syncBranch = result.baseBranch || 'master';
        const currentBranchAfterCleanup = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspace_path, encoding: 'utf8' }).trim();
        if (currentBranchAfterCleanup !== syncBranch) {
          execSync(`git checkout ${syncBranch}`, { cwd: workspace_path, encoding: 'utf8' });
        }
        execSync(`git pull --rebase origin ${syncBranch}`, { cwd: workspace_path, encoding: 'utf8' });
        syncMsg = ` Local '${syncBranch}' synced.`;
      } catch (syncErr: any) {
        console.error(`[Post-Merge Sync] Warning: ${syncErr.message}`);
      }

      return {
        content: [{
          type: "text",
          text: `✅ Pull request #${pull_request_id} merged successfully on ${vcsProvider.getProviderName()}.${branchCleanupMsg}${syncMsg}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to merge pull request: ${error.message}`);
    }
  } else if (request.params.name === "vcs_add_comment") {
    const { item_type, item_id, comment, workspace_path, agent_role } = request.params.arguments as any;
    if (!item_type || !item_id || !comment || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires item_type, item_id, comment, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalComment = agent_role ? comment + agentSignature(agent_role) : comment;
      const result = await vcsProvider.addComment(item_type, item_id, finalComment);

      return {
        content: [{
          type: "text",
          text: `✅ Comment added successfully to ${item_type} #${item_id} on ${vcsProvider.getProviderName()}\n\n**Comment ID:** ${result.id}\n**URL:** ${result.url}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to add comment: ${error.message}`);
    }
  } else if (request.params.name === "write_blackboard_artifact") {
    const { artifact_path, content, workspace_path } = request.params.arguments as any;
    if (!artifact_path || content === undefined || content === null || !workspace_path) {
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameters: artifact_path, content, workspace_path");
    }

    // Resolve target path: workspace/.optimus/<artifact_path>
    const optimusRoot = path.resolve(workspace_path, '.optimus');
    const resolvedTarget = path.resolve(optimusRoot, artifact_path);

    // SECURITY: Validate path is strictly within .optimus/ directory
    // Must use trailing separator to prevent sibling directory bypass (.optimus-evil/)
    if (!resolvedTarget.startsWith(optimusRoot + path.sep) && resolvedTarget !== optimusRoot) {
        throw new McpError(ErrorCode.InvalidParams, "artifact_path must resolve to within .optimus/ directory. Path traversal detected.");
    }

    // SECURITY: Resolve symlinks on the existing portion of the path
    // path.resolve() is purely lexical and does NOT follow symlinks
    let existingPath = resolvedTarget;
    let suffix = '';
    while (!fs.existsSync(existingPath)) {
        suffix = path.join(path.basename(existingPath), suffix);
        existingPath = path.dirname(existingPath);
    }
    const realExisting = fs.realpathSync(existingPath);
    const realTarget = path.join(realExisting, suffix);
    const realOptimus = fs.existsSync(optimusRoot) ? fs.realpathSync(optimusRoot) : optimusRoot;
    if (!realTarget.startsWith(realOptimus + path.sep) && realTarget !== realOptimus) {
        throw new McpError(ErrorCode.InvalidParams, "artifact_path resolves outside .optimus/ via symlink. Path traversal detected.");
    }

    try {
        // Auto-create intermediate directories
        fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
        // Write content as UTF-8
        fs.writeFileSync(resolvedTarget, content, 'utf8');
        return { content: [{ type: "text", text: `Artifact written to: ${resolvedTarget}` }] };
    } catch (error: any) {
        throw new McpError(ErrorCode.InternalError, `Failed to write artifact: ${error.message}`);
    }
  } else if (request.params.name === "hello") {
    const { name } = request.params.arguments as any;
    if (!name) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required parameter: name");
    }
    return { content: [{ type: "text", text: `Hello, ${name}! Optimus Swarm is running.` }] };
  } else if (request.params.name === "quarantine_role") {
    const { role, action, workspace_path } = request.params.arguments as any;
    if (!role || !action || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Missing required parameters: role, action, workspace_path");
    }

    const t2Dir = path.join(workspace_path, '.optimus', 'roles');
    const rolePath = path.join(t2Dir, `${role}.md`);
    if (!fs.existsSync(rolePath)) {
      return { content: [{ type: "text", text: `Role '${role}' not found at ${rolePath}` }] };
    }

    const content = fs.readFileSync(rolePath, 'utf8');

    if (action === 'quarantine') {
      const updated = updateFrontmatter(content, {
        status: 'quarantined',
        quarantined_at: new Date().toISOString()
      });
      fs.writeFileSync(rolePath, updated, 'utf8');

      // Reset consecutive failures in T3 usage log
      const log = loadT3UsageLog(workspace_path);
      if (log[role]) {
        log[role].consecutive_failures = 0;
        saveT3UsageLog(workspace_path, log);
      }

      return { content: [{ type: "text", text: `Role '${role}' has been quarantined. It will be blocked from dispatch until unquarantined.` }] };
    } else if (action === 'unquarantine') {
      const updated = updateFrontmatter(content, {
        status: 'idle',
        quarantined_at: ''
      });
      fs.writeFileSync(rolePath, updated, 'utf8');

      // Reset consecutive failures
      const log = loadT3UsageLog(workspace_path);
      if (log[role]) {
        log[role].consecutive_failures = 0;
        saveT3UsageLog(workspace_path, log);
      }

      return { content: [{ type: "text", text: `Role '${role}' has been unquarantined and is available for dispatch again.` }] };
    } else {
      throw new McpError(ErrorCode.InvalidParams, `Invalid action '${action}'. Must be 'quarantine' or 'unquarantine'.`);
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
});

// 4. CLI entry point: either run as MCP server or as async task runner
if (process.argv.includes("--run-task")) {
  const idx = process.argv.indexOf("--run-task");
  const taskId = process.argv[idx + 1];
  const workspacePath = process.argv[idx + 2];
  if (!taskId || !workspacePath) {
    console.error("[Runner] Usage: --run-task <taskId> <workspacePath>");
    process.exit(1);
  }
  runAsyncWorker(taskId, workspacePath).catch((err) => {
    console.error("[Runner] Fatal:", err);
    process.exit(1);
  });
} else {
  // Standard MCP stdio transport
  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Optimus Spartan Swarm MCP server running on stdio");

    // Agent GC: clean up stale T1 instances on startup
    const workspaceRoot = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
    try {
      cleanStaleAgents(workspaceRoot);
    } catch (e: any) {
      console.error(`[Agent GC] Warning: ${e.message}`);
    }

    // Thin T2 template scanner: warn about templates that will be regenerated
    try {
      const rolesDir = path.join(workspaceRoot, '.optimus', 'roles');
      if (fs.existsSync(rolesDir)) {
        const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.md'));
        for (const file of roleFiles) {
          const filePath = path.join(rolesDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          // Strip YAML frontmatter to count body lines only
          const bodyMatch = content.replace(/\r\n/g, '\n').match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1] : content;
          const contentLineCount = body.split('\n').filter((l: string) => l.trim().length > 0).length;
          if (contentLineCount < 25) {
            console.error(`[Warning] Thin T2 template: ${file} (${contentLineCount} lines). Will regenerate on next use.`);
          }
        }
      }
    } catch (e: any) {
      console.error(`[Thin Scanner] Warning: ${e.message}`);
    }
  }

  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}