#!/usr/bin/env bash
# Direct curl test to verify whether the configured OpenAI-compatible endpoint
# actually returns reasoning content when `reasoning_effort` is set.
#
# Reads provider / model / baseUrl / apiKey from ~/.omux/config.json
# (falls back to a legacy ~/.cliclaw/config.json).
# Bypasses omux entirely — useful when you suspect a proxy is dropping or
# inconsistently forwarding the reasoning field.
#
# Usage:
#   ./scripts/test-reasoning.sh                      # use config file values
#   ./scripts/test-reasoning.sh medium               # override level (off|minimal|low|medium|high)
#   EFFORT=high ./scripts/test-reasoning.sh
#   MODEL=gpt-5 ./scripts/test-reasoning.sh
#   BASE_URL=https://api.openai.com/v1 API_KEY=sk-... ./scripts/test-reasoning.sh
#   WITH_TOOLS=1 ./scripts/test-reasoning.sh         # also probe with a dummy tool
#   N=5 ./scripts/test-reasoning.sh                  # repeat N times to spot flakiness

set -euo pipefail

DEFAULT_CONFIG="$HOME/.omux/config.json"
if [[ ! -f "$DEFAULT_CONFIG" && -f "$HOME/.cliclaw/config.json" ]]; then
	# legacy cliclaw home
	DEFAULT_CONFIG="$HOME/.cliclaw/config.json"
fi
CONFIG_FILE="${CONFIG_FILE:-$DEFAULT_CONFIG}"

if [[ ! -f "$CONFIG_FILE" ]]; then
	echo "config not found: $CONFIG_FILE" >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "jq not installed (brew install jq)" >&2
	exit 1
fi

CFG_PROVIDER=$(jq -r '.llm.provider // ""' "$CONFIG_FILE")
CFG_MODEL=$(jq -r '.llm.model // ""' "$CONFIG_FILE")
CFG_API_KEY=$(jq -r '.llm.apiKey // ""' "$CONFIG_FILE")
CFG_BASE_URL=$(jq -r '.llm.baseUrl // ""' "$CONFIG_FILE")
CFG_THINKING=$(jq -r '.llm.thinking // "off"' "$CONFIG_FILE")

# If baseUrl was not set in config (i.e. using a built-in provider), fall back to
# common defaults. Add more here if you use other providers.
if [[ -z "$CFG_BASE_URL" ]]; then
	case "$CFG_PROVIDER" in
		openai)    CFG_BASE_URL="https://api.openai.com/v1" ;;
		deepseek)  CFG_BASE_URL="https://api.deepseek.com" ;;
		moonshot)  CFG_BASE_URL="https://api.moonshot.cn/v1" ;;
		groq)      CFG_BASE_URL="https://api.groq.com/openai/v1" ;;
		xai)       CFG_BASE_URL="https://api.x.ai/v1" ;;
		gemini)    CFG_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai" ;;
		together)  CFG_BASE_URL="https://api.together.xyz/v1" ;;
		mistral)   CFG_BASE_URL="https://api.mistral.ai/v1" ;;
		openrouter) CFG_BASE_URL="https://openrouter.ai/api/v1" ;;
		*)
			echo "unknown provider '$CFG_PROVIDER' and no baseUrl in config" >&2
			exit 1
			;;
	esac
fi

# Allow env overrides
MODEL="${MODEL:-$CFG_MODEL}"
BASE_URL="${BASE_URL:-$CFG_BASE_URL}"
API_KEY="${API_KEY:-$CFG_API_KEY}"
EFFORT="${1:-${EFFORT:-$CFG_THINKING}}"
N="${N:-1}"
WITH_TOOLS="${WITH_TOOLS:-0}"

if [[ -z "$API_KEY" ]]; then
	echo "no API key (set llm.apiKey in $CONFIG_FILE or pass API_KEY=...)" >&2
	exit 1
fi

URL="${BASE_URL%/}/chat/completions"

echo "═══════════════════════════════════════════════════════════════"
echo "endpoint : $URL"
echo "model    : $MODEL"
echo "effort   : $EFFORT"
echo "n        : $N"
echo "tools    : $WITH_TOOLS"
echo "═══════════════════════════════════════════════════════════════"
echo

PROMPT='Solve carefully and show your work step by step: there is a 3-digit positive integer N such that N is divisible by 7, the sum of its digits is 17, and the digits are strictly increasing. What is N?'

build_body() {
	local with_effort="$1"   # 0 or 1
	local with_tools="$2"    # 0 or 1
	local stream_flag="${3:-false}"
	local body
	body=$(jq -n \
		--arg model "$MODEL" \
		--arg prompt "$PROMPT" \
		--argjson stream "$stream_flag" \
		'{
			model: $model,
			stream: $stream,
			messages: [{ role: "user", content: $prompt }]
		}')

	if [[ "$stream_flag" == "true" ]]; then
		body=$(echo "$body" | jq '. + { stream_options: { include_usage: true } }')
	fi

	if [[ "$with_effort" == "1" && "$EFFORT" != "off" ]]; then
		body=$(echo "$body" | jq --arg eff "$EFFORT" '. + { reasoning_effort: $eff }')
	fi

	if [[ "$with_tools" == "1" ]]; then
		body=$(echo "$body" | jq '. + {
			tools: [{
				type: "function",
				function: {
					name: "noop",
					description: "Reserved tool. Do not call.",
					parameters: { type: "object", properties: {} }
				}
			}]
		}')
	fi

	echo "$body"
}

call_once() {
	local label="$1"
	local body="$2"
	echo "─── $label ───"
	local response
	response=$(curl -sS -X POST "$URL" \
		-H "Authorization: Bearer $API_KEY" \
		-H "Content-Type: application/json" \
		-d "$body")

	# Print full usage object plus a few quick checks
	echo "usage:"
	echo "$response" | jq '.usage // {}' 2>/dev/null || echo "$response"

	local rt
	rt=$(echo "$response" | jq -r '.usage.completion_tokens_details.reasoning_tokens // .usage.completion_tokens_details.reasoning // empty' 2>/dev/null)
	if [[ -n "$rt" && "$rt" != "0" ]]; then
		echo ">>> reasoning_tokens = $rt  ✅ reasoning enabled and produced output"
	else
		echo ">>> reasoning_tokens = 0    ❌ no reasoning in response"
	fi

	# Some providers expose reasoning as a separate top-level field on the choice
	local rline
	rline=$(echo "$response" | jq -r '.choices[0].message.reasoning // empty' 2>/dev/null || true)
	if [[ -n "$rline" ]]; then
		echo ">>> message.reasoning = ${rline:0:120} ..."
	fi
	rline=$(echo "$response" | jq -r '.choices[0].message.reasoning_content // empty' 2>/dev/null || true)
	if [[ -n "$rline" ]]; then
		echo ">>> message.reasoning_content = ${rline:0:120} ..."
	fi

	# Show error if any
	local err
	err=$(echo "$response" | jq -r '.error.message // empty' 2>/dev/null)
	if [[ -n "$err" ]]; then
		echo "!!! API error: $err"
	fi

	echo
}

# Probe 1: NO reasoning_effort (baseline — what does usage look like normally?)
call_once "baseline (no reasoning_effort)" "$(build_body 0 0)"

# Probe 2..N+1: WITH reasoning_effort
for i in $(seq 1 "$N"); do
	call_once "with reasoning_effort=$EFFORT  [$i/$N]" "$(build_body 1 0)"
done

if [[ "$WITH_TOOLS" == "1" ]]; then
	call_once "with reasoning_effort=$EFFORT + tools" "$(build_body 1 1)"
fi

# ─── Streaming probe (mirrors how omux actually calls the API) ────────
echo "═══════════════════════════════════════════════════════════════"
echo "STREAMING probe — replicates omux's real call shape (stream: true)"
echo "Looks at the LAST usage chunk to see whether the proxy keeps"
echo "completion_tokens_details.reasoning_tokens when streaming."
echo "═══════════════════════════════════════════════════════════════"

call_stream_once() {
	local label="$1"
	local body="$2"
	echo "─── $label (streaming) ───"
	local raw
	raw=$(curl -sS -N -X POST "$URL" \
		-H "Authorization: Bearer $API_KEY" \
		-H "Content-Type: application/json" \
		-d "$body")

	# Pull every JSON line that starts with `data: ` and has a `usage` field.
	# In OpenAI-style streaming the final usage chunk arrives just before [DONE].
	local usage_chunks
	usage_chunks=$(echo "$raw" | grep '^data: {' | sed 's/^data: //' \
		| jq -c 'select(.usage != null) | .usage' 2>/dev/null || true)

	if [[ -z "$usage_chunks" ]]; then
		echo ">>> no usage chunk seen in stream  ❌"
		echo "raw tail:"
		echo "$raw" | tail -8
	else
		echo "all usage chunks found in stream:"
		echo "$usage_chunks" | jq .
		local last_rt
		last_rt=$(echo "$usage_chunks" | tail -1 | jq -r '.completion_tokens_details.reasoning_tokens // 0')
		if [[ "$last_rt" != "0" && -n "$last_rt" ]]; then
			echo ">>> streaming reasoning_tokens = $last_rt  ✅ proxy keeps reasoning details when streaming"
		else
			echo ">>> streaming reasoning_tokens = 0  ❌ proxy drops reasoning_tokens in streaming mode"
			echo "    (this is exactly the omux symptom — not an omux bug, the proxy is the culprit)"
		fi
	fi

	# Also check whether reasoning content shows up via choices[*].delta.reasoning_content
	local has_delta_reasoning
	has_delta_reasoning=$(echo "$raw" | grep '^data: {' | sed 's/^data: //' \
		| jq -r 'select(.choices[0].delta.reasoning_content != null) | "1"' 2>/dev/null | head -1)
	if [[ "$has_delta_reasoning" == "1" ]]; then
		echo ">>> stream contains delta.reasoning_content chunks (DeepSeek/Moonshot/Anthropic-proxy style)"
	fi

	echo
}

call_stream_once "no reasoning_effort"           "$(build_body 0 0 true)"
call_stream_once "with reasoning_effort=$EFFORT" "$(build_body 1 0 true)"
if [[ "$WITH_TOOLS" == "1" ]]; then
	call_stream_once "with reasoning_effort=$EFFORT + tools" "$(build_body 1 1 true)"
fi

echo "═══════════════════════════════════════════════════════════════"
echo "Interpretation:"
echo "  - reasoning_tokens > 0 in any 'with effort' run → upstream supports it"
echo "  - all 0 → proxy/model is silently dropping the field"
echo "  - first run > 0 then later 0 → proxy caches/strips inconsistently"
echo "  - usage missing completion_tokens_details → proxy not forwarding details"
echo "═══════════════════════════════════════════════════════════════"
