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

3. Enable it in Spicetify:


4. Open Spotify and switch to a song that has synced lyrics.



## Notes

- The extension stores the latest payload in Spicetify LocalStorage under `spotify-live-lyrics-bridge:latest`.
- The bridge server mirrors the latest payload to `bridge/lyrics-current.json`, which is often the easiest thing for another script to read.
- The current line is computed from Spotify's synced lyric timestamps, so the lyrics panel does not need to be open.
- USE ON UR OWN RISK
