// Which address phones should use to reach this PC. A PC can have several (Wi-Fi, Ethernet, VPN, Hyper-V, WSL);
// the QR code needs the one on the home network.
const os = require('os');
const dgram = require('dgram');

const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|tailscale|zerotier|vpn|loopback|docker|bluetooth/i;

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Every usable IPv4 address with its adapter name (on Windows, "Wi-Fi", "Ethernet", "vEthernet (WSL)"...).
function addresses() {
  const out = [];
  for (const [adapter, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254')) out.push({ address: i.address, adapter });
    }
  }
  return out;
}

// The local address the OS would use for traffic leaving through the default gateway. Connecting a UDP socket
// sends nothing; it just asks the routing table. Resolves null without a default route (offline, wired-only LAN).
function routeAddress(timeoutMs = 500) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    const done = v => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => done(null));
    try { s.connect(53, '192.0.2.1', () => { try { done(s.address().address); } catch { done(null); } }); } catch { done(null); }
  });
}

// Order: 1. the default-route address, if private and not on a virtual adapter (a full-tunnel VPN loses here);
// 2. private addresses on adapters that don't look virtual; 3. any private address; 4. anything.
// `wanted` is network.address from the settings: used when this PC still has it, otherwise auto with a note.
async function pickAddress(wanted = 'auto', log = () => {}) {
  const all = addresses();
  if (wanted && wanted !== 'auto') {
    if (all.some(a => a.address === wanted)) return { address: wanted, how: 'chosen in Settings', all };
    log(`Join address ${wanted} (from Settings) isn't on this PC any more; picking one automatically.`);
  }
  const route = await routeAddress();
  const viaRoute = all.find(a => a.address === route);
  if (viaRoute && isPrivate(viaRoute.address) && !VIRTUAL.test(viaRoute.adapter)) return { address: route, how: 'auto', all };
  const pick = all.find(a => isPrivate(a.address) && !VIRTUAL.test(a.adapter))
    || all.find(a => isPrivate(a.address)) || all[0];
  return { address: pick ? pick.address : null, how: 'auto', all };
}

module.exports = { pickAddress, addresses, isPrivate, VIRTUAL };
