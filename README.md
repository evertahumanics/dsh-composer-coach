# Composer coach

Live grammar help for the DSH composer, plus a one-click prompt polish.

## What it does

- **Grammar suggestions while you type.** When you stop typing for the configured
  pause (1 second by default), the draft is sent to your configured model, which
  returns a corrected version. The plugin diffs that against your draft and shows
  **word-level changes**.
- **The card floats over the word.** A suggestion card appears above the changed
  word in the composer, with the word underlined in place, so you see the fix
  next to the text rather than in a separate strip. Use `↑` / `↓` to step through
  several suggestions.
- **Suggestions follow the text.** An edit whose span no longer matches the draft
  is dropped, so deleting a word never leaves a card hovering over it.
- **Accept word by word.** Each suggestion has its own **Accept** and **Skip**.
  **Accept all** applies every remaining change at once. Edits are applied against
  the draft as it is at that moment, and a suggestion that no longer matches the
  text is dropped instead of overwriting newer typing.
- **Send-time preview.** With *Preview before sending* on, pressing Enter does not
  send immediately: a card shows the **grammar-corrected** and **polished** versions
  of your prompt, and you choose *Send polished*, *Send grammar*, *Send original*, or
  cancel. Shift+Enter still inserts a newline.
- **Polish prompt.** A pill labelled **Polish** with a sparkle icon floats over the
  draft; it rewrites the text into a clearer, better-specified prompt and shows the
  result in a card over the text. Nothing is replaced until you press **Use it**.
- **Context is opt-out.** Polish sends the last turns of the current session
  (up to 8 messages, 3000 characters) so the rewrite fits what you are doing.
  Turn **Use conversation context** off to send only the draft. Grammar checks
  are always draft-only.
- **Quiet while it works.** A short check shows nothing; past 400 ms it becomes a
  small *Checking…* pill with a spinner, so the UI never looks frozen. **Esc**
  dismisses any floating card without touching your draft. A failed check turns
  the pill into a red **Retry check** rather than silently disappearing.
- **Configurable delay.** Settings → **Composer coach** sets the pause in seconds
  (0.3–10), plus the character thresholds, language, prompt style, and an optional
  provider/model override.

## Three independent switches

| Enabled | Live checks | Preview before sending | Result |
|---|---|---|---|
| on | on | on | suggestions + Polish pill while typing, and a send preview |
| on | **off** | on | **nothing in the composer; both versions appear only when you send** |
| on | off | off | silent — no model calls at all from the composer |
| off | any | any | everything stops |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Pause before checking | 1.0 s | Idle time before a check runs, 0–10 s. **0 checks as you type** |
| Enabled | on | Master switch: stops every check and model call |
| Live checks in the composer | **on** | Off silences the composer entirely; results appear only in the send preview |
| Start after (words) | 2 | Checks begin as soon as the draft has this many words |
| Minimum characters | 1 | Length floor, independent of the word count |
| Maximum characters | 6000 | Longer drafts are refused rather than sent |
| Language | `auto` | `auto`, or a language tag such as `en` |
| Provider / Model | empty | Empty uses the profile default. Both fields autocomplete from `/composer-coach/api/models` |
| Polished prompt style | concise | `concise`, `detailed`, or `technical` |
| Use conversation context | **on** | Sends the last turns of the session with the polish request |
| Preview before sending | **on** | Enter opens a card with the corrected and polished text, and you pick what sends |

`Run a test check` verifies the model route without touching your draft.

## Limits worth knowing

- The draft **is sent to the configured model provider**. That is inherent to a
  model-based checker; turn **Enabled** off to stop it entirely. Nothing is sent
  while the setting is off.
- Checks are **debounced**: one request per pause, never one per keystroke, and a
  new check aborts the one in flight.
- Fenced code blocks and inline code are **never rewritten**, even if the model
  changes them.
- Suggestions are only suggestions — the plugin never edits your draft on its own.
- The floating card needs to measure the composer's editor to place itself over a
  word. When that measurement is not safe — the draft contains reference chips so
  text offsets would drift, or the editor is not uniquely identifiable — the same
  suggestions appear as a strip above the composer instead. Nothing is lost, only
  the placement changes.
- The correction itself depends on the model's quality; the plugin guarantees
  deterministic diffing and application, not model accuracy.
- Each pause with changed text costs one model call. Raise the pause or the
  minimum character count on a metered plan.

## HTTP surface

All routes are same-origin under `/composer-coach/api`:

- `GET /config` — effective settings
- `POST /config` — save a partial settings object
- `POST /check` `{ text, language }` → `{ edits: [{ start, end, original, replacement, kind }] }`
- `POST /polish` `{ text, tone }` → `{ polished }`
