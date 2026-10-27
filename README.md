# Lacuna

An OpenCode V2 plugin that lets the model manage its own context window.

Most context management runs on fixed rules: drop old tool output, summarise when the window is full. Lacuna leaves
those decisions to a background archive agent forked from the main agent. It sees the current context, chooses what to summarise or keep,
and leaves the main agent free to continue working. The main agent can bring the originals back when needed.

![How Lacuna archives context](docs/animation/lacuna.webp)

## How it works

1. Identifiable conversation units carry ref tags with their ID and kind:
   `<ref id="m12" kind="tools:read"/>`. These tags are visible to the model, not shown in the UI.
2. After a response, if context exceeds `archiveAt`, Lacuna starts a background archive job. The archive agent
   chooses ranges and writes summaries, or keeps everything unchanged. Ready summaries replace their ranges
   before the next request. The main agent can also invoke an archive job manually.
3. If the model later needs the details, it searches the archive and restores the block. Blocks can be archived
   again inside larger ones, so a long session folds into layers.

Lacuna builds a **projection** of the session for each model request: archived ranges appear as summaries,
while stored session history stays unchanged. Disable the plugin and the original conversation is available again.

Blocks remember the unit identities actually archived, so model switches can remove individual messages without
replaying the surviving archived content. Newly revealed messages stay visible. If none of a block's members are
present, the footer reports it as unresolved; `/lacuna` lists the affected blocks.

## But this ruins the prompt cache?

By default, the archive job uses the same model and copies the primary request's prefix, appending archive instructions so it
can reuse the prompt cache. Applying summaries changes the prefix from the first archived message onward; the
provider may need to reprocess that portion. Subsequent requests are smaller.

That trade is almost always worth it. Cached input is usually billed at around a tenth of the fresh price, but it is
billed again on every step. Removing 50k tokens pays back the one miss within a few steps and keeps saving for the
rest of the session. The paper
[Model-Driven Incremental Hierarchical Compression](https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md),
from the billion-context repository, reports the same approach in production over 4.5 months and about 175,000 model
calls: 91% of input tokens were still served from cache, and most misses came from the provider's cache expiring, not
from archiving. These figures are self-reported by a single author.

Some models also charge a higher rate for the whole request above a context size; several GPT models double the
input price above 272k tokens. The default `archiveAt` of 200k starts cleanup below that threshold. OpenCode
lists the tiers in each model's `cost` metadata; if yours is lower, set `archiveAt` below it.

## Install

Requires OpenCode 2.2.0 or newer.

Add the package to `plugins` in `opencode.json`. OpenCode installs it from npm on the next start:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "opencode-lacuna", "options": { "archiveAt": 0.6 } }]
}
```

`archiveAt` is either a fraction of the context window (`0.6`) or an absolute token count (`150000`). Default `200000`.

### Blocking archive requests

`archiveMode` defaults to `"background"`, which lets the main agent continue while archiving runs. For a local model
that cannot handle two inference requests at once, set `"archiveMode": "blocking"` in the plugin's options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "opencode-lacuna", "options": { "archiveMode": "blocking" } }]
}
```

Automatic and manual archive jobs use the same pipeline in both modes. In blocking mode, the next primary request
waits for archiving and cleanup, then receives the summaries. The archive tool itself still returns immediately.
Failed or skipped jobs resume with the originals. Compaction cancels the archive and waits for its worker to stop.

Archive requests have a five-minute timeout. If a cancelled worker still has not stopped after ten seconds, blocking
mode fails the waiting request instead of allowing overlapping requests. Retry once the worker has stopped.
Stopping inference itself depends on the provider honoring cancellation.

`archiveModel` works unchanged in either mode. Omitting its model inherits the main model; settings-only overrides
can reduce reasoning effort. Blocking does not coordinate other sessions, subagents, or auxiliary requests such as
`/btw` and title generation, and switching models does not guarantee that only one model remains loaded in memory.

### Use a different archive model

Set `archiveModel` explicitly to use another OpenCode-registered model for automatic and manual archive jobs:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "opencode-lacuna",
    "options": {
      "archiveAt": 0.6,
      "archiveModel": {
        "model": "your-provider/your-model#your-variant",
        "options": { "maxTokens": 8192 }
      }
    }
  }]
}
```

Use the catalog IDs from OpenCode's model selector; `#variant` is optional. Omitting `archiveModel` preserves the
default: inherit the main model and its request overrides. Lacuna never automatically selects a cheaper model.
You can also omit `archiveModel.model` to inherit the main model while overriding only its archive request settings:

```jsonc
"archiveModel": {
  "options": { "maxTokens": 8192 }
}
```

In that case the archive request keeps the main model (including its variant) and per-call settings, applies your
overrides on top, and uses the existing same-session fork rather than a temporary child session.

An explicit archive model uses its own OpenCode-configured provider, model, and variant settings, not the main
request's per-call overrides. Optional `archiveModel.options` overrides those defaults for archive requests only;
use semantic request fields such as `maxTokens`, `temperature`, or your provider's reasoning settings (for example,
`reasoningEffort` on OpenAI Responses). Provider-specific fields must match the selected model's protocol.
`maxTokens` must be a positive integer within the model's registered output limit; capacity checks reserve space for it.
Standard fields are validated with OpenCode's `GenerationOptions` schema; provider-specific options pass through to
the selected protocol. New standard fields become available when the OpenCode AI dependency is updated.
Without it, the check reserves the inherited per-call output limit, if any, or the registered output limit.
The explicitly selected archive model receives the captured system
instructions, messages, and tool schemas through a temporary child session, removed after the job finishes.
The main session's model is unchanged.

Using another model loses reuse of the main model's prompt cache, but can still be cheaper overall. Choose a model
with enough input capacity for the entire captured context. Lacuna checks registered models, variants, and estimated
input capacity before generation. Unavailable models, unknown variants, insufficient capacity, and provider errors
fail the archive job, shown in `/lacuna`; originals remain visible and there is no fallback to the main model.
Capacity checks are estimates, not exact token counts.

Don't run another context pruning plugin at the same time: two plugins rewriting the same messages will conflict.

## Develop

Use Node.js 26.4.0 or newer, as required by OpenTUI 0.7.

```sh
git clone https://github.com/Trollgeir/lacuna
cd lacuna && npm install
npm test          # node --test
npm run typecheck
```

To run your clone, set `"package"` to its absolute path instead of `opencode-lacuna`. Local plugin directories are hot-reloaded by OpenCode, so edits take effect without a restart.

## Limitations

- Token figures are estimates (characters ÷ 4), corrected against the usage the provider reports.
- No automatic cleanup of duplicate or failed tool output; everything is model-driven.
- Units without a durable message or tool-result identity remain visible and cannot be archived.
- Unless disabled (`"compaction": { "auto": false }`), OpenCode's own compaction still runs at the context limit and
  summarises the material that was never archived.
- Saved originals are kept until the session is deleted, so a long session's storage grows with everything it has archived. Sessions deleted while Lacuna isn't loaded leave their saved data behind.

## Acknowledgements

Inspired by [Dynamic Context Pruning](https://github.com/Tarquinen/opencode-dynamic-context-pruning) and
[billion-context](https://github.com/ranxianglei/billion-context). No code is shared; Lacuna is a separate
implementation for the OpenCode V2 plugin API.

## License

MIT
