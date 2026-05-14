(function spotifyLiveLyricsBridge() {
    const EXTENSION_ID = "spotify-live-lyrics-bridge";
    const STORAGE_KEY = `${EXTENSION_ID}:latest`;
    const SETTINGS_KEY = `${EXTENSION_ID}:settings`;
    const DEFAULT_ENDPOINT = "http://127.0.0.1:8974/lyrics";
    const LYRICS_BASE_URL = "https://spclient.wg.spotify.com/color-lyrics/v2/track/";
    const WAIT_DELAY_MS = 300;
    const EMIT_COOLDOWN_MS = 200;

    const STATE = {
        emitTimer: 0,
        lastFingerprint: "",
        lastEmitAt: 0,
        endpoint: DEFAULT_ENDPOINT,
        lyricsCache: Object.create(null),
        latestPayload: null
    };

    function waitForSpicetify() {
        if (!Spicetify?.Player || !Spicetify?.LocalStorage || !Spicetify?.CosmosAsync) {
            window.setTimeout(waitForSpicetify, WAIT_DELAY_MS);
            return;
        }

        init();
    }

    function getLocalStorageValue(key) {
        const storage = Spicetify?.LocalStorage;
        if (!storage) {
            return null;
        }

        if (typeof storage.get === "function") {
            return storage.get(key);
        }
        if (typeof storage.getItem === "function") {
            return storage.getItem(key);
        }
        return null;
    }

    function setLocalStorageValue(key, value) {
        const storage = Spicetify?.LocalStorage;
        if (!storage) {
            return false;
        }

        if (typeof storage.set === "function") {
            storage.set(key, value);
            return true;
        }
        if (typeof storage.setItem === "function") {
            storage.setItem(key, value);
            return true;
        }
        return false;
    }

    function loadSettings() {
        try {
            const raw = getLocalStorageValue(SETTINGS_KEY);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Failed to load settings`, error);
            return {};
        }
    }

    function notify(message) {
        if (!message) {
            return;
        }

        if (typeof Spicetify?.showNotification === "function") {
            Spicetify.showNotification(message);
            return;
        }

        if (typeof Spicetify?.Snackbar?.display === "function") {
            Spicetify.Snackbar.display(message);
            return;
        }

        console.log(`[${EXTENSION_ID}] ${message}`);
    }

    function normalizeText(value) {
        return String(value || "")
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/["']/g, "")
            .replace(/\([^)]*\)/g, " ")
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
    }

    function getCurrentTrack() {
        const item = Spicetify.Player.data?.item;
        if (!item) {
            return null;
        }

        const title = String(item.name || "").trim();
        const artists = Array.isArray(item.artists)
            ? item.artists.map((artist) => String(artist?.name || "").trim()).filter(Boolean)
            : [];

        return {
            title: title || "Unknown title",
            artists,
            album: String(item.album?.name || "").trim(),
            uri: String(item.uri || "").trim(),
            durationMs: Number(item.duration?.milliseconds || 0)
        };
    }

    function getPlaybackState() {
        return {
            isPlaying: !Boolean(Spicetify.Player.data?.isPaused),
            progressMs: Number(Spicetify.Player.getProgress?.() || 0),
            durationMs: Number(Spicetify.Player.getDuration?.() || 0)
        };
    }

    function parseTrackId(track) {
        const uri = String(track?.uri || "");
        const parts = uri.split(":");
        return parts.length >= 3 ? parts[2] : "";
    }

    function finalizeLyricsLines(lines) {
        for (let index = 0; index < lines.length; index += 1) {
            const nextLine = lines[index + 1];
            lines[index].endTimeMs = nextLine ? nextLine.startTimeMs : null;
        }

        return lines;
    }

    async function fetchLyricsState(track) {
        if (!track?.uri) {
            return {
                ok: false,
                provider: "spotify-color-lyrics",
                syncType: "NONE",
                lines: [],
                error: "No active track."
            };
        }

        if (STATE.lyricsCache[track.uri]) {
            return STATE.lyricsCache[track.uri];
        }

        const trackId = parseTrackId(track);
        if (!trackId) {
            const invalidTrack = {
                ok: false,
                provider: "spotify-color-lyrics",
                syncType: "NONE",
                lines: [],
                error: "Could not parse Spotify track ID."
            };
            STATE.lyricsCache[track.uri] = invalidTrack;
            return invalidTrack;
        }

        try {
            const body = await Spicetify.CosmosAsync.get(
                `${LYRICS_BASE_URL}${trackId}?format=json&vocalRemoval=false&market=from_token`
            );

            const lyricsData = body?.lyrics;
            if (!lyricsData) {
                const emptyLyrics = {
                    ok: false,
                    provider: "spotify-color-lyrics",
                    syncType: "NONE",
                    lines: [],
                    error: "Spotify returned no lyrics payload."
                };
                STATE.lyricsCache[track.uri] = emptyLyrics;
                return emptyLyrics;
            }

            const rawLines = Array.isArray(lyricsData.lines) ? lyricsData.lines : [];
            const lines = finalizeLyricsLines(
                rawLines
                    .map((line, index) => {
                        const text = String(line?.words || "").replace(/\s+/g, " ").trim();
                        return {
                            index,
                            text,
                            normalized: normalizeText(text),
                            startTimeMs: Number(line?.startTimeMs || 0),
                            endTimeMs: null
                        };
                    })
                    .filter((line) => line.text)
            );

            const syncType = String(lyricsData.syncType || "UNKNOWN");
            const lyricsState = {
                ok: syncType === "LINE_SYNCED" && lines.length > 0,
                provider: "spotify-color-lyrics",
                syncType,
                lines,
                language: String(lyricsData.language || ""),
                error: syncType === "LINE_SYNCED"
                    ? (lines.length ? "" : "Spotify returned no synced lyric lines.")
                    : `Unsupported sync type: ${syncType}`
            };

            STATE.lyricsCache[track.uri] = lyricsState;
            return lyricsState;
        } catch (error) {
            const failedLyrics = {
                ok: false,
                provider: "spotify-color-lyrics",
                syncType: "ERROR",
                lines: [],
                error: error?.message || String(error)
            };
            STATE.lyricsCache[track.uri] = failedLyrics;
            return failedLyrics;
        }
    }

    function pickCurrentLyric(lyricsState, playback) {
        const lines = lyricsState?.lines || [];
        const progressMs = Number(playback?.progressMs || 0);
        if (!lines.length || progressMs < 0) {
            return null;
        }

        let currentIndex = -1;
        for (let index = 0; index < lines.length; index += 1) {
            if (progressMs >= lines[index].startTimeMs) {
                currentIndex = index;
                continue;
            }
            break;
        }

        if (currentIndex < 0) {
            return null;
        }

        const line = lines[currentIndex];
        return {
            text: line.text,
            normalized: line.normalized,
            index: line.index,
            confidence: 1,
            startTimeMs: line.startTimeMs,
            endTimeMs: line.endTimeMs
        };
    }

    function getVisibleLines(lyricsState, lyric) {
        const lines = lyricsState?.lines || [];
        if (!lines.length) {
            return [];
        }

        const currentIndex = Number.isInteger(lyric?.index) ? lyric.index : 0;
        const startIndex = Math.max(0, currentIndex - 1);
        const endIndex = Math.min(lines.length, currentIndex + 2);
        return lines.slice(startIndex, endIndex).map((line) => line.text);
    }

    async function buildPayload() {
        const track = getCurrentTrack();
        const playback = getPlaybackState();
        const lyricsState = await fetchLyricsState(track);
        const lyric = lyricsState.ok ? pickCurrentLyric(lyricsState, playback) : null;
        const visibleLines = getVisibleLines(lyricsState, lyric);

        return {
            timestamp: new Date().toISOString(),
            track,
            playback,
            lyric,
            visibleLines,
            lyricsMeta: {
                provider: lyricsState.provider,
                syncType: lyricsState.syncType,
                lineCount: lyricsState.lines.length,
                language: lyricsState.language || "",
                error: lyricsState.error || ""
            },
            source: EXTENSION_ID
        };
    }

    function serializePayload(payload) {
        return JSON.stringify({
            trackUri: payload.track?.uri || "",
            progressMs: payload.playback?.progressMs || 0,
            line: payload.lyric?.normalized || "",
            syncType: payload.lyricsMeta?.syncType || "",
            lineCount: payload.lyricsMeta?.lineCount || 0,
            error: payload.lyricsMeta?.error || ""
        });
    }

    function saveLatestPayload(payload) {
        try {
            setLocalStorageValue(STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Failed to cache payload`, error);
        }
    }

    function exposeGlobal() {
        window.spotifyLiveLyricsBridge = {
            getLatest() {
                return STATE.latestPayload;
            },
            getCachedLyrics(trackUri) {
                return trackUri ? STATE.lyricsCache[trackUri] || null : STATE.lyricsCache;
            },
            forceEmit() {
                return emitLatestLyrics(true);
            }
        };
    }

    async function pushToBridge(payload) {
        try {
            const response = await fetch(STATE.endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Bridge responded with HTTP ${response.status}`);
            }
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Bridge push failed`, error);
        }
    }

    async function emitLatestLyrics(force = false) {
        const payload = await buildPayload();
        const fingerprint = serializePayload(payload);
        const now = Date.now();

        if (!force) {
            if (fingerprint === STATE.lastFingerprint) {
                return;
            }

            if (now - STATE.lastEmitAt < EMIT_COOLDOWN_MS) {
                scheduleEmit();
                return;
            }
        }

        STATE.lastFingerprint = fingerprint;
        STATE.lastEmitAt = now;
        STATE.latestPayload = payload;
        saveLatestPayload(payload);
        exposeGlobal();
        await pushToBridge(payload);
    }

    function scheduleEmit(force = false) {
        window.clearTimeout(STATE.emitTimer);
        STATE.emitTimer = window.setTimeout(() => {
            emitLatestLyrics(force).catch((error) => {
                console.warn(`[${EXTENSION_ID}] Failed to emit lyric payload`, error);
            });
        }, 25);
    }

    function handleSongChange() {
        scheduleEmit(true);
    }

    function handleProgress() {
        scheduleEmit(false);
    }

    function handlePlayPause() {
        scheduleEmit(true);
    }

    function init() {
        const settings = loadSettings();
        STATE.endpoint = String(settings.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;

        exposeGlobal();
        Spicetify.Player.addEventListener("songchange", handleSongChange);
        Spicetify.Player.addEventListener("onprogress", handleProgress);
        Spicetify.Player.addEventListener("onplaypause", handlePlayPause);
        scheduleEmit(true);

        notify("spotify-live-lyrics-bridge loaded");
    }

    waitForSpicetify();
})();
