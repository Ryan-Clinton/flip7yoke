# CLAUDE.md

Start with `HANDOVER.md`: what this is, how it runs, and how Ryan wants you to work.

## ChatGPT audit rounds

Copied from `weightloss.ryanclinton.uk/CLAUDE.md`'s audit rules: when those change, change these. Here "Build status" means
`node --check` is clean on `server.js`, `run.js`, `public/rules.js` and `tools/eval-scans.js`, `Flip7.ps1` parses
in PowerShell 5.1, and, if the card reader was touched, `node tools/eval-scans.js` still gives 15/15.
ChatGPT reads the private GitHub repo `Ryan-Clinton/flip7yoke`, so end each round with a commit and push, or it
reviews stale code. Nothing gitignored (`.env`, `state.json`, `history.json`, `scans/`, `logs/`) is in the repo,
and it never goes in to give ChatGPT more to look at.

### Never blindly apply what ChatGPT says

This comes before the loop, every round. ChatGPT has not run the code, the
tests or the live site, and it hallucinates; applying it blindly launders its
mistakes into the work, and Ryan loses the second opinion he was after. An
arriving audit is the riskiest moment in a session: the reviewer becomes the
authority and these rules stop being read. So, before any edit, answer these in
the chat:

| Check | If yes |
|---|---|
| Does it need something bought, made or rigged, or Ryan's hands or time? | Say what already exists that does the job; if nothing does, put it to Ryan as one plain question. Never build it on ChatGPT's say-so |
| Does it rest on a claim about the repo, the site or the facts? | Check it against the source first (it audits without running the tests, so "untested" claims are often wrong) |
| Does it change what is being built, or contradict a decision Ryan made or something he asked for? | Ryan outranks ChatGPT: say so and keep his version. This project is his game-night tool with the code published for others to run, not a product launch: no review gates, release pipelines or rules that lecture him |
| Does it bring its own vocabulary or framing (NO-GO, gates, acceptance matrices)? | Don't adopt the reviewer's register |
| Does it ask something answerable from the repo, the web or memory? | Answer it; never hand it to Ryan as a decision |

Then give each point a verdict: **correct** (apply), **wrong** (reject, with
the evidence), **partly right** (take that part) or **taste** (say whose
call). Two failures, both wrong: deference ("suggestions are requirements, so
I'm applying it", which is judgement switched off) and dismissal (defending
my own work, or skipping on preference or effort). The loop below is the
procedure for what survives.

### The loop

The user pastes ChatGPT's feedback. **Claude does not talk to ChatGPT directly.**
Each round, execute every action in order — no stopping early, no asking which to
do first.

- **A — Split the feedback** into code changes (require editing a source file)
  versus documentation-only suggestions. Test: *does applying this require
  editing code?*
- **B — Apply the code changes.** Edit, then verify it still builds/parses. Skip
  only under the closed list below.
- **C — Apply the documentation suggestions**, and update the docs to match any
  new contract from action B (new fields, parameters, modes, behaviour). **Docs
  must match the code at the end of every round.**
- **D — Re-surface the path** the next round should look at, and state
  "Ready for ChatGPT round N+1. Paste feedback when ready." Do not ask which step
  the user wants next — the next step is another round until they say "move on".

### Skip criteria — closed list

Of the suggestions that survive the judgement above, apply each unless one of
these five applies (a point judged wrong, or one needing Ryan's money or hands
when what exists already does the job, is a blocker):

1. **Blocker** — technically impossible or breaks something that works
2. **Forces fabrication** — would require inventing data that isn't available
3. **Conflicts with a stated design principle** — name the principle
4. **Duplicates an existing field or capability** — name what already covers it
5. **Structurally vague** — cannot be turned into a concrete change

"Scope", "manageability", "effort" and "architectural" are **not** valid skip
reasons.

Argue every skip explicitly in the chat, never silently. Judgement, not
auto-apply.

**Delegate rather than absorb.** If a suggestion asks for a capability that
genuinely belongs somewhere else, name where it belongs and skip with that
reason, rather than bolting it on.

### Loop hygiene

- Do **not** get snippy about ChatGPT's feedback, and do not defer to it:
  judge each point as above, and say plainly which survived and why.
- If a suggestion is unclear, propose a follow-up prompt for ChatGPT rather than
  ignoring it.
- **ChatGPT declaring the work "done", or scoring it highly, does not end the
  audit.** Only the user decides when to move on.

### Round counting

Count rounds by **feedback batches the user relays**, not by internal rewrites.
Fourteen changes from one ChatGPT response is still round 1. State the round
number in every end-of-round summary.

### End-of-round summary — required format

```
## Round N complete
**Code changes applied:** <what>            OR  n/a — docs-only round
**Build status:** <clean / errors>          OR  n/a — no code touched
**Docs updated:** <sections>                (ALWAYS populated)
**Skipped suggestions:** <none / list, each with its named skip reason>

Path for next round: <path>
Ready for ChatGPT round N+1. Paste feedback when ready.
```

### Recurring patterns worth pre-empting

Carried over from `premium-features-domain-packs.md`:

- **"Add a metric" usually means derive, not fetch.** Check whether the
  analytical surface can be synthesised from data already held before adding a
  new source or dependency.
- **Renaming a public field or option** — keep the old name working as a
  deprecated alias rather than breaking callers.
- **Requests for a summary/report view** are usually packaging, not new
  computation. The signals normally already exist.
- **Pre-empt the obvious reviewer question** in the output itself, so it doesn't
  come back every round.
