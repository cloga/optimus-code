import * as fs from 'fs';
import * as path from 'path';
import { TaskManifestManager } from '../managers/TaskManifestManager';

/**
 * Synthesize findings from a completed research task.
 * Reads the task output, generates a structured synthesis, and stores it in the manifest.
 * 
 * The synthesis is a concise distillation of research findings that dependent
 * implementation tasks can use as context — ensuring no understanding is lost
 * in agent handoffs (the "Coordinator Synthesis Gate" pattern).
 */
export async function synthesizeFindings(
    workspacePath: string,
    taskId: string,
    options?: {
        maxOutputChars?: number;
    }
): Promise<string> {
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    
    if (!task) {
        throw new Error(`Task ${taskId} not found in manifest`);
    }
    
    if (!task.synthesis_required) {
        throw new Error(`Task ${taskId} does not require synthesis`);
    }
    
    if (task.synthesized_findings) {
        return task.synthesized_findings;  // Already synthesized
    }
    
    // Read the task output
    const outputPath = task.output_path;
    if (!outputPath) {
        throw new Error(`Task ${taskId} has no output_path`);
    }
    
    const fullOutputPath = path.isAbsolute(outputPath) 
        ? outputPath 
        : path.resolve(workspacePath, outputPath);
    
    let output: string;
    try {
        output = fs.readFileSync(fullOutputPath, 'utf8');
    } catch (err) {
        throw new Error(`Cannot read output for task ${taskId} at ${fullOutputPath}: ${err}`);
    }
    
    const maxChars = options?.maxOutputChars ?? 15000;
    const truncatedOutput = output.length > maxChars 
        ? output.slice(0, maxChars) + '\n\n[... truncated ...]' 
        : output;
    
    // Generate synthesis using a structured extraction approach
    // Instead of delegating to another LLM (which would require engine availability),
    // we extract a structured summary from the output
    const findings = extractKeyFindings(truncatedOutput, task.role || 'unknown');
    
    // Store in manifest
    TaskManifestManager.markSynthesized(workspacePath, taskId, findings);
    
    return findings;
}

/**
 * Extract key findings from research output using heuristic analysis.
 * This provides a lightweight synthesis without requiring an LLM call.
 * 
 * The extracted findings are structured for injection into dependent task prompts.
 */
function extractKeyFindings(output: string, role: string): string {
    const lines = output.split('\n');
    const sections: string[] = [];
    
    // Extract headings and their first paragraph
    const headingPattern = /^#{1,3}\s+(.+)/;
    const bulletPattern = /^[\s]*[-*•]\s+(.+)/;
    const keyPatterns = [
        /\b(key\s+finding|conclusion|recommendation|takeaway|insight|result|summary)\b/i,
        /\b(important|critical|notable|significant)\b/i,
    ];
    
    // Collect heading structure
    const headings: string[] = [];
    for (const line of lines) {
        const match = line.match(headingPattern);
        if (match) headings.push(match[1].trim());
    }
    
    // Collect key bullet points (lines matching key patterns)
    const keyBullets: string[] = [];
    for (const line of lines) {
        const bulletMatch = line.match(bulletPattern);
        if (bulletMatch) {
            const text = bulletMatch[1];
            if (keyPatterns.some(p => p.test(text))) {
                keyBullets.push(text.trim());
            }
        }
    }
    
    // Collect conclusion/summary sections
    let inConclusionSection = false;
    const conclusionLines: string[] = [];
    for (const line of lines) {
        if (/^#{1,3}\s+(summary|conclusion|key\s+findings|takeaways|recommendations)/i.test(line)) {
            inConclusionSection = true;
            continue;
        }
        if (inConclusionSection) {
            if (/^#{1,3}\s+/.test(line) && !/^#{1,3}\s+(summary|conclusion)/i.test(line)) {
                inConclusionSection = false;
                continue;
            }
            if (line.trim()) conclusionLines.push(line);
        }
    }
    
    // Build synthesis
    sections.push(`## Synthesized Findings from ${role}`);
    sections.push('');
    
    if (headings.length > 0) {
        sections.push('### Document Structure');
        sections.push(headings.map(h => `- ${h}`).join('\n'));
        sections.push('');
    }
    
    if (conclusionLines.length > 0) {
        sections.push('### Key Conclusions');
        sections.push(conclusionLines.join('\n'));
        sections.push('');
    }
    
    if (keyBullets.length > 0) {
        sections.push('### Notable Points');
        sections.push(keyBullets.map(b => `- ${b}`).join('\n'));
        sections.push('');
    }
    
    // If very little was extracted, fall back to first N lines of output
    if (conclusionLines.length === 0 && keyBullets.length === 0) {
        const fallbackLines = lines.filter(l => l.trim().length > 0).slice(0, 30);
        sections.push('### Output Summary (first 30 non-empty lines)');
        sections.push(fallbackLines.join('\n'));
    }
    
    sections.push('');
    sections.push(`*Synthesized at ${new Date().toISOString()}*`);
    
    return sections.join('\n');
}

/**
 * Check if a task needs synthesis and perform it if so.
 * Returns true if synthesis was performed, false if not needed.
 */
export async function synthesizeIfRequired(
    workspacePath: string,
    taskId: string
): Promise<boolean> {
    if (!TaskManifestManager.isSynthesisRequired(workspacePath, taskId)) {
        return false;
    }
    await synthesizeFindings(workspacePath, taskId);
    return true;
}

/**
 * Inject synthesized findings from predecessor tasks into a dependent task's context.
 * Writes a synthesis context file and appends it to the task's context_files list.
 * 
 * This is the "context injection" half of the Coordinator Synthesis Gate:
 * predecessor synthesis → context file → dependent task prompt.
 */
export function injectSynthesisContext(workspacePath: string, taskId: string): void {
    const manifest = TaskManifestManager.loadManifest(workspacePath);
    const task = manifest[taskId];
    if (!task || !task.depends_on || task.depends_on.length === 0) return;

    const synthesisParts: string[] = [];
    for (const depId of task.depends_on) {
        const findings = TaskManifestManager.getSynthesizedFindings(workspacePath, depId);
        if (findings) {
            synthesisParts.push(findings);
        }
    }
    if (synthesisParts.length === 0) return;

    const synthesisContext = [
        '# Context from Prior Research',
        '',
        'The following synthesized findings were produced by predecessor research tasks.',
        'Use them as context for your implementation work.',
        '',
        '---',
        '',
        synthesisParts.join('\n\n---\n\n'),
        '',
        '---',
    ].join('\n');

    // Write to a context file under .optimus/results/
    const resultsDir = path.resolve(workspacePath, '.optimus', 'results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const synthesisFilePath = path.resolve(resultsDir, `${taskId}_synthesis_context.md`);
    fs.writeFileSync(synthesisFilePath, synthesisContext, 'utf8');

    // Append to context_files so the worker picks it up when building its prompt
    const existingFiles = task.context_files || [];
    const relativePath = path.relative(workspacePath, synthesisFilePath);
    if (!existingFiles.includes(relativePath)) {
        TaskManifestManager.updateTask(workspacePath, taskId, {
            context_files: [...existingFiles, relativePath],
        });
    }
    console.error(`[Synthesis] Injected synthesis context for ${taskId} from ${synthesisParts.length} predecessor(s)`);
}
