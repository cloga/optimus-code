const fs = require('fs');
const lines = fs.readFileSync('src/providers/ChatViewProvider.ts', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('imageNote =') && lines[i].includes('storedAttachments.map')) {
        lines[i] = "            imageNote = '\\n\\n[Attached images]\\n' + storedAttachments.map(image => '- ' + image.filePath).join('\\n') + '\\n';";
    }
    if (lines[i].includes('resultText =') && lines[i].includes('**Error:**')) {
        lines[i] = '                    resultText = **Error:** \;';
    }
    if (lines[i].includes('resultText +=') && lines[i].includes('Stopped by User')) {
        lines[i] = '                    resultText += \\n\\n**[Stopped by User: \]**;';
    }
}

fs.writeFileSync('src/providers/ChatViewProvider.ts', lines.join('\n'));
