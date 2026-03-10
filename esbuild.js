const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
	// Build VS Code Extension
	const extCtx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'out/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* @type {import('esbuild').Plugin} */
			{
				name: 'esbuild-problem-matcher',
				setup(build) {
					build.onStart(() => {
						console.log('[watch] extension build started');
					});
					build.onEnd((result) => {
						result.errors.forEach(({ text, location }) => {
							console.error(`✘ [ERROR] ${text}`);
							console.error(`    ${location.file}:${location.line}:${location.column}:`);
						});
						console.log('[watch] extension build finished');
					});
				},
			},
		],
	});

	// Build MCP CLI Server
	const mcpCtx = await esbuild.context({
		entryPoints: ['src/mcp/mcp-server.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'out/mcp-server.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [
			/* @type {import('esbuild').Plugin} */
			{
				name: 'esbuild-problem-matcher',
				setup(build) {
					build.onStart(() => {
						console.log('[watch] mcp-server build started');
					});
					build.onEnd((result) => {
						result.errors.forEach(({ text, location }) => {
							console.error(`✘ [ERROR] ${text}`);
							console.error(`    ${location.file}:${location.line}:${location.column}:`);
						});
						console.log('[watch] mcp-server build finished');
					});
				},
			},
		],
	});

	if (watch) {
		await Promise.all([extCtx.watch(), mcpCtx.watch()]);
	} else {
		await Promise.all([extCtx.rebuild(), mcpCtx.rebuild()]);
		await extCtx.dispose();
		await mcpCtx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
