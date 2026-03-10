/**
 * Standalone esbuild config for the Optimus MCP Plugin
 * Compiles src/mcp/mcp-server.ts → optimus-plugin/dist/mcp-server.js
 * 
 * This build is completely independent from the VS Code extension build.
 * It produces a single self-contained CJS bundle with zero vscode dependencies.
 */
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '..', 'src', 'mcp', 'mcp-server.ts')],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: path.resolve(__dirname, 'dist', 'mcp-server.js'),
    // CRITICAL: vscode must NEVER be bundled — it should not even be imported
    // If it appears, the build should fail, not silently externalize it
    external: [],
    logLevel: 'info',
    metafile: true,
    tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'),
  });

  // Analyze the bundle for any accidental vscode imports
  const inputs = Object.keys(result.metafile.inputs);
  const vscodeDeps = inputs.filter(f => f.includes('vscode') || f.includes('@vscode'));
  if (vscodeDeps.length > 0) {
    console.error('\n🚨 FATAL: VS Code dependencies detected in MCP bundle!');
    console.error('Offending files:', vscodeDeps);
    console.error('The standalone MCP plugin MUST NOT depend on vscode.');
    process.exit(1);
  }

  const outputSize = Object.values(result.metafile.outputs)[0]?.bytes || 0;
  console.log(`\n✅ Plugin build complete (${(outputSize / 1024).toFixed(1)} KB)`);
  if (production) {
    console.log('   Mode: production (minified)');
  }
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
