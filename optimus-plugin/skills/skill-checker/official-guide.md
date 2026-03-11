# Official Claude Skill Creator Guide

> Auto-fetched from https://claude.com/plugins/skill-creator on 2026-03-11.
> This file is regenerated on each build. Do not edit manually.

Skill Creator
Create, improve, and measure skills. Use for creating, updating, evaluating, and benchmarking performance.

Anthropic Verified

Install in
Claude Code

Made by
Anthropic

Installs
19066

Play videoPlay video

Skill Creator is a comprehensive toolkit for developing, testing, and iterating on Claude Code skills. It provides four operating modes — Create, Eval, Improve, and Benchmark — that guide you through the full skill development lifecycle, from initial concept to optimized, production-ready skills.

Under the hood, four composable agents handle specialized tasks: an Executor that runs skills against eval prompts, a Grader that evaluates outputs against defined expectations, a Comparator that performs blind A/B comparisons between skill versions, and an Analyzer that suggests targeted improvements based on results. Together, these agents enable rigorous, data-driven skill refinement.

The plugin also includes utility scripts for initializing skills, validating configurations, preparing evaluations, and aggregating benchmark results with variance analysis — so you can measure performance with statistical confidence.

How to use: Invoke the skill with /skill-creator and choose a mode. Try prompts like: "Create a new skill that reviews PRs for security issues," "Run evals on my code-review skill," "Improve my deploy skill based on these test cases," or "Benchmark my skill across 10 runs and show variance." The interactive workflow will guide you through requirements gathering, test case creation, and iterative optimization.
