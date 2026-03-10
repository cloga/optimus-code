import fs from "fs";
import path from "path";
import { GitHubCopilotAdapter } from "../adapters/GitHubCopilotAdapter";

/**
 * Executes a single task delegation synchronously.
 */
export async function delegateTaskSingle(role: string, taskPath: string, outputPath: string, sessionId: string, workspacePath: string): Promise<string> {
    const t1Path = path.join(workspacePath, '.optimus', 'personas', `${role}.md`);
    const t2Path = path.join(__dirname, '..', '..', 'optimus-plugin', 'agents', `${role}.md`);

    let resolvedTier = 'T3 (Zero-Shot Outsource)';
    let personaProof = 'No dedicated persona file found. Using generic specialized prompt.';
    let shouldLocalize = false;

    if (fs.existsSync(t1Path)) {
      resolvedTier = `T1 (Local Project Expert -> ${role}.md)`;
      personaProof = `Found local project override: ${t1Path}`;
    } else if (fs.existsSync(t2Path)) {
      resolvedTier = `T2 (Global Spartan Regular -> ${role}.md)`;
      personaProof = `Found globally promoted plugin rules: ${t2Path}`;
      shouldLocalize = true;
    }

    console.error(`[Orchestrator] Resolving Identity for ${role}...`);
    console.error(`[Orchestrator] Selected Stratum: ${resolvedTier}`);

    if (shouldLocalize) {
      const t1Dir = path.dirname(t1Path);
      if (!fs.existsSync(t1Dir)) fs.mkdirSync(t1Dir, { recursive: true });
      try {
        fs.writeFileSync(t1Path, fs.readFileSync(t2Path, 'utf8'));
      } catch (e) {
        // ignore if not found
      }
    }

    const adapter = new GitHubCopilotAdapter(sessionId);

    const taskText = fs.existsSync(taskPath) ? fs.readFileSync(taskPath, 'utf8') : taskPath;

    let personaContext = "";
    if (fs.existsSync(t1Path)) {
        personaContext = fs.readFileSync(t1Path, "utf8");
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
        const response = await adapter.invoke(basePrompt, "Exec" as any);
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(outputPath, response, 'utf8');
        return `✅ **Task Delegation Successful**\n\n**Agent Identity Resolved**: ${resolvedTier}\n**System Note**: ${personaProof}\n\nAgent has finished execution. Check standard output at \`${outputPath}\`.`;
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
