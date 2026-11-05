// Entry point for the packaged exe (and `node main.js` from the repo).
//   no arguments: the supervisor, which runs and restarts the game server (lib/supervisor.js)
//   --serve:      the game server itself, as run by the supervisor (lib/child.js)
//   --version:    print the version and exit (the control window uses it to spot a half-finished install)
// It calls these explicitly rather than relying on require.main, which a single executable sets differently.
if (process.argv.includes('--version')) console.log(require('./package.json').version);
else if (process.argv.includes('--serve')) require('./lib/child.js').run();
else require('./lib/supervisor.js').run({ watch: !require('./lib/paths.js').packaged });
