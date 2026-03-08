const fs = require('fs');
const lines = fs.readFileSync('src/providers/ChatViewProvider.ts', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('resultText =') && lines[i].includes('**Error:**')) {
        lines[i] = "                    resultText = '**Error:** ' + (err.message || String(err));";
    }
    if (lines[i].includes('resultText +=') && lines[i].includes('Stopped by User')) {
        lines[i] = "                    resultText += '\\n\\n**[Stopped by User: ' + this._activeStopReason + ']**';";
    }
}

fs.writeFileSync('src/providers/ChatViewProvider.ts', lines.join('\n'));
