import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    const transport = new StdioClientTransport({
        command: "node",
        args: ["out/mcp/optimus-agents.js"]
    });

    const client = new Client({
        name: "test-client",
        version: "1.0.0"
    }, {
        capabilities: {}
    });

    await client.connect(transport);

    console.log("Connected to MCP server. Calling delegate_task with copilot...");
    
    try {
        const result = await client.callTool({
            name: "delegate_task",
            arguments: {
                engine: "copilot_cli",
                model: "claude-opus-4.6-1m",
                instruction: "Can you analyze chatView.js and explain why the model dropdown might be empty? Use any local search or file read tools you need. Take multiple steps if necessary.",
                role_prompt: "dev",
            }
        });
        
        console.log("Task finished. Result:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error executing task:", e);
    } finally {
        await client.close();
        process.exit(0);
    }
}

main().catch(console.error);