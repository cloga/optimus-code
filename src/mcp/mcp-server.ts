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
import { dispatchCouncilConcurrent, delegateTaskSingle, loadValidEnginesAndModels, loadEngineHeartbeatTimeout, isValidEngine, isValidModel, updateFrontmatter, loadT3UsageLog, saveT3UsageLog } from "./worker-spawner";
import { getMemoryFilePath, buildMemoryEntry, getUserMemoryPath, validateUserMemoryContent, appendToUserMemory } from "../managers/MemoryManager";
import { cleanStaleAgents } from "./agent-gc";
import { TaskManifestManager } from "../managers/TaskManifestManager";
import { parseGitRemote, createGitHubIssue } from "../utils/githubApi";
import { runAsyncWorker, spawnAsyncWorker } from "./council-runner";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { VcsProviderFactory } from "../adapters/vcs/VcsProviderFactory";
import { agentSignature } from "../utils/agentSignature";
import { validateRoleNotModelName, validateEngineAndModel, looksLikeModelName } from "../utils/validateMcpInput";
import { resolveRoleName, resolveRoleNames, getRegisteredRoles } from "../utils/resolveRoleName";
import { MetaCronEngine, loadCrontab, saveCrontab } from "./meta-cron-engine";
import { checkAndResumeAwaitingTasks } from "./input-resume-checker";

/** Validate required params and throw actionable McpError listing exactly which are missing. */
function requireParams(toolName: string, params: Record<string, any>, required: string[]): void {
  const missing = required.filter(k => params[k] == null || params[k] === '');
  if (missing.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for ${toolName}: missing required parameter(s): ${missing.join(', ')}. ` +
      `Received keys: [${Object.keys(params).join(', ')}]`
    );
  }
}

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
      throw new McpError(ErrorCode.InternalError, `Failed to read system instructions from '${instructionsPath}': ${e.message}. Ensure .optimus/config/system-instructions.md exists (run 'optimus init' or 'optimus upgrade').`);
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
              content: { type: "string", description: "The actual memory content to solidify" },
              level: { type: "string", description: "Memory scope: 'project' for shared context, 'role' for role-specific, 'user' for cross-project personal memory. Defaults to project.", enum: ["project", "role", "user"] }
            },
            required: ["category", "tags", "content"]
          }
        },
        {
          name: "vcs_update_work_item",
          description: "Update an existing work item (GitHub Issue / ADO Work Item) — change state, title, or labels.",
          inputSchema: {
            type: "object",
            properties: {
              item_id: { type: ["string", "number"], description: "Work item ID or issue number" },
              state: { type: "string", enum: ["open", "closed"], description: "New state for the work item" },
              title: { type: "string", description: "New title for the work item" },
              labels_add: { type: "array", items: { type: "string" }, description: "Labels to add" },
              labels_remove: { type: "array", items: { type: "string" }, description: "Labels to remove" },
              workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
              agent_role: { type: "string", description: "The role of the agent making this update. Used for attribution." }
            },
            required: ["item_id", "workspace_path"]
          }
        },
        {
          name: "vcs_list_work_items",
          description: "List work items (GitHub Issues / ADO Work Items) with optional filters.",
          inputSchema: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state (default: open)" },
              labels: { type: "array", items: { type: "string" }, description: "Filter by labels (items must have ALL listed labels)" },
              limit: { type: "number", description: "Maximum number of items to return (default: 100, max: 100)" },
              workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
            },
            required: ["workspace_path"]
          }
        },
        {
          name: "vcs_list_pull_requests",
          description: "List pull requests with optional state filter. Returns PR number, title, state, mergeable status, head/base branches, and labels.",
          inputSchema: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state (default: open)" },
              limit: { type: "number", description: "Maximum number of PRs to return (default: 30, max: 100)" },
              workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
            },
            required: ["workspace_path"]
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
            agent_id: {
              type: "string",
              description: "Optional T1 agent instance ID (e.g., 'product-manager_1e5b9723') to resume a specific agent's session. When provided, the system looks up the agent's stored session_id and resumes that conversation. Use this for multi-phase workflows where the same agent must retain context across delegations."
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
            agent_id: {
              type: "string",
              description: "Optional T1 agent instance ID (e.g., 'product-manager_1e5b9723') to resume a specific agent's session. When provided, the system looks up the agent's stored session_id and resumes that conversation."
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of task IDs that must complete (status: verified) before this task starts execution."
            },
            heartbeat_timeout_ms: {
              type: "number",
              description: "Optional heartbeat staleness timeout in ms. Overrides engine default. Range: 1-1800000 (30 min max)."
            },
          },
          required: ["role", "task_description", "output_path", "workspace_path"],
        }
      },
      {
        name: "dispatch_council_async",
        description: "Trigger an async map-reduce multi-expert review for a problem statement or architectural proposal. The proposal_path can point to a 00-PROBLEM.md or PROPOSAL file in .optimus/specs/.",
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
        description: "Write a file to the .optimus/ blackboard directory. Only paths within .optimus/ are allowed. Use this for specs (problem/proposal/solution), task descriptions, reports, and other orchestration artifacts. artifact_path is relative to the .optimus/ directory (do NOT include the .optimus/ prefix). Routing: specs/{date}-{topic}/ for Problem-First lifecycle, tasks/ for issue bindings, reports/ for analysis, results/ for task output.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_path: { type: "string", description: "Relative path within .optimus/ directory (e.g. 'specs/2026-03-14-my-topic/00-PROBLEM.md', 'tasks/task_issue_123.md', 'reports/analysis_report.md'). Do NOT include the '.optimus/' prefix. Do NOT write new files to 'proposals/' — use 'specs/' instead." },
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
      },
      {
        name: "register_meta_cron",
        description: "Register a new scheduled cron entry in the Meta-Cron engine. Self-registration by cron-triggered agents is forbidden.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique cron entry ID" },
            cron_expression: { type: "string", description: "Standard 5-field cron expression" },
            role: { type: "string", description: "The agent role to invoke" },
            required_skills: { type: "array", items: { type: "string" }, description: "Skills the agent needs" },
            capability_tier: { type: "string", enum: ["maintain", "develop", "review"], description: "Capability tier" },
            concurrency_policy: { type: "string", enum: ["Forbid", "Allow"], description: "Concurrent run policy (default: Forbid)" },
            max_actions: { type: "number", description: "Max actions per trigger (default: 5)" },
            dry_run_remaining: { type: "number", description: "Dry-run ticks before live (default: 3)" },
            startup_timeout_ms: { type: "number", description: "Optional startup timeout in ms for stuck-pending detection. Range: 1-600000 (10 min max)." },
            workspace_path: { type: "string", description: "Absolute path to workspace root." }
          },
          required: ["id", "cron_expression", "role", "required_skills", "capability_tier", "workspace_path"]
        }
      },
      {
        name: "list_meta_crons",
        description: "List all registered Meta-Cron entries with their status.",
        inputSchema: { type: "object", properties: { workspace_path: { type: "string", description: "Absolute path to workspace root." } }, required: ["workspace_path"] }
      },
      {
        name: "remove_meta_cron",
        description: "Remove a Meta-Cron entry by ID.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "The cron entry ID to remove" }, workspace_path: { type: "string", description: "Absolute path to workspace root." } }, required: ["id", "workspace_path"] }
      },
      {
        name: "request_human_input",
        description: "Request human input when an agent is blocked. Posts a question on the linked GitHub Issue and pauses the task until a human responds.",
        inputSchema: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question or decision needed from the human" },
            context_summary: { type: "string", description: "Summary of work done so far and why the agent is blocked" },
            options: { type: "array", items: { type: "string" }, description: "Optional: suggested answer options for the human" },
            task_id: { type: "string", description: "The task ID of the calling agent's task (from OPTIMUS_TASK_ID env var)" },
            workspace_path: { type: "string", description: "Absolute workspace path" }
          },
          required: ["question", "context_summary", "workspace_path"]
        }
      },
      {
        name: "list_knowledge",
        description: "Discover available project knowledge artifacts (specs, memory, reports, reviews) without reading their contents. Returns metadata only — paths, types, dates, and sizes — to help agents find relevant context before starting work.",
        inputSchema: {
          type: "object",
          properties: {
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." },
            category: { type: "string", enum: ["specs", "memory", "reports", "reviews", "all"], description: "Filter by knowledge category. Defaults to 'all'." },
            topic: { type: "string", description: "Optional keyword filter — only return artifacts whose path or name contains this string (case-insensitive)." }
          },
          required: ["workspace_path"]
        }
      }
    ],
  };
});

// 3. Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {

  if (request.params.name === "check_task_status") {
    let { taskId, workspace_path } = request.params.arguments as any;
    requireParams("check_task_status", request.params.arguments as any, ["taskId", "workspace_path"]);
    
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
        } catch (e: any) { console.error(`[TaskStatus] Warning: failed to stat output path: ${e.message}`); }
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
    } else if (task.status === 'blocked') {
      let depDetails = '';
      if (task.blocked_by && task.blocked_by.length > 0) {
          const depStatuses = task.blocked_by.map(depId => {
              const dep = manifest[depId];
              return dep ? `\`${depId}\` (${dep.status})` : `\`${depId}\` (unknown)`;
          });
          depDetails = `\n\n**Waiting for:** ${depStatuses.join(', ')}`;
      }
      details = `Task ${taskId} status: **blocked** ⏳\n\nTask is registered but waiting for dependencies to complete.${depDetails}`;
      if (task.depends_on) {
          details += `\n**Declared dependencies:** ${task.depends_on.map(d => `\`${d}\``).join(', ')}`;
      }
    } else if (task.status === 'awaiting_input') {
      const pauseAge = task.pause_timestamp ? Math.round((Date.now() - task.pause_timestamp) / 60000) : 0;
      details = `Task ${taskId} status: **awaiting_input** ⏸️\n\nAgent is waiting for human input (${pauseAge}m elapsed).\n\n**Question:** ${task.pause_question || '(none)'}\n**Pause count:** ${task.pause_count || 0}/3${task.github_issue_number ? `\n**GitHub Issue:** #${task.github_issue_number}` : ''}`;
    } else if (task.status === 'expired') {
      details = `Task ${taskId} status: **expired** ⏰\n\nHuman input request expired without a response. ${task.error_message || ''}`;
    } else {
      details = `Task ${taskId} status: **${task.status}**`;
    }
    
    return { content: [{ type: "text", text: details }] };
  }
  
  if (request.params.name === "delegate_task_async") {
    let { role, role_description, role_engine, role_model, task_description, output_path, workspace_path, context_files, required_skills, agent_id, depends_on, heartbeat_timeout_ms } = request.params.arguments as any;
    requireParams("delegate_task_async", request.params.arguments as any, ["role", "task_description", "output_path", "workspace_path"]);

    // Resolve role alias to canonical name before validation
    role = resolveRoleName(role, workspace_path);

    // Input validation gateway — hard rejection with actionable messages
    validateRoleNotModelName(role);
    validateEngineAndModel(role_engine, role_model, workspace_path);

    // Resolve parent issue: explicit param > env var > undefined (with NaN guard)
    const rawParentAsync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentAsync) ? undefined : rawParentAsync);

    // Canonicalize output_path: resolve relative paths and scope to .optimus/results/ when needed
    // (mirrors the sync delegate_task handler to prevent path escaping .optimus/)
    const optimusDir = path.join(workspace_path, ".optimus");
    const resolvedOutputPath = path.resolve(workspace_path, output_path);
    output_path = resolvedOutputPath.startsWith(optimusDir)
      ? resolvedOutputPath
      : path.join(optimusDir, "results", path.basename(output_path));

    // Resolve heartbeat timeout: explicit param > engine config > hardcoded default
    const DEFAULT_HEARTBEAT_MS = 180000; // 3 minutes
    const MAX_HEARTBEAT_MS = 1800000; // 30 minutes
    let resolvedHeartbeatTimeout: number;

    if (heartbeat_timeout_ms !== undefined) {
        if (typeof heartbeat_timeout_ms !== 'number' || heartbeat_timeout_ms <= 0 || heartbeat_timeout_ms > MAX_HEARTBEAT_MS) {
            throw new McpError(ErrorCode.InvalidParams, `heartbeat_timeout_ms must be a number between 1 and ${MAX_HEARTBEAT_MS} (30 min). Got: ${heartbeat_timeout_ms}`);
        }
        resolvedHeartbeatTimeout = heartbeat_timeout_ms;
    } else {
        // Try engine config
        const resolvedEngine = role_engine || (() => {
            const { engines } = loadValidEnginesAndModels(workspace_path);
            return engines.includes('claude-code') ? 'claude-code' : engines[0] || '';
        })();
        const engineTimeout = resolvedEngine ? loadEngineHeartbeatTimeout(workspace_path, resolvedEngine) : null;
        if (engineTimeout !== null) {
            if (engineTimeout <= 0 || engineTimeout > MAX_HEARTBEAT_MS) {
                console.error(`[Config] Warning: invalid engine heartbeat timeout ${engineTimeout} for '${resolvedEngine}'. Using default.`);
                resolvedHeartbeatTimeout = DEFAULT_HEARTBEAT_MS;
            } else {
                resolvedHeartbeatTimeout = engineTimeout;
            }
        } else {
            resolvedHeartbeatTimeout = DEFAULT_HEARTBEAT_MS;
        }
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
    TaskManifestManager.createTask(workspace_path, {
        taskId, type: "delegate_task", role, task_description, output_path, workspacePath: workspace_path, context_files: context_files || [],
        role_description, role_engine, role_model, required_skills,
        delegation_depth: parseInt(process.env.OPTIMUS_DELEGATION_DEPTH || '0', 10),
        parent_issue_number: parentIssueNumber,
        agent_id: agent_id || undefined,
        depends_on: Array.isArray(depends_on) && depends_on.length > 0 ? depends_on : undefined,
        heartbeat_timeout_ms: resolvedHeartbeatTimeout
    });

    // Dependency check: determine if task should be blocked
    let isBlocked = false;
    let blockedBy: string[] = [];
    if (Array.isArray(depends_on) && depends_on.length > 0) {
        const manifest = TaskManifestManager.loadManifest(workspace_path);
        blockedBy = depends_on.filter((depId: string) => {
            const dep = manifest[depId];
            return !dep || dep.status !== 'verified';
        });
        if (blockedBy.length > 0) {
            isBlocked = true;
            // Synchronously update to blocked status before any spawn
            TaskManifestManager.updateTask(workspace_path, taskId, {
                status: 'blocked',
                blocked_by: blockedBy
            });
        }
    }

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

    if (!isBlocked) {
        // Spawn background process using centralized helper
        spawnAsyncWorker(taskId, workspace_path);
    }

    // Context hint: check if there are relevant specs/proposals the caller might want to pass
    // TODO: remove after list_knowledge is proven stable (added 2026-03-15)
    // This heuristic is superseded by the list_knowledge tool + sub-agent self-discovery prompt.
    // Keeping for one release cycle as belt-and-suspenders.
    let contextHint = '';
    if (!context_files || context_files.length === 0) {
        try {
            const specsDir = path.join(workspace_path, '.optimus', 'specs');
            if (fs.existsSync(specsDir)) {
                const specFolders = fs.readdirSync(specsDir).filter(d => {
                    try { return fs.statSync(path.join(specsDir, d)).isDirectory(); } catch { return false; }
                }).sort().reverse().slice(0, 3); // newest 3
                if (specFolders.length > 0) {
                    contextHint = `\n\n💡 **Context hint**: Found specs that might be relevant — consider passing them as \`context_files\`:\n${specFolders.map(f => `  - \`.optimus/specs/${f}/\``).join('\n')}`;
                }
            }
        } catch { /* best-effort */ }
    }
    
    if (isBlocked) {
        return { content: [{ type: "text", text: `⏳ Task queued with dependencies.\n\n**Task ID**: ${taskId}\n**Role**: ${role}\n**Status**: blocked\n**Blocked by**: ${blockedBy.map(id => `\`${id}\``).join(', ')}${issueInfo}\n\nTask will auto-start when all dependencies reach \`verified\` status. Use check_task_status to monitor.${contextHint}` }] };
    }
    return { content: [{ type: "text", text: `✅ Task spawned successfully in background.\n\n**Task ID**: ${taskId}\n**Role**: ${role}${issueInfo}\n\nUse check_task_status tool periodically with this task ID to check its completion.${contextHint}` }] };
  }
  
  if (request.params.name === "dispatch_council_async") {
    let { proposal_path, roles, workspace_path, role_descriptions } = request.params.arguments as any;
    requireParams("dispatch_council_async", request.params.arguments as any, ["proposal_path", "workspace_path"]);
    if (!Array.isArray(roles) || roles.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments for dispatch_council_async: 'roles' must be a non-empty array of expert role names (e.g., ['security-expert', 'performance-tyrant'])");
    }

    // Resolve role aliases to canonical names
    roles = resolveRoleNames(roles, workspace_path);

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
        parent_issue_number: parentIssueNumber,
        role_descriptions: role_descriptions
    });

    // Best-effort: auto-create GitHub Issue for traceability
    let issueInfo = '';
    const remote = parseGitRemote(workspace_path);
    if (remote) {
        // Extract topic from proposal content heading (e.g., "# PROBLEM: Agent-driven automation")
        // Falls back to cleaned filename if no heading found
        let proposalName = require('path').basename(proposal_path, '.md').replace(/^PROPOSAL_/i, '').replace(/[_-]/g, ' ');
        try {
            const proposalContent = fs.readFileSync(path.resolve(workspace_path, proposal_path), 'utf8');
            const headingMatch = proposalContent.match(/^#\s+(?:PROBLEM|PROPOSAL|SOLUTION|REVIEW):\s*(.+)$/m);
            if (headingMatch) {
                proposalName = headingMatch[1].trim().substring(0, 100);
            } else {
                // Try any H1 heading
                const h1Match = proposalContent.match(/^#\s+(.+)$/m);
                if (h1Match) {
                    proposalName = h1Match[1].trim().substring(0, 100);
                }
            }
        } catch { /* best-effort — use filename fallback */ }
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
    
    // Spawn background process using centralized helper
    spawnAsyncWorker(taskId, workspace_path);

    return { content: [{ type: "text", text: `✅ Council spawned successfully in background.\n\n**Council ID**: ${taskId}\n**Roles**: ${roles.join(", ")}${issueInfo}\n\nUse check_task_status tool periodically with this Council ID to check completion.` }] };
  }

  if (request.params.name === "dispatch_council") {

    let { proposal_path, roles, workspace_path, role_descriptions } = request.params.arguments as any;

    requireParams("dispatch_council", request.params.arguments as any, ["proposal_path"]);
    if (!Array.isArray(roles) || roles.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments for dispatch_council: 'roles' must be a non-empty array of expert role names (e.g., ['security-expert', 'performance-tyrant'])");
    }

    // Resolve workspace first (needed for alias resolution)
    let workspacePath: string;
    const optimusIndex = proposal_path.indexOf('.optimus');
    if (optimusIndex !== -1) {
      workspacePath = proposal_path.substring(0, optimusIndex);
    } else {
      workspacePath = path.resolve(path.dirname(proposal_path));
    }

    // Resolve role aliases to canonical names
    roles = resolveRoleNames(roles, workspacePath);

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
          text: `⚠️ **Warning: You used the synchronous \`dispatch_council\`. This blocked your process for the entire council duration. Prefer \`dispatch_council_async\` + \`check_task_status\` for non-blocking execution.**\n\n⚖️ **Council Map-Reduce Review Completed**\nAll expert workers executed parallelly adhering to the Singleton Worker Rule.\n\nReviews are saved in isolated path: \`${reviewsPath}\`\n\nExecution Logs:\n${results.join('\n')}\n\nPlease read these review files to continue.`
        },
      ],
    };
        } else if (request.params.name === "append_memory") {
      let { category, tags, content, level } = request.params.arguments as any;
      requireParams("append_memory", request.params.arguments as any, ["category", "content"]);

      // User-level memory: separate subsystem with different format and trust domain
      if (level === 'user') {
        const userMemPath = getUserMemoryPath();
        if (!fs.existsSync(userMemPath)) {
          return {
            content: [{ type: "text", text: "User memory not initialized. Run `optimus memory init` first." }],
            isError: true
          };
        }
        const validation = validateUserMemoryContent(content);
        if (!validation.valid) {
          return {
            content: [{ type: "text", text: `Content rejected: ${validation.reason}` }],
            isError: true
          };
        }
        const resolvedCategory = category || 'uncategorized';
        appendToUserMemory(resolvedCategory, content);
        const displayCategory = resolvedCategory.charAt(0).toUpperCase() + resolvedCategory.slice(1).toLowerCase();
        return {
          content: [{ type: "text", text: `✅ Memory saved to user memory under ## ${displayCategory}` }]
        };
      }

      const workspacePath = process.env.OPTIMUS_WORKSPACE_ROOT || process.cwd();
      const memoryLevel: 'project' | 'role' = level === 'role' ? 'role' : 'project';
      const author = process.env.OPTIMUS_CURRENT_ROLE || 'unknown';

      // Determine target file based on level
      let memoryFile: string;
      if (memoryLevel === 'role') {
        const currentRole = process.env.OPTIMUS_CURRENT_ROLE;
        if (!currentRole) {
          return {
            content: [{ type: "text", text: "Cannot write role-level memory: OPTIMUS_CURRENT_ROLE not set. Use level: 'project' or ensure this is called from a delegated worker." }],
            isError: true
          };
        }
        memoryFile = getMemoryFilePath(workspacePath, 'role', currentRole);
      } else {
        memoryFile = getMemoryFilePath(workspacePath, 'project');
      }

      // Ensure parent directory exists
      const memoryDir = path.dirname(memoryFile);
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
            const freshEntry = buildMemoryEntry({
              level: memoryLevel,
              category: category || 'uncategorized',
              tags: tags || [],
              content: content,
              author: author,
            });

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
              text: `✅ Experience solidifed to memory!\nLevel: ${memoryLevel}\nTags: ${tags ? tags.join(', ') : '(none)'}\nMemory appended to: ${memoryFile}`
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
    requireParams("roster_check", request.params.arguments as any, ["workspace_path"]);

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
          const eng = config.engines[engine];
          const protocol = eng.protocol || 'cli';
          const statusMatch = eng.status ? ` *[Status: ${eng.status}]*` : '';
          roster += `- [Engine: ${engine}] Protocol: ${protocol} | Models: [${eng.available_models.join(', ')}]${statusMatch}\n`;
        });
          roster += "*Note: Append these engine and model combinations to role names to spawn customized variants. Examples: `chief-architect_claude-code_claude-3-opus`, `security-auditor_copilot-cli_o1-preview`.*\n\n";
        } catch (e: any) { console.error(`[RosterCheck] Warning: failed to read available-agents.json: ${e.message}`); }
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
          } catch (e: any) {
            console.error("[roster_check] Warning: failed to read role " + f + ":", e.message);
            roster += `- ${roleName}\n`;
          }
        }
      } else {
        roster += "(No project default roles found)\n";
      }
    } else {
      roster += "(No project roles directory found)\n";
    }

    // Show role aliases from registry
    const registeredRoles = getRegisteredRoles(workspace_path);
    if (registeredRoles.length > 0) {
      roster += "\n### Role Aliases (Quick Reference)\n";
      const byCategory: Record<string, Array<{ canonical: string; aliases: string[] }>> = {};
      for (const r of registeredRoles) {
        const cat = r.category || "uncategorized";
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({ canonical: r.canonical, aliases: r.aliases });
      }
      for (const [cat, roles] of Object.entries(byCategory)) {
        const roleStrs = roles.map(r => {
          const aliasStr = r.aliases.length > 0 ? ` (aliases: ${r.aliases.join(', ')})` : '';
          return `${r.canonical}${aliasStr}`;
        }).join(', ');
        roster += `**${cat}**: ${roleStrs}\n`;
      }
      roster += "*Tip: You can use any alias in delegate_task — it auto-resolves to the canonical name.*\n";
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
      } catch (e: any) { console.error(`[RosterCheck] Warning: failed to read T3 usage log: ${e.message}`); }
    }

    roster += "\n### ⚙️ Fallback Behavior\n";
    roster += "- If no roles/agents exist, the system defaults to **PM (Master Agent)** behavior.\n";
    roster += "- If a role has no `engine`/`model` in frontmatter, the system auto-resolves from `available-agents.json`, or falls back to `claude-code`.\n";
    roster += "- T3 roles auto-precipitate to T2 immediately on first use.\n";

    // Show available skills
    const skillsDir = path.join(workspace_path, '.optimus', 'skills');
    if (fs.existsSync(skillsDir)) {
      const skillDirs = fs.readdirSync(skillsDir).filter(d => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory() && fs.existsSync(path.join(skillsDir, d, 'SKILL.md')); } catch (e: any) { console.error("[roster_check] Warning: failed to stat skill dir " + d + ":", e.message); return false; }
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
          } catch (e: any) {
            console.error("[roster_check] Warning: failed to read skill " + skill + ":", e.message);
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
    let { role, role_description, role_engine, role_model, task_description, output_path, context_files, required_skills, agent_id } = request.params.arguments as any;
    let workspace_path = (request.params.arguments as any).workspace_path;

    // Resolve parent issue: explicit param > env var > undefined
    const rawParentSync = process.env.OPTIMUS_PARENT_ISSUE ? parseInt(process.env.OPTIMUS_PARENT_ISSUE, 10) : undefined;
    const parentIssueNumber = (request.params.arguments as any).parent_issue_number
        ?? (Number.isNaN(rawParentSync) ? undefined : rawParentSync);

    requireParams("delegate_task", request.params.arguments as any, ["role", "task_description", "output_path"]);

    if (!workspace_path) {
       // fallback to project root based on output_path or cwd
       workspace_path = process.cwd();
       if (output_path.includes("optimus-code")) {
         workspace_path = output_path.split("optimus-code")[0] + "optimus-code";
       }
    }

    // Resolve role alias to canonical name before validation
    role = resolveRoleName(role, workspace_path);

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
      const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files, { description: role_description, engine: role_engine, model: role_model, requiredSkills: required_skills }, undefined, parentIssueNumber, undefined, agent_id);
    return {
      content: [{ type: "text", text: result }]
    };
  } else if (request.params.name === "vcs_create_work_item") {
    const { title, body, labels, work_item_type, workspace_path,
            iteration_path, area_path, assigned_to, parent_id, priority, agent_role } = request.params.arguments as any;
    requireParams("vcs_create_work_item", request.params.arguments as any, ["title", "body", "workspace_path"]);

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      // Auto-append 'optimus-bot' label for traceability
      const finalLabels = Array.isArray(labels) ? [...labels] : [];
      if (!finalLabels.includes('optimus-bot')) finalLabels.push('optimus-bot');
      const result = await vcsProvider.createWorkItem(title, finalBody, finalLabels, work_item_type, {
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
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — failed to create work item: ${error.message}. The agent should continue without Issue tracking.` }] };
    }
  } else if (request.params.name === "vcs_create_pr") {
    const { title, body, head, base, workspace_path, agent_role } = request.params.arguments as any;
    requireParams("vcs_create_pr", request.params.arguments as any, ["title", "body", "head", "base", "workspace_path"]);

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const finalBody = agent_role ? body + agentSignature(agent_role) : body;
      const result = await vcsProvider.createPullRequest(title, finalBody, head, base);

      // Auto-label PR for traceability
      try {
          await vcsProvider.addLabels('pullrequest', result.number || result.id, ['optimus-bot']);
      } catch (labelErr: any) {
          console.error(`[VCS] Warning: failed to add optimus-bot label to PR: ${labelErr.message}`);
      }

      return {
        content: [{
          type: "text",
          text: `✅ Pull request created successfully on ${vcsProvider.getProviderName()}\n\n**Title:** ${result.title}\n**Number:** ${result.number}\n**ID:** ${result.id}\n**URL:** ${result.url}`
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — failed to create pull request: ${error.message}` }] };
    }
  } else if (request.params.name === "vcs_merge_pr") {
    const { pull_request_id, commit_title, merge_method, workspace_path } = request.params.arguments as any;
    requireParams("vcs_merge_pr", request.params.arguments as any, ["pull_request_id", "workspace_path"]);

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

      // Add 'agent-merged' label so humans know this PR was closed automatically by the agent
      try {
          await vcsProvider.addLabels('pullrequest', pull_request_id, ['agent-merged']);
      } catch (labelError: any) {
          console.error(`[Post-Merge Labeling] Warning: failed to add 'agent-merged' label to PR #${pull_request_id}: ${labelError.message}`);
      }

      return {
        content: [{
          type: "text",
          text: `✅ Pull request #${pull_request_id} merged successfully on ${vcsProvider.getProviderName()}.${branchCleanupMsg}${syncMsg}`
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — failed to merge pull request: ${error.message}` }] };
    }
  } else if (request.params.name === "vcs_add_comment") {
    const { item_type, item_id, comment, workspace_path, agent_role } = request.params.arguments as any;
    requireParams("vcs_add_comment", request.params.arguments as any, ["item_type", "item_id", "comment", "workspace_path"]);

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
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — failed to add comment: ${error.message}` }] };
    }
  } else if (request.params.name === "vcs_update_work_item") {
    const { item_id, state, title, labels_add, labels_remove, workspace_path } = request.params.arguments as any;
    requireParams("vcs_update_work_item", request.params.arguments as any, ["item_id", "workspace_path"]);

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const result = await vcsProvider.updateWorkItem(item_id, { state, title, labels_add, labels_remove });

      return {
        content: [{
          type: "text",
          text: `✅ Work item #${item_id} updated on ${vcsProvider.getProviderName()}\n\n**Title:** ${result.title}\n**URL:** ${result.url}${state ? `\n**State:** ${state}` : ''}`
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — failed to update work item: ${error.message}` }] };
    }
  } else if (request.params.name === "vcs_list_work_items") {
    const { state, labels, limit, workspace_path } = request.params.arguments as any;
    requireParams("vcs_list_work_items", request.params.arguments as any, ["workspace_path"]);

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const items = await vcsProvider.listWorkItems({ state, labels, limit });

      const summary = items.map(i => `#${i.number} [${i.state}] ${i.labels.length ? `(${i.labels.join(', ')}) ` : ''}${i.title}`).join('\n');
      return {
        content: [{
          type: "text",
          text: `Found ${items.length} work items on ${vcsProvider.getProviderName()}:\n\n${summary}`
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — could not list work items: ${error.message}. Returning empty list.` }] };
    }
  } else if (request.params.name === "vcs_list_pull_requests") {
    const { state, limit, workspace_path } = request.params.arguments as any;
    requireParams("vcs_list_pull_requests", request.params.arguments as any, ["workspace_path"]);

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const prs = await vcsProvider.listPullRequests({ state, limit });

      const summary = prs.map(pr => `#${pr.number} [${pr.state}] [${pr.mergeable}] ${pr.headBranch}→${pr.baseBranch} ${pr.labels.length ? `(${pr.labels.join(', ')}) ` : ''}${pr.title}`).join('\n');
      return {
        content: [{
          type: "text",
          text: `Found ${prs.length} pull requests on ${vcsProvider.getProviderName()}:\n\n${summary}`
        }]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `⚠️ VCS unavailable — could not list pull requests: ${error.message}. Returning empty list.` }] };
    }
  } else if (request.params.name === "write_blackboard_artifact") {
    const { artifact_path, content, workspace_path } = request.params.arguments as any;
    requireParams("write_blackboard_artifact", request.params.arguments as any, ["artifact_path", "workspace_path"]);
    if (content === undefined || content === null) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments for write_blackboard_artifact: 'content' must be provided (can be empty string, but not null/undefined)");
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
    requireParams("hello", request.params.arguments as any, ["name"]);
    return { content: [{ type: "text", text: `Hello, ${name}! Optimus Swarm is running.` }] };
  } else if (request.params.name === "quarantine_role") {
    const { role, action, workspace_path } = request.params.arguments as any;
    requireParams("quarantine_role", request.params.arguments as any, ["role", "action", "workspace_path"]);

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


  if (request.params.name === "register_meta_cron") {
    const { id, cron_expression, role, required_skills, capability_tier, concurrency_policy, max_actions, dry_run_remaining, startup_timeout_ms, workspace_path } = request.params.arguments as any;
    requireParams("register_meta_cron", request.params.arguments as any, ["id", "cron_expression", "role", "workspace_path"]);
    if (process.env.OPTIMUS_CRON_TRIGGERED === 'true') {
      return { content: [{ type: "text", text: "Self-registration denied: cron-triggered agents cannot register new Meta-Cron entries." }] };
    }

    // Validate startup_timeout_ms if provided
    const MAX_STARTUP_TIMEOUT_MS = 600000; // 10 minutes
    if (startup_timeout_ms !== undefined) {
        if (typeof startup_timeout_ms !== 'number' || startup_timeout_ms <= 0 || startup_timeout_ms > MAX_STARTUP_TIMEOUT_MS) {
            throw new McpError(ErrorCode.InvalidParams, `startup_timeout_ms must be a number between 1 and ${MAX_STARTUP_TIMEOUT_MS} (10 min). Got: ${startup_timeout_ms}`);
        }
    }

    const crontab = loadCrontab(workspace_path) || { max_concurrent: 3, crons: [] };
    if (crontab.crons.find((cr: any) => cr.id === id)) {
      return { content: [{ type: "text", text: `Cron entry '${id}' already exists. Remove it first.` }] };
    }
    crontab.crons.push({
      id, cron_expression, role,
      required_skills: required_skills || [],
      capability_tier: capability_tier || 'maintain',
      concurrency_policy: concurrency_policy || 'Forbid',
      max_actions: max_actions || 5,
      dry_run_remaining: dry_run_remaining ?? 3,
      enabled: true, last_run: null, last_status: null,
      run_count: 0, fail_count: 0,
      created_at: new Date().toISOString(),
      ...(startup_timeout_ms !== undefined ? { startup_timeout_ms } : {}),
    });
    saveCrontab(workspace_path, crontab);
    return { content: [{ type: "text", text: `Registered Meta-Cron '${id}' (cron: ${cron_expression}) -> role '${role}'. Dry-run for ${dry_run_remaining ?? 3} ticks.` }] };
  }

  if (request.params.name === "list_meta_crons") {
    const { workspace_path } = request.params.arguments as any;
    requireParams("list_meta_crons", request.params.arguments as any, ["workspace_path"]);
    const crontab = loadCrontab(workspace_path);
    if (!crontab || crontab.crons.length === 0) {
      return { content: [{ type: "text", text: "No Meta-Cron entries registered." }] };
    }
    const lines = crontab.crons.map((e: any) =>
      `| ${e.id} | ${e.cron_expression} | ${e.role} | ${e.enabled ? 'yes' : 'no'} | ${e.last_status || 'never'} | ${e.run_count} | ${e.fail_count} | ${e.dry_run_remaining} |`
    );
    const table = `| ID | Cron | Role | Enabled | Last Status | Runs | Fails | Dry-Run |\n|---|---|---|---|---|---|---|---|\n${lines.join('\n')}\n\nMax concurrent: ${crontab.max_concurrent}`;
    return { content: [{ type: "text", text: table }] };
  }

  if (request.params.name === "remove_meta_cron") {
    const { id, workspace_path } = request.params.arguments as any;
    requireParams("remove_meta_cron", request.params.arguments as any, ["id", "workspace_path"]);
    const crontab = loadCrontab(workspace_path);
    if (!crontab) return { content: [{ type: "text", text: "No crontab found." }] };
    const idx = crontab.crons.findIndex((cr: any) => cr.id === id);
    if (idx === -1) return { content: [{ type: "text", text: `Cron entry '${id}' not found.` }] };
    crontab.crons.splice(idx, 1);
    saveCrontab(workspace_path, crontab);
    const lockPath = path.join(workspace_path, '.optimus', 'system', 'cron-locks', id + '.lock');
    try { if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath); } catch (e: any) { console.error(`[MCP] Warning: operation failed: ${e.message}`); }
    return { content: [{ type: "text", text: `Removed Meta-Cron entry '${id}' and cleaned up lock file.` }] };
  }

  if (request.params.name === "request_human_input") {
    const { question, context_summary, options, task_id, workspace_path } = request.params.arguments as any;
    requireParams("request_human_input", request.params.arguments as any, ["question", "context_summary", "workspace_path"]);

    const MAX_PAUSE_CYCLES = 3;

    // Resolve task ID: explicit param > env var
    const resolvedTaskId = task_id || process.env.OPTIMUS_TASK_ID;
    if (!resolvedTaskId) {
      throw new McpError(ErrorCode.InvalidParams, "Cannot determine task ID. Provide task_id parameter or ensure OPTIMUS_TASK_ID env var is set.");
    }

    // Look up the task in manifest
    const manifest = TaskManifestManager.loadManifest(workspace_path);
    const task = manifest[resolvedTaskId];
    if (!task) {
      throw new McpError(ErrorCode.InvalidParams, `Task '${resolvedTaskId}' not found in manifest.`);
    }

    // Check pause count limit
    const currentPauseCount = task.pause_count || 0;
    if (currentPauseCount >= MAX_PAUSE_CYCLES) {
      return {
        content: [{
          type: "text",
          text: `❌ Task has reached the maximum number of pause cycles (${MAX_PAUSE_CYCLES}). You must either complete the task with available information or mark it as failed.`
        }]
      };
    }

    // Post formatted comment on the linked GitHub Issue
    let commentId: string | undefined;
    if (task.github_issue_number) {
      try {
        const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
        let commentBody = `🔴 **Agent Needs Human Input**\n\n**Role:** \`${task.role || 'unknown'}\`\n**Task:** ${(task.task_description || '').substring(0, 200)}${(task.task_description || '').length > 200 ? '...' : ''}\n\n### Question\n${question}\n\n### Context\n${context_summary}\n\n### How to Respond\nReply to this issue with your answer. The agent will automatically resume within ~5 minutes.`;

        if (options && Array.isArray(options) && options.length > 0) {
          commentBody += `\n\n### Suggested Options\n${options.map((o: string) => `- ${o}`).join('\n')}`;
        }

        const result = await vcsProvider.addComment('workitem', task.github_issue_number, commentBody);
        commentId = result.id;
        
        // Add visible labels so humans know it needs attention
        try {
            await vcsProvider.addLabels('workitem', task.github_issue_number, ['question', 'help wanted']);
        } catch (labelError: any) {
            console.error(`[request_human_input] Failed to add labels to issue #${task.github_issue_number}: ${labelError.message}`);
        }
      } catch (e: any) {
        console.error(`[request_human_input] Failed to post comment on issue #${task.github_issue_number}: ${e.message}`);
      }
    }

    // Update TaskRecord with pause state
    TaskManifestManager.updateTask(workspace_path, resolvedTaskId, {
      status: 'awaiting_input',
      pause_question: question,
      pause_context: context_summary,
      pause_timestamp: Date.now(),
      pause_github_comment_id: commentId ? parseInt(commentId) : undefined,
      pause_count: currentPauseCount + 1
    });

    const issueRef = task.github_issue_number ? ` A question has been posted on issue #${task.github_issue_number}.` : ' No linked GitHub issue found — the question could not be posted externally.';
    return {
      content: [{
        type: "text",
        text: `✅ Task paused successfully. Status set to 'awaiting_input'.${issueRef}\n\nYou can now exit cleanly. A human will answer the question, and the system will automatically resume a fresh agent with the answer within ~5 minutes of the response.`
      }]
    };
  }

  if (request.params.name === "list_knowledge") {
    const { workspace_path, category, topic } = request.params.arguments as any;
    requireParams("list_knowledge", request.params.arguments as any, ["workspace_path"]);

    const knowledgeDirs: Record<string, string> = { specs: 'specs', memory: 'memory', reports: 'reports', reviews: 'reviews' };
    const categories = (!category || category === 'all') ? Object.keys(knowledgeDirs) : [category];
    const optimusRoot = path.resolve(workspace_path, '.optimus');

    // SECURITY: dual-layer path validation (lexical + symlink-aware), matching write_blackboard_artifact
    const realOptimus = fs.existsSync(optimusRoot) ? fs.realpathSync(optimusRoot) : optimusRoot;

    const artifacts: Array<{ path: string; type: string; date: string; size_chars: number; topic: string }> = [];
    const summary: Record<string, number> = { specs: 0, memory: 0, reports: 0, reviews: 0 };

    const datePattern = /^(\d{4}-\d{2}-\d{2})/;

    function scanDir(dirPath: string, cat: string) {
      let entries: string[];
      try { entries = fs.readdirSync(dirPath); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        // Lexical containment check
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(optimusRoot + path.sep) && resolved !== optimusRoot) continue;
        // Symlink containment check
        try {
          const realPath = fs.realpathSync(resolved);
          if (!realPath.startsWith(realOptimus + path.sep) && realPath !== realOptimus) continue;
        } catch { continue; } // race tolerance: skip if path vanished

        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; } // race tolerance

        if (stat.isDirectory()) {
          scanDir(fullPath, cat);
        } else if (stat.isFile()) {
          const relativePath = path.relative(workspace_path, fullPath).replace(/\\/g, '/');
          // Extract date from parent folder name or fall back to mtime
          const parentName = path.basename(path.dirname(fullPath));
          const dateMatch = parentName.match(datePattern);
          const date = dateMatch ? dateMatch[1] : stat.mtime.toISOString().slice(0, 10);
          // Extract topic from parent folder name (strip date prefix) or file stem
          const topicStr = dateMatch
            ? parentName.replace(datePattern, '').replace(/^-/, '').replace(/-/g, ' ').trim()
            : path.basename(fullPath, path.extname(fullPath)).replace(/-/g, ' ').replace(/_/g, ' ');

          artifacts.push({ path: relativePath, type: cat, date, size_chars: stat.size, topic: topicStr || parentName });
          summary[cat] = (summary[cat] || 0) + 1;
        }
      }
    }

    for (const cat of categories) {
      const dirName = knowledgeDirs[cat];
      if (!dirName) continue;
      const dirPath = path.join(optimusRoot, dirName);
      // Validate this directory is within .optimus
      const resolvedDir = path.resolve(dirPath);
      if (!resolvedDir.startsWith(optimusRoot + path.sep) && resolvedDir !== optimusRoot) continue;
      scanDir(dirPath, cat);
    }

    // Apply topic keyword filter
    const filtered = topic
      ? artifacts.filter(a => a.path.toLowerCase().includes(topic.toLowerCase()) || a.topic.toLowerCase().includes(topic.toLowerCase()))
      : artifacts;

    const filteredSummary: Record<string, number> = { specs: 0, memory: 0, reports: 0, reviews: 0 };
    for (const a of filtered) filteredSummary[a.type] = (filteredSummary[a.type] || 0) + 1;

    const result = {
      artifacts: filtered,
      summary: { ...filteredSummary, total: filtered.length }
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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

    // Meta-Cron: start the in-process scheduler
    try {
      MetaCronEngine.init(workspaceRoot);
    } catch (e: any) {
      console.error(`[Meta-Cron] Init failed: ${e.message}`);
    }

    // Resume checker: periodically check for human answers on paused tasks
    const resumeInterval = setInterval(async () => {
      try {
        const result = await checkAndResumeAwaitingTasks(workspaceRoot);
        if (result) console.error(`[ResumeChecker] ${result}`);
      } catch (e: any) {
        console.error(`[ResumeChecker] Error: ${e.message}`);
      }
    }, 5 * 60 * 1000); // every 5 minutes
    if (typeof resumeInterval.unref === 'function') resumeInterval.unref();

    process.on('SIGTERM', () => MetaCronEngine.shutdown());
    process.on('SIGINT', () => MetaCronEngine.shutdown());
  }

  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}