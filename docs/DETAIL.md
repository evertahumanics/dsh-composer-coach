# Composer coach

Grammar suggestions and prompt polishing inside the DSH message composer.

## Behaviour

While you type, a debounce timer waits for the configured pause — one second by
default. When it expires, the plugin sends the draft to your configured model,
asks only for the corrected text, and computes the difference itself. Each change
is shown on its own, anchored to the word it touches:

```
        ┌──────────────────────────────────────┐
        │ 2 of 3            ↑  ↓  ✕            │
        │ has → have                           │
        │ [Accept] [Skip] [Accept all] [Polish]│
        └──────────────────────────────────────┘
   ...I [have] an apple...        ← word underlined in place
```

The card is positioned from the editor's own text range for that word, clamped to
the viewport, and flips below the line when there is no room above. Scrolling and
resizing reposition it. `↑` / `↓` move between suggestions when there is more than
one.

If the card cannot be placed safely — the draft holds reference chips, so
character offsets no longer match the rendered text, or more than one editor is in
scope — the identical suggestions render as a strip above the composer. The
feature never disappears; only the placement degrades.

Accepted edits are applied to the live draft. Because the diff carries the exact
original span, an edit whose text no longer matches is rejected rather than
applied — a suggestion computed three seconds ago can never clobber newer typing.

**Polish prompt** is a pill labelled **Polish**, with a sparkle mark, that floats
over the top-right of the draft.
It rewrites the draft into a stronger instruction and shows the rewrite in a card
over the text. It replaces the draft only when you choose **Use it**, so the
original is one undo away.

## Send-only mode

Turn **Live checks in the composer** off to silence everything while typing: no
debounced checks, no suggestion card, no Polish pill. The composer looks exactly
as it does without the plugin, and both rewrites are prepared only when you press
Enter — the send preview then shows the grammar-corrected and polished versions.

`Enabled` remains the master switch; with it off nothing runs at all, including
the send preview.

## Send-time preview

With **Preview before sending** enabled, Enter is held: the plugin asks the host for
both rewrites in one request (`POST /prepare`) and shows a card with the
grammar-corrected and the polished prompt. Choosing one rewrites the draft and
submits it; **Send original** submits unchanged; **✕** or **Esc** cancels and
leaves the draft as typed.

Only a bare Enter is intercepted — Shift+Enter, modifiers, IME composition, and
submissions outside the `plain` phase pass straight through. While the card is
open a second Enter cannot send twice.

The polished side uses session context when enabled, so a short draft can inherit
the session's current topic; turn *Use conversation context* off if that skews
your results.

## Context and thresholds

Polish sends the last turns of the current session with the rewrite, up to eight
messages or 3000 characters, so it can fit the request to what you are doing. The
**Use conversation context** switch (on by default) sends only the draft when off.

Checks begin once the draft holds the configured number of words (2 by default)
and has been idle for the configured pause, so short phrases are checked too.

## Stale suggestions

Every suggestion records the exact text span it replaces. If the draft no longer
matches that span — you deleted the word, or typed inside it — the suggestion is
dropped rather than hovering a word that no longer exists.

## Interaction details

- Buttons carry hover, active and keyboard-focus states, and honour
  `prefers-reduced-motion`.
- A check that takes longer than 400 ms shows a spinner pill instead of leaving the
  interface silent.
- **Esc** dismisses a suggestion or polish card; the draft is untouched.

## No-pause mode

The pause is configurable down to **0 seconds**, which checks as the draft changes
instead of waiting. That is one model call per change, aborted and replaced by the
next one, so it is the expensive setting: use it with a fast model, or keep the
pause above zero on a metered plan.

## Deliberate limits

- **The draft leaves the machine.** Model-based checking requires sending it to
  the provider configured in this profile. The master switch stops all requests.
- **No autonomous rewriting.** Every change requires your click.
- **Code is out of scope.** Fenced blocks and inline spans are excluded from the
  diff, so a model that "improves" your code sample changes nothing.
- **One call per pause.** The timer resets on every keystroke and in-flight
  requests are aborted, so fast typing does not queue up work.
- **Degrades visibly.** With no provider or model available, the panel shows the
  error from the host instead of silently doing nothing.

## Troubleshooting

- **Nothing appears:** the draft is below the minimum character count, the pause
  has not elapsed, or the master switch is off.
- **An error line appears:** run **Run a test check** in Settings → Composer coach;
  it reports the model route failure without touching the draft.
- **Checks feel slow:** the pause is the delay *plus* model latency. Raise the
  pause, or set a faster model in the plugin settings.
- **Settings will not save:** the host reports it; a profile without a
  configuration editor cannot persist changes.
