import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    renderSkillTemplate,
    buildSkillContext,
    hasTemplateSyntax,
    SkillContext,
} from '../skills/SkillTemplateEngine.js';

const baseContext: SkillContext = {
    role: 'backend-dev',
    engine: 'claude-code',
    model: 'claude-opus-4.6',
    platform: 'win32',
    workspacePath: '/home/user/project',
};

describe('SkillTemplateEngine', () => {
    describe('hasTemplateSyntax', () => {
        it('returns false for static content', () => {
            expect(hasTemplateSyntax('# My Skill\nJust plain text.')).toBe(false);
        });

        it('returns true for variable syntax', () => {
            expect(hasTemplateSyntax('Role: {{role}}')).toBe(true);
        });

        it('returns true for conditional syntax', () => {
            expect(hasTemplateSyntax('{% if engine == "x" %}y{% endif %}')).toBe(true);
        });
    });

    describe('variable substitution', () => {
        it('replaces known variables', () => {
            const result = renderSkillTemplate('Role: {{role}}, Engine: {{engine}}', baseContext);
            expect(result).toBe('Role: backend-dev, Engine: claude-code');
        });

        it('replaces model and platform', () => {
            const result = renderSkillTemplate('{{model}} on {{platform}}', baseContext);
            expect(result).toBe('claude-opus-4.6 on win32');
        });

        it('leaves unknown variables as-is', () => {
            const result = renderSkillTemplate('{{unknown_var}} stays', baseContext);
            expect(result).toBe('{{unknown_var}} stays');
        });

        it('handles variables with spaces around name', () => {
            const result = renderSkillTemplate('{{ role }}', baseContext);
            expect(result).toBe('backend-dev');
        });
    });

    describe('conditionals', () => {
        it('includes content when condition is true', () => {
            const template = '{% if engine == "claude-code" %}Claude mode{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('Claude mode');
        });

        it('excludes content when condition is false', () => {
            const template = '{% if engine == "copilot" %}Copilot mode{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('');
        });

        it('handles if/else with true condition', () => {
            const template = '{% if platform == "win32" %}Windows{% else %}Unix{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('Windows');
        });

        it('handles if/else with false condition', () => {
            const template = '{% if platform == "linux" %}Linux{% else %}Other{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('Other');
        });

        it('handles != operator', () => {
            const template = '{% if engine != "copilot" %}Not Copilot{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('Not Copilot');
        });

        it('handles nested conditionals', () => {
            const template = '{% if engine == "claude-code" %}A{% if platform == "win32" %}B{% endif %}C{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('ABC');
        });
    });

    describe('include directive', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimus-skill-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('includes file content', () => {
            fs.writeFileSync(path.join(tmpDir, 'extra.md'), 'Included content');
            const template = 'Before {% include "extra.md" %} After';
            const result = renderSkillTemplate(template, baseContext, tmpDir);
            expect(result).toBe('Before Included content After');
        });

        it('shows comment for missing files', () => {
            const template = '{% include "missing.md" %}';
            const result = renderSkillTemplate(template, baseContext, tmpDir);
            expect(result).toContain('Include not found');
        });

        it('rejects paths that escape skill directory', () => {
            const template = '{% include "../../etc/passwd" %}';
            const result = renderSkillTemplate(template, baseContext, tmpDir);
            expect(result).toContain('rejected');
        });
    });

    describe('static passthrough', () => {
        it('returns static content unchanged', () => {
            const content = '# My Skill\n\nThis is a static skill with no templates.';
            const result = renderSkillTemplate(content, baseContext);
            expect(result).toBe(content);
        });

        it('handles empty content', () => {
            expect(renderSkillTemplate('', baseContext)).toBe('');
        });
    });

    describe('buildSkillContext', () => {
        it('builds context with all required fields', () => {
            const ctx = buildSkillContext('dev', 'claude-code', 'opus', '/workspace');
            expect(ctx.role).toBe('dev');
            expect(ctx.engine).toBe('claude-code');
            expect(ctx.model).toBe('opus');
            expect(ctx.workspacePath).toBe('/workspace');
            expect(ctx.platform).toBeTruthy();
        });

        it('accepts extras', () => {
            const ctx = buildSkillContext('dev', 'cc', 'opus', '/ws', { custom: 'value' });
            expect(ctx.custom).toBe('value');
        });
    });

    describe('combined template', () => {
        it('processes variables inside conditionals', () => {
            const template = '{% if engine == "claude-code" %}Using {{model}} on {{platform}}{% endif %}';
            const result = renderSkillTemplate(template, baseContext);
            expect(result).toBe('Using claude-opus-4.6 on win32');
        });
    });
});
