import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { dispatchCouncilConcurrent, delegateTaskSingle } from "./worker-spawner";
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
      tools: {},
    },
  }
);

// 2. Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
          required: ["owner", "repo", "title", "body"]
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
          },
          required: ["role", "task_description", "output_path", "workspace_path"],
        }
      }
    ],
  };
});

// 3. Handle Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "dispatch_council") {
    const { proposal_path, roles } = request.params.arguments as any;
    
    if (!proposal_path || !Array.isArray(roles) || roles.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires proposal_path and an array of roles");
    }

    const timestampId = Date.now();
    
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
    } else if (request.params.name === "github_create_issue") {
    const { owner, repo, title, body, labels, local_path, session_id } = request.params.arguments as any;
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

    const t1Dir = path.join(workspace_path, ".optimus", "personas");
    const t2Dir = path.join(__dirname, "..", "agents");

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
    const { role, task_description, output_path, workspace_path } = request.params.arguments as any;
    
    if (!role || !task_description || !output_path || !workspace_path) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid arguments: requires role, task_description, output_path, and workspace_path");
    }

    const sessionId = crypto.randomUUID();
    
    // Use the explicit workspace_path to guarantee all artifacts land inside .optimus/.
    // Previously, workspace was inferred from output_path which broke when callers supplied
    // relative paths like "./qa_report.md" (path.resolve(dirname, "..") would escape the project).
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
    const result = await delegateTaskSingle(role, taskArtifactPath, canonicalOutputPath, sessionId, workspacePath);

    return {
      content: [{ type: "text", text: result }]
    };
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
});

// 4. Start standard stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Optimus Spartan Swarm MCP server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});