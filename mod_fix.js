const fs = require('fs');
let content = fs.readFileSync('src/providers/ChatViewProvider.ts', 'utf8');

// fix lines
content = content.replace(/imageNote = '[\\s\\S]*?\\.join\\('\\\\n'\\) \+ '\\\\n';/g, "imageNote = '\\n\\n[Attached images]\\n' + storedAttachments.map(image => '- ' + image.filePath).join('\\n') + '\\n';");

content = content.replace(/resultText = \\\*\*Error:\*\* \\\\;/g, "resultText = \**Error:** \\;");

content = content.replace(/resultText \+= \\\\n\\\\n\*\*\[Stopped by User: \\\]\*\*\\;/g, "resultText += \\\n\\n**[Stopped by User: \]**\;");

fs.writeFileSync('src/providers/ChatViewProvider.ts', content);
