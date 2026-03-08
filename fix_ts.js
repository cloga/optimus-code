const fs = require("fs");
const file = "src/extension.ts";
let code = fs.readFileSync(file, "utf8");
code = code.replace("options.toolInvocationToken?.toString()", "String(options.toolInvocationToken)");
fs.writeFileSync(file, code);
