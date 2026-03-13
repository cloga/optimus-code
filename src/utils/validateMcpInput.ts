import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadValidEnginesAndModels, isValidEngine, isValidModel } from "../mcp/worker-spawner";

const MODEL_NAME_PATTERN = /^(claude|gemini|gpt|o1|llama|mistral)-/i;

export function looksLikeModelName(name: string): boolean {
    return MODEL_NAME_PATTERN.test(name);
}

export function validateEngineAndModel(
    engine: string | undefined,
    model: string | undefined,
    workspacePath: string
): void {
    if (!engine && !model) return;

    const { engines: validEngines, models: validModels } = loadValidEnginesAndModels(workspacePath);

    if (engine && !isValidEngine(engine, validEngines)) {
        const hint = validEngines.length > 0
            ? `Valid engines: ${validEngines.join(', ')}. Remove role_engine to use the default.`
            : 'No engines configured in available-agents.json.';
        throw new McpError(ErrorCode.InvalidParams, `Invalid engine '${engine}'. ${hint}`);
    }

    if (model && engine && !isValidModel(model, engine, validModels)) {
        const allowed = validModels[engine] || [];
        const hint = allowed.length > 0
            ? `Valid models for engine '${engine}': ${allowed.join(', ')}. Remove role_model to use the default.`
            : `No models configured for engine '${engine}' in available-agents.json.`;
        throw new McpError(ErrorCode.InvalidParams, `Invalid model '${model}' for engine '${engine}'. ${hint}`);
    }
}

export function validateRoleNotModelName(role: string): void {
    if (looksLikeModelName(role)) {
        throw new McpError(
            ErrorCode.InvalidParams,
            `Role '${role}' looks like a model name, not a role name. ` +
            `Use role names like 'senior-dev' or 'security-auditor'. ` +
            `To specify a model, use the role_model parameter instead.`
        );
    }
}
