// The game server as run by the supervisor (`main.js --serve`). The supervisor owns stopping:
// - {stop: true} over IPC: stop taking actions, wait for every save, reply {stopped, saved, error}, exit 0.
// - The IPC channel closing means the supervisor died (on Windows a killed parent doesn't take its children
//   with it): save and exit the same way, so port 7777 is freed.
// Exit codes: 0 stopped on purpose, 2 couldn't start (port taken, data folder not writable), anything else a crash.
const { start } = require('../server.js');

function run() {
  const send = (msg, cb) => {
    if (process.connected) process.send(msg, () => cb && cb());
    else if (cb) cb();
  };

  start().then(game => {
    send({ listening: true, port: game.port });
    let stopping = null;
    const stop = why => {
      if (stopping) return stopping;
      console.log(`Stopping (${why})...`);
      stopping = game.close().then(r => {
        console.log(r.saved ? 'Everything saved. Stopped.' : `Stopped, but the last save failed: ${r.error}`);
        send({ stopped: true, saved: r.saved, error: r.error }, () => process.exit(0));
        setTimeout(() => process.exit(0), 1000); // in case the reply can't be delivered
      });
      return stopping;
    };
    process.on('message', m => { if (m && m.stop) stop('asked by the supervisor'); });
    process.on('disconnect', () => stop('the supervisor has gone'));
    // Ctrl+C in a console reaches the child too. With a supervisor, ignore it: the supervisor asks us to stop.
    // On its own, Ctrl+C still saves first.
    process.on('SIGINT', () => { if (!process.connected) stop('Ctrl+C'); });
  }, e => {
    const msg = e.code === 'EADDRINUSE' ? `Port ${e.port} is already in use by another program.` : `Could not start: ${e.message}`;
    console.log(msg);
    send({ failed: true, error: msg }, () => process.exit(2));
    setTimeout(() => process.exit(2), 1000);
  });
}

module.exports = { run };
