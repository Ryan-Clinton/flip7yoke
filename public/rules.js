// Scoring rules shared by the server (require) and the browser (<script>), so they can't drift apart.
// Modes: 'classic' (Flip 7), 'vengeance' (Flip 7 With a Vengeance), 'brutal' (Vengeance + Brutal Mode).
(function (root) {
  const sum = a => (a || []).reduce((x, y) => x + y, 0);
  const isVengeance = mode => mode === 'vengeance' || mode === 'brutal';

  // Seven number cards (Lucky 13 lets a second 13 count) without busting.
  function isFlip7(e) {
    return !!e && !e.bust && typeof e.manual !== 'number' && (e.cards || []).length >= 7;
  }

  // Round points for one player's entry, before Brutal Flip 7 hits from other players.
  function entryScore(e, mode) {
    if (!e) return 0;
    if (typeof e.manual === 'number') return e.manual;
    const nums = e.cards || [];
    if (!isVengeance(mode)) {
      if (e.bust) return 0;
      let s = sum(nums);
      if (e.x2) s *= 2;
      s += sum(e.mods);
      return nums.length >= 7 ? s + 15 : s;
    }
    const brutal = mode === 'brutal';
    // Brutal: modifiers can be dumped on busted players, so a bust can score below zero.
    if (e.bust) return brutal ? -sum(e.mods) : 0;
    const flip7 = isFlip7(e);
    // Rulebook order: number cards, then ÷2 (round down), then minus modifiers, then the Flip 7 bonus.
    let s = sum(nums);
    if (nums.includes(0) && !flip7) s = 0; // The Zero: scores nothing unless you Flip 7
    if (e.half) s = Math.floor(s / 2);
    s -= sum(e.mods);
    if (!brutal) s = Math.max(0, s);
    // Brutal: a Flip 7 can take -15 off another player instead of banking +15.
    if (flip7 && !(brutal && e.hit)) s += 15;
    return s;
  }

  // Does this entry reset the player's game total to zero?
  function wipes(e) {
    return !!e && !!e.wipe && !(isFlip7(e) && (e.cards || []).includes(0));
  }

  // Game totals by replaying rounds, so a wipe stays correct if an earlier round is edited or deleted.
  function totals(state) {
    const t = Object.fromEntries(state.players.map(p => [p.id, 0]));
    for (const r of state.rounds) {
      for (const id in t) t[id] = (r.zero || []).includes(id) ? 0 : t[id] + (r.scores[id] || 0);
    }
    return t;
  }

  const api = { entryScore, isFlip7, wipes, totals, isVengeance };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Rules = api;
})(this);
