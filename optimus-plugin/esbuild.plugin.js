/**
 * Standalone esbuild config for the Optimus MCP Plugin
 * Compiles src/mcp/mcp-server.ts → optimus-plugin/dist/mcp-server.js
 *
 * This build is completely independent from the VS Code extension build.
 * It produces a single self-contained CJS bundle with zero vscode dependencies.
 */
const esbuild = require('esbuild');
const { execSync } = require('child_process');
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
    // All dependencies are fully bundled — esbuild transpiles ESM→CJS at build time.
    // vscode guard is enforced via metafile analysis below (not via external).
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

  // Post-build validation: top-10 largest bundled inputs (detect unexpected transitive deps)
  const inputEntries = Object.entries(result.metafile.inputs)
    .map(([file, meta]) => ({ file, bytes: meta.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
  console.log('\n📦 Top 10 largest bundled inputs:');
  for (const entry of inputEntries) {
    console.log(`   ${(entry.bytes / 1024).toFixed(1).padStart(7)} KB  ${entry.file}`);
  }

  // Post-build validation: verify the bundle can be require()'d without ERR_REQUIRE_ESM.
  // Uses a subprocess with timeout because require() on mcp-server.js starts the MCP
  // server (StdioServerTransport, cron engine, etc.) and hangs the build process.
  // A timeout kill means the module loaded successfully — only non-timeout errors matter.
  const outfile = path.resolve(__dirname, 'dist', 'mcp-server.js');
  try {
    execSync(`node -e "require('${outfile.replace(/\\/g, '\\\\')}')"`, {
      timeout: 5000,
      stdio: 'pipe',
    });
    console.log('\n✅ Post-build require() check passed');
  } catch (err) {
    // Timeout (ETIMEDOUT) means the server started successfully — that's a pass.
    if (err.killed || (err.signal && err.signal === 'SIGTERM')) {
      console.log('\n✅ Post-build require() check passed (server started, killed after timeout)');
    } else {
      const stderr = err.stderr ? err.stderr.toString() : '';
      console.error(`\n🚨 FATAL: Bundle failed require() check: ${stderr || err.message}`);
      process.exit(1);
    }
  }
}

build().catch((e) => {
  console.error('Build failed:', e);
  process.exit(1);
});
