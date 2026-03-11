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
import { dispatchCouncilConcurrent, delegateTaskSingle } from "./worker-spawner";
import { TaskManifestManager } from "../managers/TaskManifestManager";
import { parseGitRemote, createGitHubIssue } from "../utils/githubApi";
import { runAsyncWorker } from "./council-runner";
import { spawn } from "child_process";
import dotenv from "dotenv";
import { VcsProviderFactory } from "../adapters/vcs/VcsProviderFactory";

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
          name: "github_create_issue",
        description: "Creates a new issue in a GitHub repository.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner (e.g. cloga)" },
            repo: { type: "string", description: "Repository name (e.g. optimus-code)" },
            title: { type: "string", description: "Issue title" },
            body: { type: "string", description: "Issue body/contents" },              local_path: { type: "string", description: "The local blackboard file path (e.g. .optimus/proposals/PROPOSAL_XY.md) for A2A cross-reference" },
              session_id: { type: "string", description: "The Session ID or Agent ID creating this issue for traceability" },            labels: { type: "array", items: { type: "string" }, description: "Labels to apply" }
          },
          required: ["owner", "repo", "title", "body", "local_path"]
        }
      },
        {
          name: "github_create_pr",
          description: "Creates a new pull request in a GitHub repository.",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              title: { type: "string" },
              head: { type: "string", description: "The name of the branch where your changes are implemented." },
              base: { type: "string", description: "The name of the branch you want the changes pulled into." },
              body: { type: "string" },
                agent_role: { type: "string", description: "The role of the agent making this PR (e.g., 'dev')" },
                session_id: { type: "string", description: "The session ID of the agent" }
            },
            required: ["owner", "repo", "title", "head", "base"]
          }
        },
        {
          name: "github_merge_pr",
          description: "Merges a pull request in a GitHub repository.",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              pull_number: { type: "number" },
              commit_title: { type: "string" },
              merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
                agent_role: { type: "string", description: "The role of the agent merging this PR (e.g., 'pm')" },
                session_id: { type: "string", description: "The session ID of the agent" }
            },
            required: ["owner", "repo", "pull_number"]
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
        name: "vcs_create_work_item",
        description: "Create a work item (GitHub Issue or ADO Work Item) using the unified VCS provider.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Work item title" },
            body: { type: "string", description: "Work item description/body" },
            labels: { type: "array", items: { type: "string" }, description: "Labels/tags to apply" },
            work_item_type: { type: "string", description: "ADO work item type (Bug, User Story, Task). Ignored for GitHub." },
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
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
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
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
            workspace_path: { type: "string", description: "Absolute path to the project workspace root." }
          },
          required: ["item_type", "item_id", "comment", "workspace_path"]
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
    let { role, task_description, output_path, workspace_path, context_files } = request.params.arguments as any;
    if (!role || !task_description || !output_path || !workspace_path) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments");
    }
    
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
    TaskManifestManager.createTask(workspace_path, {
        taskId, type: "delegate_task", role, task_description, output_path, workspacePath: workspace_path, context_files: context_files || []
    });

    // Best-effort: auto-create GitHub Issue for traceability
    let issueInfo = '';
    const remote = parseGitRemote(workspace_path);
    if (remote) {
        const truncDesc = task_description.length > 300 ? task_description.substring(0, 300) + '...' : task_description;
        const shortTitle = task_description.split('\n')[0].substring(0, 80).trim();
        const issue = await createGitHubIssue(remote.owner, remote.repo,
            `[Task] ${role}: ${shortTitle}...`,
            `## Auto-generated Swarm Task Tracker\n\n**Task ID:** \`${taskId}\`\n**Role:** \`${role}\`\n**Output Path:** \`${output_path}\`\n\n### Task Description\n${truncDesc}`,
            ['swarm-task']
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
    let { proposal_path, roles, workspace_path } = request.params.arguments as any;
    if (!proposal_path || !Array.isArray(roles) || !workspace_path) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid arguments");
    }
    
    const taskId = `council_${Date.now()}_${Math.random().toString(36).substring(2,8)}`;
    const reviewsPath = path.join(workspace_path, ".optimus", "reviews", taskId);
    TaskManifestManager.createTask(workspace_path, {
        taskId, type: "dispatch_council", roles, proposal_path, output_path: reviewsPath, workspacePath: workspace_path
    });

    // Best-effort: auto-create GitHub Issue for traceability
    let issueInfo = '';
    const remote = parseGitRemote(workspace_path);
    if (remote) {
        const proposalName = require('path').basename(proposal_path, '.md').replace(/^PROPOSAL_/i, '').replace(/[_-]/g, ' ');
        const issue = await createGitHubIssue(remote.owner, remote.repo,
            `[Council] ${proposalName} (Review)`,
            `## Auto-generated Council Review Tracker\n\n**Council ID:** \`${taskId}\`\n**Roles:** ${roles.map((r: string) => `\`${r}\``).join(', ')}\n**Proposal:** \`${proposal_path}\`\n**Reviews Path:** \`${reviewsPath}\``,
            ['swarm-council']
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

    let { proposal_path, roles, workspace_path } = request.params.arguments as any;
    
    if (!proposal_path || !Array.isArray(roles) || roles.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires proposal_path and an array of roles");
    }
    
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
    const results = await dispatchCouncilConcurrent(roles, proposal_path, reviewsPath, timestampId.toString(), workspacePath);

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
    } else if (request.params.name === "github_update_issue") {
      reloadEnv(); // Hot-reload .env for long-running MCP process
      const { owner, repo, issue_number, state, body, title, agent_role, session_id } = request.params.arguments as any;
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
      
      try {
        let finalBody = body;
        // If state is being changed, or body provided, append metadata
        if ((agent_role || session_id) && finalBody) {
          finalBody += '\n\n---\n**🤖 Agent System Metadata [Update]:**\n';
          if (agent_role) finalBody += `- **Agent Role:** \`${agent_role}\`\n`;
          if (session_id) finalBody += `- **Agent Session ID:** \`${session_id}\`\n`;
        }

        const payload: any = {};
        if (state) payload.state = state;
        if (title) payload.title = title;
        if (finalBody) payload.body = finalBody;

        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issue_number}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Optimus-Agent"
          },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          throw new Error('GitHub API Error: ' + await resp.text());
        }
        const data = (await resp.json()) as any;
        return { content: [{ type: "text", text: `Issue #${issue_number} updated successfully. State is now: ${data.state}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to update Issue: ${err.message}` }], isError: true };
      }
    } else if (request.params.name === "github_create_issue") {
    const { owner, repo, title, body, labels, local_path, session_id } = request.params.arguments as any;
      if (!local_path) {
        throw new McpError(ErrorCode.InvalidParams, "Violated Issue First Protocol: local_path is mandatory to bind to a blackboard file (e.g. .optimus/tasks/task.md)");
      }
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    
    // Auto-tag: prefix title and ensure optimus-bot label
    const taggedTitle = title.startsWith('[Optimus]') ? title : `[Optimus] ${title}`;
    const issueLabels = Array.isArray(labels) ? [...labels] : [];
    if (!issueLabels.includes('optimus-bot')) issueLabels.push('optimus-bot');

    let finalBody = body;
    if (local_path || session_id) {
      finalBody += '\n\n---\n**🤖 Agent System Metadata:**\n';
      if (local_path) finalBody += `- **Local Blackboard:** \`${local_path}\`\n`;
      if (session_id) finalBody += `- **Agent Session ID:** \`${session_id}\`\n`;
    }

    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "Optimus-Agent"
        },
        body: JSON.stringify({ title: taggedTitle, body: finalBody, labels: issueLabels })
      });
      if (!resp.ok) throw new Error(`GitHub API Error: ${resp.status}`);
      const data: any = await resp.json();
      return { content: [{ type: "text", text: `Issue created: ${data.html_url}` }] };
    } catch (e: any) { throw new McpError(ErrorCode.InternalError, String(e)); }
  } else if (request.params.name === "github_create_pr") {
      const { owner, repo, title, head, base, body } = request.params.arguments as any;
      reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
      // Auto-tag: prefix PR title
      const taggedTitle = title.startsWith('[Optimus]') ? title : `[Optimus] ${title}`;
      try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Optimus-Agent"
          },
          body: JSON.stringify({ title: taggedTitle, head, base, body: body || '' })
        });
        if (!resp.ok) {
          throw new Error('GitHub API Error: ' + await resp.text());
        }
        const data = (await resp.json()) as any;
        // Auto-label: add optimus-bot label to the PR
        try {
          await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${data.number}/labels`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github.v3+json",
              "Content-Type": "application/json",
              "User-Agent": "Optimus-Agent"
            },
            body: JSON.stringify({ labels: ["optimus-bot"] })
          });
        } catch (_) { /* label is best-effort, don't fail the PR */ }
        return { content: [{ type: "text", text: `Pull request created successfully! PR Number: ${data.number}\nURL: ${data.html_url}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to create PR: ${err.message}` }], isError: true };
      }
    } else if (request.params.name === "github_merge_pr") {
      const { owner, repo, pull_number, commit_title, merge_method } = request.params.arguments as any;
      reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
      try {
        const payload: any = { merge_method: merge_method || 'merge' };
        if (commit_title) payload.commit_title = commit_title;
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Optimus-Agent"
          },
          body: JSON.stringify(payload)
        });
        if (!resp.ok) {
          throw new Error('GitHub API Error: ' + await resp.text());
        }
        const data = (await resp.json()) as any;
        return { content: [{ type: "text", text: `Pull request #${pull_number} merged successfully: ${data.message}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to merge PR: ${err.message}` }], isError: true };
      }
    } else if (request.params.name === "github_sync_board") {
    const { owner, repo, workspace_path } = request.params.arguments as any;
    reloadEnv();
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    try {
      const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Optimus-Agent"
        }
      });
      if (!resp.ok) throw new Error(`GitHub API Error: ${resp.status}`);
      const issues: any = await resp.json();
      let markdown = `# Task Board\n\n`;
      let count = 0;
      for (const issue of issues) {
        if (!issue.pull_request) {
          count++;
          markdown += `## [#${issue.number}] ${issue.title}\n`;
          markdown += `- **URL**: ${issue.html_url}\n`;
          markdown += `${issue.body ? issue.body.split('\n').map((l: string) => '> '+l).join('\n') : '> No description'}\n\n`;
        }
      }
      const p = path.join(workspace_path, '.optimus', 'state', 'TODO.md');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, markdown, 'utf8');
      return { content: [{ type: "text", text: `Synced ${count} issues to ${p}` }] };
    } catch (e: any) { throw new McpError(ErrorCode.InternalError, String(e)); }
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

    roster += "\n### T2: Project Default Roles (.optimus/roles)\n";
    if (fs.existsSync(t2Dir)) {
      const t2Files = fs.readdirSync(t2Dir).filter(f => f.endsWith('.md'));
      if (t2Files.length > 0) {
        for (const f of t2Files) {
          const roleName = f.replace('.md', '');
          try {
            const content = fs.readFileSync(path.join(t2Dir, f), 'utf8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let engineInfo = '';
            if (fmMatch) {
              const lines = fmMatch[1].split('\n');
              const engineLine = lines.find(l => l.startsWith('engine:'));
              const modelLine = lines.find(l => l.startsWith('model:'));
              if (engineLine || modelLine) {
                const engine = engineLine ? engineLine.split(':')[1].trim() : '?';
                const model = modelLine ? modelLine.split(':')[1].trim() : '?';
                engineInfo = ` → \`${engine}\` / \`${model}\``;
              }
            }
            roster += `- ${roleName}${engineInfo}\n`;
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
        roster += "\n### 📚 Available Skills\n";
        roster += "Use `required_skills` in `delegate_task` to equip agents with these skills:\n";
        for (const skill of skillDirs) {
          try {
            const content = fs.readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            let desc = '';
            if (fmMatch) {
              const descLine = fmMatch[1].split('\n').find(l => l.startsWith('description:'));
              if (descLine) desc = ' — ' + descLine.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
            }
            const isMeta = skill === 'agent-creator' || skill === 'skill-creator';
            roster += `- ${isMeta ? '🧬 ' : ''}\`${skill}\`${desc}\n`;
          } catch {
            roster += `- \`${skill}\`\n`;
          }
        }
      }
    }

    return {
      content: [{ type: "text", text: roster }]
    };
  } else if (request.params.name === "delegate_task") {
    const { role, role_description, role_engine, role_model, task_description, output_path, context_files, required_skills } = request.params.arguments as any;
    let workspace_path = (request.params.arguments as any).workspace_path;

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
      const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files, { description: role_description, engine: role_engine, model: role_model, requiredSkills: required_skills });
    return {
      content: [{ type: "text", text: result }]
    };
  } else if (request.params.name === "vcs_create_work_item") {
    const { title, body, labels, work_item_type, workspace_path } = request.params.arguments as any;
    if (!title || !body || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires title, body, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const result = await vcsProvider.createWorkItem(title, body, labels, work_item_type);

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
    const { title, body, head, base, workspace_path } = request.params.arguments as any;
    if (!title || !body || !head || !base || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires title, body, head, base, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const result = await vcsProvider.createPullRequest(title, body, head, base);

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

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const success = await vcsProvider.mergePullRequest(pull_request_id, commit_title, merge_method);

      return {
        content: [{
          type: "text",
          text: success
            ? `✅ Pull request #${pull_request_id} merged successfully on ${vcsProvider.getProviderName()}`
            : `❌ Failed to merge pull request #${pull_request_id} on ${vcsProvider.getProviderName()}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to merge pull request: ${error.message}`);
    }
  } else if (request.params.name === "vcs_add_comment") {
    const { item_type, item_id, comment, workspace_path } = request.params.arguments as any;
    if (!item_type || !item_id || !comment || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires item_type, item_id, comment, and workspace_path");
    }

    try {
      const vcsProvider = await VcsProviderFactory.getProvider(workspace_path);
      const result = await vcsProvider.addComment(item_type, item_id, comment);

      return {
        content: [{
          type: "text",
          text: `✅ Comment added successfully to ${item_type} #${item_id} on ${vcsProvider.getProviderName()}\n\n**Comment ID:** ${result.id}\n**URL:** ${result.url}`
        }]
      };
    } catch (error: any) {
      throw new McpError(ErrorCode.InternalError, `Failed to add comment: ${error.message}`);
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
  }

  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
