---
name: voice
description: Speak responses out loud via TTS — either through the local Sony Bluetooth speaker (paplay) or as a Telegram voice message (sendVoice). Use when the user asks you to "speak", "say out loud", "give a voice response", "read to me", or otherwise requests audio output.
---

# Voice — Text-to-Speech Output

Generate spoken audio for a reply instead of (or in addition to) plain text. Two delivery paths:

1. **Local speaker** — stream MP3 from the AI Proxy through `ffmpeg` to `paplay` so it comes out the Sony STR-DH190 Bluetooth receiver.
2. **Telegram voice message** — request Opus output, save to a temp file, and POST to the Telegram `sendVoice` bot API.

## When to use

Trigger on any of these phrases (or close variants):

- "speak"
- "say out loud"
- "voice response"
- "read to me"

If the user is on Telegram and asks for a voice reply, prefer the Telegram path. Otherwise (host shell, desktop session) use the local speaker path. If unclear, ask which one they want.

## TTS endpoint

The host runs an AI Proxy at `http://localhost:3005`. The TTS endpoint is:

```
POST http://localhost:3005/v1/tts/stream
Authorization: Bearer $AI_PROXY_API_KEY
Content-Type: application/json
```

Request body:

```json
{
  "text": "<the words to speak>",
  "voiceId": "LzNi2JfTCf9ggr4ibvHF",
  "modelId": "eleven_turbo_v2_5",
  "outputFormat": "mp3_44100_128"
}
```

- `voiceId` defaults to `LzNi2JfTCf9ggr4ibvHF` (Absurdly deep voiced man, generated free-tier voice). Only override if the user has named a different voice.
- `outputFormat` for local playback: `mp3_44100_128` (default).
- `outputFormat` for Telegram voice: `opus_48000_64`.

Response is a streaming `audio/mpeg` (or `audio/ogg` for Opus) body — pipe it straight into the next stage, don't buffer in memory if you can avoid it.

The `AI_PROXY_API_KEY` env var is already injected into the container by NanoClaw (sourced from `agent-services/production/AI_PROXY_API_KEY` in the Solo Vault). Do not log it; reference it as `$AI_PROXY_API_KEY` only.

## Path 1 — Local Bluetooth speaker (Sony STR-DH190)

Audio goes through PulseAudio with `module-bluetooth-discover` loaded, into the Sony receiver over Bluetooth.

- Receiver: **Sony STR-DH190**
- MAC: `98:22:EF:45:F2:B3`
- Connect command (run if not already connected): `bluetoothctl connect 98:22:EF:45:F2:B3`
- Sink discovery: `pactl list sinks short` — pick the line whose name contains the MAC with underscores (e.g. `bluez_sink.98_22_EF_45_F2_B3.a2dp_sink`).

### Steps

1. **Verify connection** (optional but cheap):

   ```bash
   bluetoothctl info 98:22:EF:45:F2:B3 | grep -q 'Connected: yes' || bluetoothctl connect 98:22:EF:45:F2:B3
   ```

2. **Find the sink name** so `paplay` targets the right device:

   ```bash
   SINK=$(pactl list sinks short | awk '/98_22_EF_45_F2_B3/ {print $2; exit}')
   ```

3. **Stream → decode → play** in one pipeline (no temp file):

   ```bash
   curl -sS -N \
     -H "Authorization: Bearer $AI_PROXY_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"text":"<your text here>","voiceId":"LzNi2JfTCf9ggr4ibvHF","outputFormat":"mp3_44100_128"}' \
     http://localhost:3005/v1/tts/stream \
   | ffmpeg -hide_banner -loglevel error -i pipe:0 -f wav - \
   | paplay --device="$SINK"
   ```

   If `$SINK` is empty (Bluetooth not connected, or sink not discovered), drop the `--device` flag and `paplay` will use the default sink — but warn the user that it may have gone to the wrong output.

### Build the JSON body safely

Always JSON-escape the text. Use `jq` to construct the body so quotes/newlines/backslashes in the reply don't break the request:

```bash
BODY=$(jq -nc \
  --arg text "$REPLY_TEXT" \
  --arg voice "LzNi2JfTCf9ggr4ibvHF" \
  --arg fmt "mp3_44100_128" \
  '{text:$text, voiceId:$voice, outputFormat:$fmt}')

curl -sS -N \
  -H "Authorization: Bearer $AI_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  http://localhost:3005/v1/tts/stream \
| ffmpeg -hide_banner -loglevel error -i pipe:0 -f wav - \
| paplay --device="$SINK"
```

## Path 2 — Telegram voice message

Telegram voice notes must be Opus in an OGG container. Request `opus_48000_64`, save to a temp file, then POST to the Bot API.

### Steps

1. **Generate and save the audio:**

   ```bash
   BODY=$(jq -nc \
     --arg text "$REPLY_TEXT" \
     --arg voice "LzNi2JfTCf9ggr4ibvHF" \
     --arg fmt "opus_48000_64" \
     '{text:$text, voiceId:$voice, outputFormat:$fmt}')

   curl -sS -N \
     -H "Authorization: Bearer $AI_PROXY_API_KEY" \
     -H "Content-Type: application/json" \
     -d "$BODY" \
     -o /tmp/tts_voice.ogg \
     http://localhost:3005/v1/tts/stream
   ```

2. **Send via Telegram `sendVoice`** (`$TELEGRAM_BOT_TOKEN` and `$CHAT_ID` come from the runtime context — the destination's chat id and bot token are available in your environment / system prompt):

   ```bash
   curl -sS \
     -F "chat_id=${CHAT_ID}" \
     -F "voice=@/tmp/tts_voice.ogg;type=audio/ogg" \
     "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice"
   ```

3. **Clean up** so successive voice replies don't get confused:

   ```bash
   rm -f /tmp/tts_voice.ogg
   ```

If you have a higher-level `send_voice` destination tool exposed by the runtime, prefer that — fall back to the raw Bot API call only when no such tool exists.

## Defaults

| Setting | Default | Notes |
|---------|---------|-------|
| Voice ID | `LzNi2JfTCf9ggr4ibvHF` | Absurdly deep voiced man (generated, free tier). |
| Output (speaker) | `mp3_44100_128` | Decoded by `ffmpeg`, played by `paplay`. |
| Output (Telegram) | `opus_48000_64` | Required format for Telegram voice notes. |
| Temp file | `/tmp/tts_voice.ogg` | Removed after send. |
| Endpoint | `http://localhost:3005/v1/tts/stream` | AI Proxy on the host. |
| Auth | `Authorization: Bearer $AI_PROXY_API_KEY` | Injected by NanoClaw; do not echo. |

## Tips

- Strip Markdown before speaking: bullets, headings, and code fences sound bad. Send plain prose to TTS.
- Keep it short. A 5-paragraph reply is unbearable as audio. Summarize, then speak the summary.
- For long replies, send the full text as a normal chat message and the spoken summary as voice — don't make the user listen to everything.
- If TTS fails (non-2xx from the proxy), report the failure in chat as plain text rather than going silent.
