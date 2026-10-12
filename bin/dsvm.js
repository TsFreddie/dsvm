#!/usr/bin/env node
// Stable launcher shim: the installed service unit always points here, so it
// never has to be rewritten when dsvm itself or the active dsh version changes.
let cli;
try {
  cli = await import('../build/src/cli.js');
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`dsvm: build output is missing or broken (${message}); run \`npm run build\`\n`);
  process.exit(1);
}

try {
  await cli.main(process.argv.slice(2));
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`dsvm: ${message}\n`);
  process.exitCode = 1;
}
