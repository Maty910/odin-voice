# odin-voice

## What it does

odin-voice is an OpenCode V2 plugin that plays short voice notifications when work finishes, fails, needs a permission, or asks a question. It lets you follow an OpenCode session without watching the terminal continuously.

## Features

- Handles OpenCode V2 `session.idle`, `session.error`, `question.asked`, and `permission.asked` events.
- Selects clips from category pools and, for completed work, can prefer agent-specific or flow-specific pools.
- Tries local audio players in this order: `paplay`, `pw-play`, `ffplay`, `mpv`, `aplay`.
- Applies configurable per-category cooldowns, volume, and enabled states.
- Never lets playback or event-consumer failures interrupt an OpenCode session.
- Uses pre-generated local files at playback time; no network request is made when an event is announced.

## Requirements

- OpenCode V2.
- Node.js and npm for development and clip generation.
- At least one supported local audio player: `paplay`, `pw-play`, `ffplay`, `mpv`, or `aplay`.
- Generated MP3 clips before audible notifications are possible.

## Installation (OpenCode V2)

Place the plugin directory under OpenCode's plugin directory, then create a top-level wrapper that re-exports the plugin entry point:

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/Maty910/odin-voice.git \
  ~/.config/opencode/plugins/odin-voice
```

```ts
// ~/.config/opencode/plugins/odin-voice.ts
export { default } from "./odin-voice/src/index.ts"
```

The wrapper is required because OpenCode discovers plugin entry files directly in `~/.config/opencode/plugins/`, while the implementation lives in the cloned `odin-voice/` directory.

## Configuration

`config.json` controls the plugin's behavior. It defines a top-level `volume` and four categories: `finished`, `error`, `question`, and `permission`.

Each category has an `enabled` flag, a `cooldownMs` value, and a `clips` pool. A clip entry names its file with `clip` and its source phrase with `phrase`. Finished-work entries can additionally use `agent` for an agent-specific pool or `scope: "flow"` for a flow-specific pool.

```json
{
  "volume": 80,
  "categories": {
    "finished": {
      "enabled": true,
      "cooldownMs": 8000,
      "clips": [{ "clip": "finished-1.mp3", "phrase": "It is done." }]
    }
  }
}
```

The configuration references clip files, but those files are not present in a clean clone. Generate them before expecting sound; until then, the plugin safely chooses silence.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ODIN_VOICE_MUTE` | Set to `1` to silence all announcements temporarily. |
| `ODIN_VOICE_DEBUG` | Set to `1` to write event and decision diagnostics to stderr. |
| `ELEVENLABS_API_KEY` | Required by the clip-generation script to call ElevenLabs. |
| `ELEVENLABS_VOICE_ID` | Required by the clip-generation script to select an ElevenLabs voice. |

## Generate your own clips

MP3 files are deliberately not distributed with this repository because they are audio generated through third-party services. A clean clone therefore has no playable clips, and the plugin degrades to silence rather than failing.

To generate the clips referenced by `config.json` with ElevenLabs, provide your own credentials and voice ID:

```bash
export ELEVENLABS_API_KEY="..."
export ELEVENLABS_VOICE_ID="..."
npm run generate-clips
```

Use `npm run generate-clips -- --force` to regenerate every configured clip. Generated `clips/*.mp3` files are ignored by Git and stay local to your machine.

## Architecture

The plugin separates a pure core from its OpenCode V2 adapter. The core maps events, parses configuration, selects clip pools and players, applies cooldowns, and makes safe playback decisions.

The adapter owns runtime integration: it normalizes real event envelopes such as `{ type, data }`, resolves session context, and feeds announcements to a 900 ms priority gate. A process-wide singleton prevents duplicate consumers, while the consumer handles stream errors and retries without taking down OpenCode. Any unplayable or missing clip becomes a silent decision instead of an exception.

## Development

Install dependencies with `npm ci`, then run the Vitest suite:

```bash
npm test
```

The suite currently contains 121 Vitest tests. To inspect runtime event decisions while using OpenCode, run:

```bash
ODIN_VOICE_DEBUG=1 opencode
```

## License

MIT. See [LICENSE](LICENSE).
