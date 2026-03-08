const fs = require("fs");
const file = "src/providers/ChatViewProvider.ts";
let code = fs.readFileSync(file, "utf8");

code = code.replace(
    /const executorOutcome = \{[\s\S]*?\};/,
    `const executorOutcome = this._buildExecutorOutcomeRecord(results[0].adapter, combinedText, hasErrors ? "error" : "success");`
);

fs.writeFileSync(file, code);
