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
import crypto from "crypto";
import { dispatchCouncilConcurrent, delegateTaskSingle } from "./worker-spawner";
import { TaskManifestManager } from "../managers/TaskManifestManager";
import { runAsyncWorker } from "./council-runner";
import { spawn } from "child_process";
import dotenv from "dotenv";

// Load environment variables from .env file up to the repository root
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config(); // fallback to cwd

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
              description: "The name of the expert role (e.g., 'chief-architect', 'frontend-dev'). The system will auto-resolve this to the best available prompt.",
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
              description: "Absolute path to the project workspace root. All artifacts (task blackboard, result files) will be isolated under <workspace_path>/.optimus/.",
            },
            context_files: {
              type: "array",
              items: { type: "string" },
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task.",
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
              description: "Optional array of workspace-relative paths to design documents, architecture specs, or requirement files that the agent must strictly read before executing the task.",
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
    let details = `Task ${taskId} status: **${task.status}**\n`;
    if (task.status === 'completed') details += `\nOutput is ready at ${task.output_path || 'the review path'}.`;
    if (task.status === 'failed') details += `\nError: ${task.error_message}`;
    
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
    
    // Spawn background process
    const child = spawn(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
        detached: true, stdio: "ignore"
    });
    child.unref();
    
    return { content: [{ type: "text", text: `✅ Task spawned successfully in background.\n\n**Task ID**: ${taskId}\n**Role**: ${role}\n\nUse check_task_status tool periodically with this task ID to check its completion.` }] };
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
    
    // Spawn background process
    const child = spawn(process.execPath, [__filename, "--run-task", taskId, workspace_path], {
        detached: true, stdio: "ignore"
    });
    child.unref();
    
    return { content: [{ type: "text", text: `✅ Council spawned successfully in background.\n\n**Council ID**: ${taskId}\n**Roles**: ${roles.join(", ")}\n\nUse check_task_status tool periodically with this Council ID to check completion.` }] };
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
      const { owner, repo, issue_number, state, body, agent_role, session_id } = request.params.arguments as any;
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
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
    
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
        body: JSON.stringify({ title, body: finalBody, labels: labels || [] })
      });
      if (!resp.ok) throw new Error(`GitHub API Error: ${resp.status}`);
      const data: any = await resp.json();
      return { content: [{ type: "text", text: `Issue created: ${data.html_url}` }] };
    } catch (e: any) { throw new McpError(ErrorCode.InternalError, String(e)); }
  } else if (request.params.name === "github_create_pr") {
      const { owner, repo, title, head, base, body } = request.params.arguments as any;
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!token) throw new McpError(ErrorCode.InvalidRequest, "GITHUB_TOKEN env is not set");
      try {
        const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Optimus-Agent"
          },
          body: JSON.stringify({ title, head, base, body: body || '' })
        });
        if (!resp.ok) {
          throw new Error('GitHub API Error: ' + await resp.text());
        }
        const data = (await resp.json()) as any;
        return { content: [{ type: "text", text: `Pull request created successfully! PR Number: ${data.number}\nURL: ${data.html_url}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to create PR: ${err.message}` }], isError: true };
      }
    } else if (request.params.name === "github_merge_pr") {
      const { owner, repo, pull_number, commit_title, merge_method } = request.params.arguments as any;
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
    const t2Dir = path.join(__dirname, "..", "..", "optimus-plugin", "roles");

    let roster = "📋 **Spartan Swarm Active Roster**\n\n";

    roster += "### T1: Local Project Experts\n";
    if (fs.existsSync(t1Dir)) {
      const t1Files = fs.readdirSync(t1Dir).filter(f => f.endsWith('.md'));
      roster += t1Files.length > 0 ? t1Files.map(f => `- ${f.replace('.md', '')}`).join('\n') : "(No local overrides found)\n";
    } else {
      roster += "(No local personas directory found)\n";
    }

    // --- Dynamic Registry Loading ---
    const registryPath = path.join(workspace_path, ".optimus", "registry", "available-agents.json");
    if (fs.existsSync(registryPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        roster += "\n### ⚙️ Dynamic Registry: Execution Engines & Agents\n";
        roster += "**Available Execution Engines (Toolchains & Supported Models)**:\n";
        Object.keys(registry.engines).forEach(engine => {
          roster += `- [Engine: ${engine}] Models: [${registry.engines[engine].available_models.join(', ')}]\n`;
        });
        roster += "\n**Strategic Identifiers (Modifiers)**:\n";
        Object.keys(registry.roles).forEach(role => {
          roster += `- ${role}: [${registry.roles[role].strategies.join(', ')}]\n`;
        });
        roster += "*Note: Append these combinations to role names to spawn customized variants. Examples: `chief-architect_claude-code_claude-3-opus`, `chief-architect_copilot-cli_o1-preview_conservative`.*\n\n";
      } catch (e) {}
    }

    roster += "\n### T2: Global Spartan Regulars\n";
    if (fs.existsSync(t2Dir)) {
      const t2Files = fs.readdirSync(t2Dir).filter(f => f.endsWith('.md'));
      roster += t2Files.length > 0 ? t2Files.map(f => `- ${f.replace('.md', '')}`).join('\n') : "(No global agents found)\n";
    } else {
      roster += "(No global agents directory found)\n";
    }

    roster += "\n*Note: Master Agent may still summon T3 Generic Roles dynamically if needed.*";

    return {
      content: [{ type: "text", text: roster }]
    };
  } else if (request.params.name === "delegate_task") {
    const { role, task_description, output_path, context_files } = request.params.arguments as any;
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
      const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath, context_files);
    return {
      content: [{ type: "text", text: result }]
    };
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
