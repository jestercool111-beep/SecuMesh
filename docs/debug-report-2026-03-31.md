# Debug Report 2026-03-31

## Summary

Today we completed end-to-end debugging for the SecuMesh Deno gateway and the upstream One API +
OpenRouter routing path.

The main outcomes were:

- confirmed the gateway request path is working
- fixed `.env` loading so runtime config matches local file settings
- clarified the separation between gateway internal auth and upstream One API auth
- verified that the OpenRouter channel itself is healthy
- identified that several `:free` model aliases configured in One API are stale and should be
  replaced with current canonical model names

## Environment Notes

- Gateway entrypoint: `http://127.0.0.1:9080`
- One API entrypoint: `http://127.0.0.1:3000`
- One API channel under test: `OpenRouter-personal`
- One API channel id: `3`
- One API token group: `default`

## Issue 1: `.env` Port Was Not Taking Effect

### Symptom

The gateway kept listening with the default port behavior even though `.env` had a custom `PORT`
configured.

### Root Cause

The code originally read only `Deno.env` and did not automatically load the workspace `.env` file.

### Resolution

We updated the config loader to read `.env` directly and apply the following precedence:

1. process environment variables
2. `.env` file values
3. hardcoded defaults

### Result

The gateway now respects local `.env` values, including `PORT`.

## Issue 2: Gateway Returned `invalid_api_key`

### Symptom

Requests to the gateway failed with:

```json
{ "error": { "message": "Unauthorized.", "type": "invalid_api_key" } }
```

### Root Cause

The gateway treats the `Authorization` header as the gateway's internal API key first. The upstream
One API token was being sent in the wrong place.

### Resolution

The correct request format is:

```sh
curl http://127.0.0.1:9080/v1/chat/completions \
  -H "Authorization: Bearer internal-demo-key" \
  -H "X-Upstream-Api-Key: <one-api-token>" \
  -H "Content-Type: application/json" \
  -d '...'
```

### Result

After separating internal auth and upstream auth, requests successfully passed through the gateway.

## Issue 3: OpenRouter `:free` Models Failed

### Initial Symptom

The following requests returned One API 404 routing errors:

- `qwen/qwen-vl-plus:free`
- `deepseek/deepseek-r1:free`
- `openai/chatgpt-4o-latest`

Typical error:

```json
{ "error": { "message": "No endpoints found for qwen/qwen-vl-plus:free. (...)", "code": 404 } }
```

### Investigation Performed

We directly queried the local One API server and validated:

- `/v1/models` returned the configured OpenRouter model IDs
- the One API token itself was valid
- the OpenRouter channel existed and was enabled
- the token belonged to the correct default group

We then forced requests to channel `3` by using the One API `token-channel_id` form:

- `Bearer <token>-3`

This let us separate:

- normal channel selection problems
- actual upstream model routing problems

### Verified Results

#### Confirmed Working

- `openai/gpt-3.5-turbo`
- `qwen/qwen-vl-plus`
- `deepseek/deepseek-r1`

#### Confirmed Failing

- `qwen/qwen-vl-plus:free`
- `deepseek/deepseek-r1:free`
- `openai/chatgpt-4o-latest`

### Root Cause

The OpenRouter channel itself is healthy. The failure is caused by stale or invalid model IDs in the
One API channel configuration.

For at least two models, the configured `:free` aliases are no longer routable upstream:

- `qwen/qwen-vl-plus:free`
- `deepseek/deepseek-r1:free`

The canonical names without `:free` do work:

- `qwen/qwen-vl-plus`
- `deepseek/deepseek-r1`

### Important Clarification

One API `/v1/models` reflects what is configured in the channel, not necessarily what OpenRouter
still accepts as a valid current model identifier.

## Archival Model Guidance

### Recommended To Keep

- `openai/gpt-3.5-turbo`
- `qwen/qwen-vl-plus`
- `deepseek/deepseek-r1`
- `openai/o1`
- `openai/o1-preview`
- `openai/o1-mini`
- `openai/o3-mini`
- `google/gemini-2.0-flash-001`
- `google/gemini-2.0-flash-thinking-exp:free`
- `google/gemini-2.0-flash-lite-preview-02-05:free`
- `google/gemini-2.0-pro-exp-02-05:free`
- `google/gemini-flash-1.5-8b`
- `anthropic/claude-3.5-sonnet`
- `anthropic/claude-3.5-haiku`

Note: items not explicitly tested today are marked as keep-for-now, not proven-good.

### Recommended To Replace

- `qwen/qwen-vl-plus:free` -> `qwen/qwen-vl-plus`
- `deepseek/deepseek-r1:free` -> `deepseek/deepseek-r1`

### Recommended To Recheck Separately

- `openai/chatgpt-4o-latest`

This model returned `No endpoints found` during today's checks and should not be used as a stable
default until separately verified.

## Recommended Updated Channel Model List

```text
openai/gpt-3.5-turbo
openai/chatgpt-4o-latest
openai/o1
openai/o1-preview
openai/o1-mini
openai/o3-mini
google/gemini-2.0-flash-001
google/gemini-2.0-flash-thinking-exp:free
google/gemini-2.0-flash-lite-preview-02-05:free
google/gemini-2.0-pro-exp-02-05:free
google/gemini-flash-1.5-8b
anthropic/claude-3.5-sonnet
anthropic/claude-3.5-haiku
deepseek/deepseek-r1
qwen/qwen-vl-plus
```

## Confirmed Stable Regression Models

These are the best candidates for future smoke testing:

- `openai/gpt-3.5-turbo`
- `qwen/qwen-vl-plus`
- `deepseek/deepseek-r1`

## Suggested Next Actions

1. Update the One API `OpenRouter-personal` channel model list:
   - remove `qwen/qwen-vl-plus:free`
   - remove `deepseek/deepseek-r1:free`
   - add `qwen/qwen-vl-plus`
   - add `deepseek/deepseek-r1`
2. Re-test through both One API and the gateway.
3. Re-check `openai/chatgpt-4o-latest` before treating it as production-ready.
