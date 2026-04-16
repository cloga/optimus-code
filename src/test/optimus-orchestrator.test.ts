import { describe, expect, it } from 'vitest';
import { buildOptimusDispatchPlan, renderOptimusSummary } from '../mcp/optimus-orchestrator';

const WORKSPACE = process.cwd();

describe('optimus orchestrator planner', () => {
    it('uses a single delegate for focused implementation work', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Fix the Windows stderr fd handling in council-runner.',
            outputPath: '.optimus/results/optimus-summary.md',
        });

        expect(plan.strategy).toBe('delegate');
        expect(plan.delegateSpec?.role).toBe('dev');
        expect(plan.delegateSpec?.output_path).toContain('optimus-summary__delegate.md');
    });

    it('prefers council for analysis-heavy tasks without direct implementation', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Investigate the architecture trade-offs for a optimus-like orchestration entry point and recommend a direction.',
            outputPath: '.optimus/results/optimus-analysis.md',
        });

        expect(plan.strategy).toBe('council');
        expect(plan.councilSpec?.roles.length).toBeGreaterThanOrEqual(2);
        expect(plan.councilSpec?.proposalPath).toContain('optimus-analysis__problem.md');
    });

    it('builds a dependency-aware plan for mixed implementation and verification work', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Implement the runtime proxy guard, update the docs, and add regression tests.',
            outputPath: '.optimus/results/runtime-optimus.md',
        });

        expect(plan.strategy).toBe('plan');
        expect(plan.planSpec?.items.map(item => item.id)).toEqual(['implement', 'verify']);
        expect(plan.planSpec?.items[1].depends_on).toEqual(['implement']);
    });

    it('adds a design lane when plan work also needs research or design', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Research the runtime dispatch design, then implement the chosen approach and verify regressions are covered.',
            outputPath: '.optimus/results/runtime-plan.md',
        });

        expect(plan.strategy).toBe('plan');
        expect(plan.planSpec?.items.map(item => item.id)).toEqual(['design', 'implement', 'verify']);
        expect(plan.planSpec?.items[1].depends_on).toEqual(['design']);
    });

    it('honors explicit mode hints', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Investigate orchestration options.',
            outputPath: '.optimus/results/optimus-mode.md',
            modeHint: 'delegate',
        });

        expect(plan.strategy).toBe('delegate');
        expect(plan.rationale[0]).toContain("forced 'delegate'");
    });

    it('renders a summary artifact with item mappings', () => {
        const plan = buildOptimusDispatchPlan({
            workspacePath: WORKSPACE,
            taskDescription: 'Implement and test the optimus orchestrator.',
            outputPath: '.optimus/results/optimus-summary.md',
        });
        const content = renderOptimusSummary(plan, 'Implement and test the optimus orchestrator.', {
            parentIssueNumber: 582,
            taskIds: ['plan_123__implement', 'plan_123__verify'],
            itemTaskIds: { implement: 'plan_123__implement', verify: 'plan_123__verify' },
        });

        expect(content).toContain('strategy: plan');
        expect(content).toContain('parent_issue: 582');
        expect(content).toContain('implement -> plan_123__implement');
    });
});