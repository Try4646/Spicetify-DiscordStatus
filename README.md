# spotify-live-lyrics-bridge

Spicetify extension that reads Spotify's synced lyrics feed, computes the current line from playback time, and exposes it to your own script through:

- `Spicetify.LocalStorage`
- `POST http://127.0.0.1:8974/lyrics`
- `GET http://127.0.0.1:8974/current`
- `bridge/lyrics-current.json`

## Files

- `src/spotify-live-lyrics-bridge.js`: Spicetify extension
- `bridge/lyrics_bridge_server.py`: tiny local bridge server
- `examples/read_current.py`: example client that prints lyric changes

## Install

1. Start the local bridge:

```powershell
py -3 .\bridge\lyrics_bridge_server.py
```

2. Deploy the extension:

```powershell
npm run deploy
```

3. Enable it in Spicetify:

```powershell
spicetify config extensions spotify-live-lyrics-bridge.js
spicetify apply
```

4. Open Spotify and switch to a song that has synced lyrics.

## Payload shape

```json
{
  "timestamp": "2026-05-13T19:23:42.123Z",
  "track": {
    "title": "Song Name",
    "artists": ["Artist"],
    "album": "Album",
    "uri": "spotify:track:...",
    "durationMs": 215000
  },
  "playback": {
    "isPlaying": true,
    "progressMs": 64218
  },
  "lyric": {
    "text": "current lyric line",
    "normalized": "current lyric line",
    "index": 4,
    "confidence": 0.91
  },
  "visibleLines": [
    "previous line",
    "current lyric line",
    "next line"
  ],
  "source": "spotify-live-lyrics-bridge"
}
```

## Notes

- The extension stores the latest payload in Spicetify LocalStorage under `spotify-live-lyrics-bridge:latest`.
- The bridge server mirrors the latest payload to `bridge/lyrics-current.json`, which is often the easiest thing for another script to read.
- The current line is computed from Spotify's synced lyric timestamps, so the lyrics panel does not need to be open.
