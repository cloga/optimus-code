const fs = require("fs");
let p = fs.readFileSync("src/providers/ChatViewProvider.ts", "utf8");
p = p.replace(`invoke(prompt, "pm"`, `invoke(prompt, "plan"`); // "plan" is the PM mode in AgentAdapter
fs.writeFileSync("src/providers/ChatViewProvider.ts", p);

