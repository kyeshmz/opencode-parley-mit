# opencode-parley

opencode plugin for [MIT Parley](https://parley-docs.mit.edu): registers Parley as a provider (models pulled live from `/v1/models`), handles validated API-key auth, and tracks cost.

## Setup

```sh
# install: add "opencode-parley" to the plugin list in ~/.config/opencode/opencode.json,
# or from a checkout:
ln -sf /path/to/opencode-parley/src/index.ts ~/.config/opencode/plugins/parley.ts

opencode auth login   # pick "MIT Parley", paste your sk-parley-v1-... key
```

Keys are format-checked and verified live against Parley before being stored; a bad key fails the login. `PARLEY_API_KEY` (env or project `.env`) takes precedence over the stored credential. If a key is missing or rejected — including mid-session 401s — an error toast tells you to re-auth.

Pick models with `/models` (all prefixed `parley/`), or `opencode run -m parley/bedrock/claude-sonnet-5 "..."`.

## Cost tracking

- Per-message/session cost shows natively in the TUI (the plugin attaches Parley's per-million-token rates to each model; rates live in `RATES` in `src/index.ts` — unlisted models show $0).
- Non-streaming responses' `x-parley-v1-cost` headers accumulate in `~/.local/share/opencode/parley-cost.json`.

## Commands

| Command | What it does |
|---|---|
| `/parley_usage [from] [to]` | Billed usage from Parley's usage API with per-model breakdown (default: current month). |
| `/parley_budget [instructions]` | Show budget alert limits, or update them (`set monthly limit 50 alert at 80`). Soft limits, thresholds 50–95%; may need admin credentials. |
| `/parley_cost` | Summarize the local cost-header log. |

Each command drives a matching plugin tool (plus `parley_count_tokens` for free token estimates), which the agent can also call directly.

`/parley_usage` and `/parley_budget` need your account ID — set `PARLEY_ACCOUNT_ID` (env or `.env`); get it from the Parley dashboard or your IS&T admin, the API key can't discover it.

## Overrides

Anything under `provider.parley` or `command` in `opencode.json` wins over plugin defaults, e.g. extended thinking:

```json
{
  "provider": {
    "parley": {
      "models": {
        "bedrock/claude-opus-4-8": {
          "options": { "max_tokens": 64000, "thinking": { "type": "adaptive" } }
        }
      }
    }
  }
}
```

## Notes

- Parley is stateless; opencode resends full context each turn, so long sessions grow input cost.
- Parley's file-attachment API isn't wrapped — opencode inlines attachments itself and can't reference Parley `file_id`s.
