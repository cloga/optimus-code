const fs = require("fs");
let raw = fs.readFileSync("package.json", "utf8");
let pkg = JSON.parse(raw);
let tools = pkg.contributes.languageModelTools;
for (let t of tools) {
  t.name = t.name.replace(".", "-");
}
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("Fixed invalid tool IDs in package.json.");

