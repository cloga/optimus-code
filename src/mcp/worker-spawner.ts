import fs from "fs";
import path from "path";
import { AgentAdapter } from "../adapters/AgentAdapter";
import { ClaudeCodeAdapter } from "../adapters/ClaudeCodeAdapter";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";

function parseFrontmatter(content: string): { frontmatter: Record<string, string>, body: string } {
    const yamlRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(yamlRegex);
    let frontmatter: Record<string, string> = {};
    let body = content;
    
    if (match) {
        const yamlBlock = match[1];
        body = match[2];
        yamlBlock.split('\n').forEach(line => {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0) {
                const key = line.slice(0, colonIdx).trim();
                const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
                if (key) frontmatter[key] = value;
            }
        });
    }
    
    return { frontmatter, body };
}

function updateFrontmatter(content: string, updates: Record<string, string>): string {
    const parsed = parseFrontmatter(content);
    const newFm = { ...parsed.frontmatter, ...updates };
    
    let yamlStr = '---\n';
    for (const [k, v] of Object.entries(newFm)) {
        yamlStr += `${k}: ${v}\n`;
    }
    yamlStr += '---';
    
    const bodyStr = parsed.body.startsWith('\n') ? parsed.body : '\n' + parsed.body;
    return yamlStr + bodyStr;
}

function parseRoleSpec(roleArg: string): { role: string, engine?: string, model?: string } {
    const segments = path.basename(roleArg).split('_').filter(Boolean);
    const engineIndex = segments.findIndex(segment => segment === 'claude-code' || segment === 'copilot-cli');

    if (engineIndex === -1) {
        return { role: path.basename(roleArg) };
    }

    const role = segments.slice(0, engineIndex).join('_') || path.basename(roleArg);
    const engine = segments[engineIndex];
    const model = segments.slice(engineIndex + 1).join('_');
    return { role, engine, model };
}

function getAdapterForEngine(engine: string, sessionId?: string, model?: string): AgentAdapter {
    if (engine === 'copilot-cli') {
        return new GitHubCopilotAdapter(sessionId, '🛸 GitHub Copilot', model);
    }
    return new ClaudeCodeAdapter(sessionId, '🦖 Claude Code', model);
}

/**
 * Executes a single task delegation synchronously.
 */
export async function delegateTaskSingle(roleArg: string, taskPath: string, outputPath: string, _fallbackSessionId: string, workspacePath: string): Promise<string> {
    const parsedRole = parseRoleSpec(roleArg);
    const role = parsedRole.role;
    
    // Auto-migrate legacy folder `.optimus/personas` to `.optimus/agents`
    const legacyT1Dir = path.join(workspacePath, '.optimus', 'personas');
    const t1Dir = path.join(workspacePath, '.optimus', 'agents');
    if (fs.existsSync(legacyT1Dir) && !fs.existsSync(t1Dir)) {
        try { fs.renameSync(legacyT1Dir, t1Dir); } catch(e) {}
    }
    
    const t1Path = path.join(t1Dir, `${role}.md`);
    const t2Path = path.join(__dirname, '..', '..', 'optimus-plugin', 'roles', `${role}.md`);

    let activeEngine = parsedRole.engine || 'claude-code';
    let activeModel = parsedRole.model;
    let activeSessionId: string | undefined = undefined;

    let t1Content = '';
    let shouldLocalize = false;
    let resolvedTier = 'T3 (Zero-Shot Outsource)';
    let personaProof = 'No dedicated role template found in T2 or T1. Using T3 generic prompt.';

    if (fs.existsSync(t1Path)) {
        t1Content = fs.readFileSync(t1Path, 'utf8');
        resolvedTier = `T1 (Agent Instance -> ${role}.md)`;
        personaProof = `Found local project agent state: ${t1Path}`;
    } else if (fs.existsSync(t2Path)) {
        t1Content = fs.readFileSync(t2Path, 'utf8');
        shouldLocalize = true;
        resolvedTier = `T2 (Role Template -> ${role}.md)`;
        personaProof = `Found globally promoted Role template: ${t2Path}`;
    }

    if (t1Content) {
        const fm = parseFrontmatter(t1Content);
        if (fm.frontmatter.engine) activeEngine = fm.frontmatter.engine;
        if (fm.frontmatter.session_id) activeSessionId = fm.frontmatter.session_id;
        if (fm.frontmatter.model) activeModel = fm.frontmatter.model;
    }

    const adapter = getAdapterForEngine(activeEngine, activeSessionId, activeModel);

    console.error(`[Orchestrator] Resolving Identity for ${role}...`);
    console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);
    console.error(`[Orchestrator] Engine: ${activeEngine}, Session: ${activeSessionId || 'New/Ephemeral'}`);

    if (shouldLocalize) {
      if (!fs.existsSync(t1Dir)) fs.mkdirSync(t1Dir, { recursive: true });
      try {
        const t2ContentText = fs.readFileSync(t2Path, 'utf8');
        const fd = fs.openSync(t1Path, 'wx');
        const defaultMemory = `\n\n## Project Memory\n*Agent T1 Instantiated on ${new Date().toISOString()}*\n- (No memory appended yet)\n`;
        fs.writeFileSync(fd, t2ContentText + defaultMemory, 'utf8');
        fs.closeSync(fd);
        console.error(`[Orchestrator] Promoted T2 to T1: ${t1Path}`);
      } catch (e: any) {
        if (e.code === 'EEXIST') {
          console.error(`[Orchestrator] T1 promotion skipped (already done by another worker).`);
        } else {
          console.error(`[Orchestrator] T1 promotion failed:`, e);
          resolvedTier += ' [T1 promotion failed]';
        }
      }
    }

    const taskText = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : taskPath;

    let personaContext = "";
    if (t1Content) {
        personaContext = parseFrontmatter(t1Content).body.trim();
    } else if (fs.existsSync(t1Path)) {
        // In case it was localized by another concurrent thread
        const concurrentContent = fs.readFileSync(t1Path, 'utf8');
        personaContext = parseFrontmatter(concurrentContent).body.trim();
    }

    const basePrompt = `You are a delegated AI Worker operating under the Spartan Swarm Protocol.
Your Role: ${role}
Identity: ${resolvedTier}

${personaContext ? `--- START PERSONA INSTRUCTIONS ---\n${personaContext}\n--- END PERSONA INSTRUCTIONS ---` : ''}

Goal: Execute the following task. 
System Note: ${personaProof}

Task Description:
${taskText}

Please provide your complete execution result below.`;

    try {
        const response = await adapter.invoke(basePrompt, 'agent');
        
        // --- Core Protocol: Native Session Capture & Binding ---
        if (adapter.lastSessionId && fs.existsSync(t1Path)) {
            const currentStr = fs.readFileSync(t1Path, 'utf8');
            const updated = updateFrontmatter(currentStr, {
                engine: activeEngine,
                session_id: adapter.lastSessionId
            });
            fs.writeFileSync(t1Path, updated, 'utf8');
            console.error(`[Orchestrator] Captured native session ID '${adapter.lastSessionId}' to ${t1Path}`);
        }

        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(outputPath, response, 'utf8');
        return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**Engine**: ${activeEngine}\n**Session ID**: ${adapter.lastSessionId || 'Ephemeral'}\n\n**System Note**: ${personaProof}\n\nAgent has finished execution. Check standard output at \`${outputPath}\`.`;
    } catch (e: any) {
        throw new Error(`Worker execution failed: ${e.message}`);
    }
}

/**
 * Spawns a single expert worker process for council review.
 */
export async function spawnWorker(role: string, proposalPath: string, outputPath: string, sessionId: string, workspacePath: string): Promise<string> {
    try {
        console.error(`[Spawner] Launching Real Worker ${role} for council review`);
        return await delegateTaskSingle(role, `Please read the architectural PROPOSAL located at: ${proposalPath}. 
Provide your expert critique from the perspective of your role (${role}). Identify architectural bottlenecks, DX friction, security risks, or asynchronous race conditions. Conclude with a recommendation: Reject, Accept, or Hybrid.`, outputPath, sessionId, workspacePath);
    } catch (err: any) {
        console.error(`[Spawner] Worker ${role} failed to start:`, err);
        return `❌ ${role}: exited with errors (${err.message}).`;
    }
}

/**
 * Dispatches the council of experts concurrently.
 */
export async function dispatchCouncilConcurrent(roles: string[], proposalPath: string, reviewsPath: string, timestampId: string, workspacePath: string): Promise<string[]> {
  const promises = roles.map(role => {
    const outputPath = path.join(reviewsPath, `${role}_review.md`);
    return spawnWorker(role, proposalPath, outputPath, `${timestampId}_${Math.random().toString(36).slice(2,8)}`, workspacePath);
  });

  return Promise.all(promises);
}
