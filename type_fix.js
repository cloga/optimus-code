const fs = require("fs");
let code = fs.readFileSync("src/providers/ChatViewProvider.ts", "utf8");
code = code.replace(/await activeAdapter\.invoke\(combinedPrompt \+ sysPrompt, "plan"/g, `await (activeAdapter as GitHubCopilotAdapter).invoke(combinedPrompt + sysPrompt, "plan"`);
code = code.replace(/await activeAdapter\.invoke\(combinedPrompt \+ sysPrompt, "agent"/g, `await (activeAdapter as ClaudeCodeAdapter).invoke(combinedPrompt + sysPrompt, "agent"`);
fs.writeFileSync("src/providers/ChatViewProvider.ts", code);

