const fs = require("fs");
let p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.contributes.languageModelTools = [
  {
    "name": "optimus-claudeWorkerOpus", "displayName": "claudeWorkerOpus", "tags": ["code"],
    "modelDescription": "Call Claude Code (Opus 4.6 1M model) to execute multi-step engineering tasks safely with shell/workspace context.",
    "inputSchema": { "type": "object", "properties": { "instruction": { "type": "string" } }, "required": ["instruction"] }
  }
];
fs.writeFileSync("package.json", JSON.stringify(p, null, 2));

