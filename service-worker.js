const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const HANDLED = ["START_WORLD_AUDIO", "STOP_WORLD_AUDIO", "SET_WORLD", "SET_STEM", "SET_MOTION", "RESET_WORLD", "GET_STATE",
  "ASSISTANT_ASK", "ASSISTANT_STOP_SPEECH", "PRESET_LOAD", "UNDO", "STREAM_CONNECT", "STREAM_DISCONNECT",
  "MANUAL_CREATE_OFFER", "MANUAL_CREATE_ANSWER", "MANUAL_APPLY_ANSWER",
  "VIDEO_SYNC_ENABLE", "VIDEO_SYNC_NOW", "VIDEO_SYNC_STATE", "VIDEO_SYNC_RECEIVED", "SOUND_LOCATOR_ASK"];
const DEFAULT_MODEL = "gemini-2.5-flash";
// Free-tier limits are per model, so when one is busy the assistant quietly tries the next.
const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

// Clicking the toolbar icon opens the side panel. This is done in a real click handler, not with
// openPanelOnActionClick: only a real click (or the keyboard shortcut) grants the extension
// "activeTab" on the current tab, and Chrome refuses to capture a tab's audio without it.
const panelBehavior = () => chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(() => {});
panelBehavior();
chrome.runtime.onInstalled.addListener(panelBehavior);
chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({windowId: tab.windowId}); }
  catch { try { await chrome.sidePanel.open({tabId: tab.id}); } catch {} }
});

// Keyboard shortcut (Alt+Shift+W by default): open the panel and start listening.
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "talk") return;
  try { if (tab?.windowId) await chrome.sidePanel.open({windowId: tab.windowId}); } catch {}
  setTimeout(() => chrome.runtime.sendMessage({type: "HOTKEY_TALK"}).catch(() => {}), 600);
});

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  return contexts.some(c => c.contextType === "OFFSCREEN_DOCUMENT" && c.documentUrl === OFFSCREEN_URL);
}

async function ensureOffscreen() {
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Process captured tab audio through the World Audio spatial audio prototype."
    });
  }
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({target: "offscreen", ...msg});

async function getState() {
  if (!(await hasOffscreen())) return null;
  const r = await toOffscreen({type: "GET_STATE"});
  return r?.state || null;
}

// =====================================================================================
// AI assistant (Google Gemini, free tier). The key is the user's own, from Google AI Studio.
// =====================================================================================
const SOUNDS = ["bass", "body", "voice", "midL", "midR", "presence", "air", "ambience"];
const GROUPS = {mids: ["midL", "midR"]};
const expand = (s) => s === "all" ? SOUNDS : GROUPS[s] || (SOUNDS.includes(s) ? [s] : []);
const SCENE_IDS = ["living", "hall", "club", "studio", "theater", "arena", "festival", "car", "bathroom", "garage", "warehouse", "bedroom", "free"];
const ROOM_IDS = ["none", "studio", "living", "club", "hall", "cathedral", "bedroom", "bathroom", "car", "garage", "warehouse", "theater", "arena", "stadium", "tunnel", "openair"];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const PI = Math.PI;

// ---------- geometry (the same maths the audio engine uses) ----------
// Where a sound sits in the room, in world coordinates (x right, z back, stage at -z).
function sceneXZ(state, st) {
  const az = st.azimuth * PI / 180;
  const d = Math.max(1, st.distance + (Number(state.world.distanceOffset) || 0));
  return {x: Math.sin(az) * d, z: -Math.cos(az) * d};
}
function clampListener(state, x, z) {
  const g = state.roomGeom;
  if (g && g.w > 0) return [clamp(x, -g.w / 2 + 0.3, g.w / 2 - 0.3), clamp(z, -g.ly * g.h + 0.3, (1 - g.ly) * g.h - 0.3)];
  return [clamp(x, -12, 12), clamp(z, -12, 12)];
}
function bearingWords(b) {
  const a = Math.abs(b), side = b > 0 ? "right" : "left";
  if (a < 12) return "straight ahead";
  if (a > 168) return "directly behind you";
  if (a < 35) return `ahead, a little to your ${side}`;
  if (a < 75) return `ahead and to your ${side}`;
  if (a < 105) return `to your ${side}`;
  if (a < 145) return `behind and to your ${side}`;
  return `behind you, a little to your ${side}`;
}
// How far a sound is from the listener, and in which direction (0 = ahead, positive = right).
function measure(state, st) {
  const w = state.world, p = sceneXZ(state, st);
  let rx = p.x, rz = p.z;
  if (w.worldLock) {
    const dx = p.x - w.listenerX, dz = p.z - w.listenerZ, y = w.listenerYaw * PI / 180, c = Math.cos(y), s = Math.sin(y);
    rx = dx * c + dz * s; rz = -dx * s + dz * c;
  }
  const dist = Math.hypot(rx, rz);
  const b = Math.round(Math.atan2(rx, -rz) * 180 / PI);
  const clock = ((Math.round(b / 30) % 12) + 12) % 12 || 12;
  return {distanceM: +dist.toFixed(1), distanceFt: Math.round(dist * 3.281), bearingDeg: b, clock: `${clock} o'clock`, where: bearingWords(b)};
}
function soundRows(state) {
  return state.stems.map(s => ({
    id: s.id, heardAs: s.label, ...measure(state, s),
    loudness: +s.level.toFixed(3), volumePct: Math.round(s.volume * 100), muted: s.mute, solo: s.solo
  }));
}
const describeMotion = (m) => m && `${m.kind} ${m.around === "listener" ? "around the listener" : "around the stage"}, one cycle every ${m.period}s`;

// ---------- mix analysis ----------
function analyzeMix(state) {
  const all = state.stems;
  const tot = all.reduce((s, x) => s + (x.slow || 0), 0);
  if (tot < 0.0008) return {ok: true, quiet: true, hints: ["The audio is silent or very quiet right now (paused, or between sounds). Ask the user to play the video."]};
  const share = (id) => Math.round(((all.find(s => s.id === id)?.slow || 0) / tot) * 100);
  const bands = all.filter(s => s.id !== "ambience" && (s.slow || 0) > 0.0003);
  const avgCorr = bands.length ? bands.reduce((s, x) => s + (x.corr ?? 1), 0) / bands.length : 1;
  const punchy = all.filter(s => s.id !== "ambience" && (s.punch || 0) > 0.55).map(s => s.id);
  const sharePct = Object.fromEntries(SOUNDS.map(id => [id, share(id)]));
  const hints = [];
  const mids = sharePct.midL + sharePct.midR;
  if (sharePct.voice + mids + sharePct.presence >= 70 && sharePct.bass < 12) hints.push("Mostly midrange with very little bass: most likely speech (podcast, talk, tutorial, vlog).");
  if (sharePct.voice >= 40) hints.push("A strong centred signal (lead vocal or speech) carries a large part of the mix.");
  if (mids >= 25 && avgCorr < 0.85) hints.push("Wide guitars, keys or synths fill the left and right.");
  if (sharePct.bass + sharePct.body >= 55) hints.push("Low-end heavy: likely electronic, hip-hop or club music.");
  if (sharePct.air >= 12) hints.push("Plenty of high-frequency detail (cymbals, hiss, sparkle).");
  if (sharePct.ambience >= 20) hints.push("Strong side/ambience content: wide stereo or a live room recording.");
  if (avgCorr > 0.92 && sharePct.ambience < 8) hints.push("Nearly mono: everything sits in the middle, so the placement does most of the work.");
  else if (avgCorr < 0.55) hints.push("Very wide or phasey stereo.");
  if (punchy.length >= 2) hints.push("Strong rhythmic hits: drums or percussion are prominent.");
  if (!hints.length) hints.push("Balanced full-range mix, nothing stands out.");
  return {
    ok: true, sharePct, avgStereoCorrelation: +avgCorr.toFixed(2), punchySounds: punchy,
    perSound: all.map(s => ({id: s.id, panLeftRight: +(s.pan || 0).toFixed(2), correlation: +(s.corr ?? 1).toFixed(2)})),
    hints, note: "Rough estimates from eight signal-processing splits, not real instrument detection. panLeftRight: negative = left, positive = right."
  };
}

// ---------- saved setups, undo ----------
const presetKey = (n) => String(n || "").trim().toLowerCase().slice(0, 40);
async function getPresets() { return (await chrome.storage.local.get("waPresets")).waPresets || {}; }

// Everything needed to put the room back exactly as it is now.
function captureSetup(state) {
  const w = state.world;
  return {
    world: {scene: w.scene, room: w.room, vocalSplit: w.vocalSplit, auto: w.auto, spread: w.spread, reverb: w.reverb, volume: w.volume, sway: w.sway,
      worldLock: w.worldLock, distanceOffset: w.distanceOffset, listenerX: w.listenerX, listenerZ: w.listenerZ, listenerYaw: w.listenerYaw},
    stems: state.stems.map(s => ({id: s.id, azimuth: s.azimuth, distance: s.distance, volume: s.volume, mute: s.mute, solo: s.solo,
      manual: s.manual, motion: s.motion || null}))
  };
}

async function applySetup(p) {
  const w = p.world, world = (patch) => toOffscreen({type: "SET_WORLD", patch});
  await toOffscreen({type: "SET_MOTION", id: "all", spec: null});
  // Scene first (it re-seats you and releases every sound), then room, then everything else.
  await world({scene: w.scene});
  await world({room: w.room});
  await world({vocalSplit: w.vocalSplit, auto: w.auto, spread: w.spread, reverb: w.reverb, volume: w.volume, sway: w.sway, worldLock: w.worldLock,
    distanceOffset: w.distanceOffset, listenerX: w.listenerX, listenerZ: w.listenerZ, listenerYaw: w.listenerYaw});
  for (const s of p.stems) {
    const patch = {volume: s.volume, mute: s.mute, solo: s.solo};
    if (s.manual || !w.auto) { patch.azimuth = s.azimuth; patch.distance = s.distance; }
    patch.manual = !!s.manual;
    await toOffscreen({type: "SET_STEM", id: s.id, patch});
  }
  for (const s of p.stems) if (s.motion) await toOffscreen({type: "SET_MOTION", id: s.id, spec: s.motion});
}

async function savePreset(state, name) {
  const key = presetKey(name);
  if (!key) return {error: "Give the setup a name."};
  const presets = await getPresets();
  if (!presets[key] && Object.keys(presets).length >= 20) return {error: "20 setups are saved already. Delete one first."};
  presets[key] = {name: String(name).trim().slice(0, 40), ...captureSetup(state)};
  await chrome.storage.local.set({waPresets: presets});
  return {ok: true, saved: presets[key].name};
}

async function loadPreset(name) {
  const presets = await getPresets();
  const key = presetKey(name);
  const hit = presets[key] ? key : Object.keys(presets).find(k => k.includes(key) || key.includes(k));
  if (!hit) {
    const names = Object.values(presets).map(p => p.name);
    return {error: names.length ? `No saved setup called "${name}". Saved: ${names.join(", ")}` : "No setups are saved yet."};
  }
  await applySetup(presets[hit]);
  return {ok: true, loaded: presets[hit].name};
}

// The room is snapshotted once before the assistant's first change in a turn, so "undo" can put it back.
async function pushUndo(state, label) {
  const {waUndo = []} = await chrome.storage.local.get("waUndo");
  waUndo.push({at: Date.now(), label: String(label || "").slice(0, 60), setup: captureSetup(state)});
  await chrome.storage.local.set({waUndo: waUndo.slice(-12)});
}
async function doUndo() {
  if (!(await hasOffscreen())) return {error: "World Audio isn't running."};
  const {waUndo = []} = await chrome.storage.local.get("waUndo");
  const last = waUndo.pop();
  if (!last) return {error: "Nothing to undo."};
  await chrome.storage.local.set({waUndo});
  await applySetup(last.setup);
  return {ok: true, undid: last.label || "the last change", stepsLeft: waUndo.length};
}

// ---------- what the assistant knows about the user and the video ----------
async function getPrefs() { return (await chrome.storage.local.get("waPrefs")).waPrefs || []; }
async function videoTitle() {
  try {
    const {waTab} = await chrome.storage.local.get("waTab");
    if (!waTab) return null;
    const t = await chrome.tabs.get(waTab);
    const title = String(t.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/i, "").trim();
    return title || null;
  } catch { return null; }
}

const S = (type, description, extra = {}) => ({type, description, ...extra});
// Note: Gemini rejects an OBJECT schema with no properties, so tools without arguments simply omit `parameters`.
const TOOLS = [{functionDeclarations: [
  {name: "set_scene", description: "Move the listener to a scene (also sets that scene's room and puts every sound back under AI placement).",
    parameters: {type: "OBJECT", properties: {scene: S("STRING", "Scene id", {enum: SCENE_IDS})}, required: ["scene"]}},
  {name: "set_room", description: "Change only the room acoustics, keeping the current scene.",
    parameters: {type: "OBJECT", properties: {room: S("STRING", "Room id", {enum: ROOM_IDS})}, required: ["room"]}},
  {name: "place_sound", description: "Pin one sound at a spot (this also stops it moving). By default direction and distance are measured from the stage centre (the default seat): 0 degrees = straight ahead, positive = right, negative = left, 180 = behind, distance in metres (1-12). Set relative_to_listener=true for requests like 'put the guitar on my left, 3 metres away', which measures from where the listener is standing and facing right now.",
    parameters: {type: "OBJECT", properties: {
      sound: S("STRING", "Which sound", {enum: SOUNDS}),
      direction_deg: S("NUMBER", "-180 to 180"),
      distance_m: S("NUMBER", "1 to 12"),
      relative_to_listener: S("BOOLEAN", "Measure from the listener instead of the stage centre")}, required: ["sound"]}},
  {name: "move_sound", description: "Make a sound move continuously (sound=mids moves both guitar/keys channels). kinds: orbit (circle around a centre), sweep (swing left and right), pulse (glide toward and away), figure8 (trace a figure of eight), stop (freeze it where it is). By default the centre is the listener, so 'circle me' = orbit. The sound starts from where it is now and keeps moving until stopped, until duration_s runs out, or until it is dragged or placed. Use sound=all to move everything together (each keeps its own position in the ring).",
    parameters: {type: "OBJECT", properties: {
      sound: S("STRING", "Which sound", {enum: [...SOUNDS, "mids", "all"]}),
      kind: S("STRING", "Motion type", {enum: ["orbit", "sweep", "pulse", "figure8", "stop"]}),
      around: S("STRING", "Centre of the motion: listener (default; angles are measured from the way they face) or stage", {enum: ["listener", "stage"]}),
      period_s: S("NUMBER", "Seconds for one full cycle, 3 to 120. Default 12. Smaller = faster."),
      direction: S("STRING", "Orbit/figure-8 direction", {enum: ["clockwise", "anticlockwise"]}),
      radius_m: S("NUMBER", "Size of the orbit, sweep or figure-8 in metres (1-12). Default keeps the sound's current distance."),
      from_deg: S("NUMBER", "Sweep start angle, -180 to 180 (0 ahead, positive right). Default -50"),
      to_deg: S("NUMBER", "Sweep end angle. Default 50"),
      direction_deg: S("NUMBER", "Pulse: the direction it glides along. Default keeps its current direction"),
      near_m: S("NUMBER", "Pulse: closest distance (default 40% of the current distance)"),
      far_m: S("NUMBER", "Pulse: furthest distance"),
      duration_s: S("NUMBER", "Stop moving automatically after this many seconds")}, required: ["sound", "kind"]}},
  {name: "set_sound", description: "Change a sound's volume, mute or solo. sound=mids changes both guitar/keys channels.",
    parameters: {type: "OBJECT", properties: {
      sound: S("STRING", "Which sound", {enum: [...SOUNDS, "mids"]}),
      volume_percent: S("NUMBER", "0 to 150, 100 is normal"),
      mute: S("BOOLEAN", "Mute or unmute"),
      solo: S("BOOLEAN", "Solo or unsolo")}, required: ["sound"]}},
  {name: "unpin_sound", description: "Hand a pinned or moving sound back to AI auto-placement. Use sound=all to release everything.",
    parameters: {type: "OBJECT", properties: {sound: S("STRING", "Sound id, mids or all", {enum: [...SOUNDS, "mids", "all"]})}, required: ["sound"]}},
  {name: "where_is", description: "Measure how far each sound is from the listener right now and in which direction. Use sound=all for everything.",
    parameters: {type: "OBJECT", properties: {sound: S("STRING", "Sound id, mids or all", {enum: [...SOUNDS, "mids", "all"]})}, required: ["sound"]}},
  {name: "analyze_mix", description: "Report how the audio energy is spread over the eight sounds, how wide the stereo is, how punchy it is, plus rough hints about the kind of content playing (speech, electronic, live band...). Use it before choosing a scene or when asked what the audio is like."},
  {name: "go_to_spot", description: "Teleport the listener to one of the named spots listed in the current state.",
    parameters: {type: "OBJECT", properties: {spot: S("STRING", "Spot id from the state, e.g. seat, singer, band, back")}, required: ["spot"]}},
  {name: "go_to_sound", description: "Walk the listener up next to a sound and turn to face it.",
    parameters: {type: "OBJECT", properties: {
      sound: S("STRING", "Which sound", {enum: SOUNDS}),
      stop_distance_m: S("NUMBER", "How close to stand, 0.5 to 6 metres (default 1)"),
      face: S("BOOLEAN", "Turn to face it (default true)")}, required: ["sound"]}},
  {name: "face_sound", description: "Turn the listener to face a sound without moving.",
    parameters: {type: "OBJECT", properties: {sound: S("STRING", "Which sound", {enum: SOUNDS})}, required: ["sound"]}},
  {name: "walk", description: "Walk the listener relative to where they are facing. Positive forward = ahead, positive right = to their right.",
    parameters: {type: "OBJECT", properties: {forward_m: S("NUMBER", "metres forward (negative = backward)"), right_m: S("NUMBER", "metres right (negative = left)")}}},
  {name: "turn", description: "Turn the listener. 0 = facing the stage, 180 = facing away from it.",
    parameters: {type: "OBJECT", properties: {degrees: S("NUMBER", "-180 to 180"), relative: S("BOOLEAN", "true = add to current facing, false (default) = absolute")}, required: ["degrees"]}},
  {name: "set_world", description: "Change master settings. Only include the fields that should change.",
    parameters: {type: "OBJECT", properties: {
      stage_width_percent: S("NUMBER", "0 to 100"),
      reverb_percent: S("NUMBER", "0 to 150"),
      master_volume_percent: S("NUMBER", "0 to 150"),
      push_away_m: S("NUMBER", "0 to 8, extra distance added to every sound"),
      world_lock: S("BOOLEAN", "On = sounds stay fixed in the room when you turn or walk"),
      auto_placement: S("BOOLEAN", "AI auto-placement on/off"),
      head_sway: S("BOOLEAN", "Natural head sway on/off"),
      vocal_separation_percent: S("NUMBER", "0 to 100: how much of the centred lead vocal is lifted out of the instruments so it can be moved on its own. Default 80"),
      speaker_mode: S("BOOLEAN", "On = milder placement for speakers (no headphone 3D effect, rear sounds folded to the front)")}}},
  {name: "start_headphone_check", description: "Open the headphone check in the panel: it plays a beep in each ear and the user says what they heard. The result switches speaker mode on or off automatically. Use it when the user asks whether they are on headphones, or says the 3D effect isn't working."},
  {name: "reset_world", description: "Reset everything to the default living room."},
  {name: "undo", description: "Revert the assistant's most recent change (can be repeated to go further back)."},
  {name: "save_preset", description: "Save the current setup (scene, room, listener position, every sound's placement, motion and volume) under a name.",
    parameters: {type: "OBJECT", properties: {name: S("STRING", "Short name, e.g. 'front row' or 'my mix'")}, required: ["name"]}},
  {name: "load_preset", description: "Restore a saved setup by name.",
    parameters: {type: "OBJECT", properties: {name: S("STRING", "Name of the saved setup")}, required: ["name"]}},
  {name: "list_presets", description: "List the saved setups."},
  {name: "delete_preset", description: "Delete a saved setup.",
    parameters: {type: "OBJECT", properties: {name: S("STRING", "Name of the saved setup")}, required: ["name"]}},
  {name: "remember", description: "Store a lasting preference or fact about the user (one short sentence) so it is remembered in future sessions, e.g. 'Likes the bass turned down' or 'Usually listens to live concerts in the hall'.",
    parameters: {type: "OBJECT", properties: {note: S("STRING", "The preference, one short sentence")}, required: ["note"]}},
  {name: "forget_preferences", description: "Forget stored preferences: those containing the given text, or everything when match is 'all'.",
    parameters: {type: "OBJECT", properties: {match: S("STRING", "Text to match, or 'all'")}, required: ["match"]}}
]}];

// Tools that only look or save; the room is not snapshotted for undo before these.
const READ_ONLY = new Set(["start_headphone_check", "where_is", "analyze_mix", "list_presets", "save_preset", "delete_preset", "remember", "forget_preferences", "undo"]);

const SYSTEM_PROMPT = `You are the voice assistant inside "World Audio", a Chrome extension that captures a YouTube tab's audio, splits it into 8 sounds and places each one in a virtual 3D room that the listener can walk around in.

The eight sounds are signal-processing splits, not AI-separated instruments:
- bass (20-160 Hz): bass guitar, kick drum, sub bass
- body (160-700 Hz): low instruments, toms, warmth, lower piano/guitar
- voice: the LEAD VOCAL (or the speaker, in speech). It is the centre of the stereo picture between 200 Hz and 5.5 kHz, lifted out of the instruments. Other things panned dead centre in that range (snare, upper bass notes) can leak into it a little.
- midL and midR (700-3500 Hz): guitars, keys, synths and other mid-range instruments, kept as the real left and real right channel so a wide mix keeps its width. Together they are "mids".
- presence (3.5-8 kHz): consonants, snare, detail, guitar bite
- air (8-20 kHz): cymbals, shimmer, sparkle
- ambience: the left-minus-right "room" signal, sits behind the listener
Map what the user says onto these ("drums" = bass + presence + air, sometimes body for toms; "vocals", "the singer" or "the speaker" = voice; "guitar", "keys" or "synth" = mids, which is midL and midR; "crowd" or "room" = ambience). Say briefly when it is an approximation. The vocal separation setting (set_world) controls how much of the vocal is lifted out of the band: higher makes the singer easier to move on its own.

Scenes: living, hall (concert hall), club, studio (sounds in a ring around you), theater, arena, festival (open air), car, bathroom, garage (garage band), warehouse (party), bedroom, free (no room). Rooms (acoustics only, set_room): none, studio, living, club, hall, cathedral, bedroom, bathroom, car, garage, warehouse, theater, arena, stadium, tunnel, openair. Coordinates: x is right, z is back, the stage is at negative z. Direction 0 is straight ahead, positive is right.

What you can do:
- Move the listener: go_to_spot, go_to_sound, face_sound, walk, turn.
- Place sounds: place_sound (relative_to_listener for "on my left"), set_sound for volume, mute and solo, unpin_sound.
- Make sounds MOVE: move_sound with orbit (circle), sweep (left and right), pulse (in and out) or figure8. "Circle me" is an orbit around the listener. Fast is a period of 4-6 s, normal 10-14 s, slow 20-30 s. You can make several calls in one turn (for example everything rotating slowly). kind=stop freezes a sound where it is.
- Shape the room: set_scene, set_room, set_world.
- Understand: where_is measures distances; analyze_mix reports how the energy is spread over the bands, the stereo width and the punch, with rough hints about the kind of content playing. The video title in the state is a strong clue too.
- Check the listening setup: start_headphone_check opens the headphone test in the panel (the user presses Play and answers). The state shows speakerMode; when it is true the user is on speakers, so keep placements gentle and don't promise sounds behind them.
- Remember: save_preset, load_preset, list_presets, delete_preset for whole setups; remember for lasting personal preferences; undo reverts your last change.

How to behave:
- Each sound in the state has distanceFromYouM, bearingFromYouDeg, clock and where, measured from where the listener stands and faces right now (0 degrees = ahead, positive = right). stageDirectionDeg and stageDistanceM are measured from the stage centre, which is what place_sound uses unless relative_to_listener is true. For "how far is X" or "where is X", answer from the state in metres (feet only if asked) and plain direction words, for example "about 3 metres away, to your left". Distances are inside the virtual room, not real-world. If you moved anything earlier in the same turn, call where_is for fresh numbers.
- When asked to set up, improve or "make it sound good" for the video, combine evidence: the video title, analyze_mix and the current state. Then act in one turn (scene, room, placement, volumes, motion if it suits) and say briefly what you chose and why. Never invent facts about the audio; use the tools.
- Respect the stored preferences below unless the user says otherwise. Call remember only when the user states a lasting preference or asks you to remember something.
- Words like "again", "more", "a bit less", "the other one" and "that one" refer to the previous turn: use the chat history and the current state. A bit means roughly 10-15 percent, a lot 30-50 percent. Volume 100 percent is normal.
- If the user says it sounds worse, or asks to put it back, call undo.
- Moving sounds are pinned while they move. If the user drags one or you place it, it stops moving.

Use the tools to do what the user asks, then confirm in ONE or TWO short sentences. Your reply may be spoken aloud, so use plain words: no markdown, lists or emoji. If the user is just chatting or asking how something works, answer briefly without calling tools. If the request is ambiguous, pick the most sensible reading and say what you did. If World Audio is not running, tell them to open a YouTube video and press Start World Audio.`;

function describeState(state, extra = {}) {
  const ctx = {video: extra.video || undefined, preferences: extra.prefs?.length ? extra.prefs : undefined};
  if (!state?.active) return JSON.stringify({running: false, note: "World Audio is NOT running right now (no audio is being captured).", ...ctx});
  const w = state.world;
  const rows = soundRows(state);
  const audible = rows.filter(r => !r.muted);
  const byDist = [...audible].sort((a, b) => a.distanceM - b.distanceM);
  const nearest = byDist[0], farthest = byDist[byDist.length - 1];
  const loudest = [...audible].sort((a, b) => b.loudness - a.loudness)[0];
  return JSON.stringify({
    running: true, ...ctx,
    scene: w.scene, room: w.room, aiAutoPlacement: w.auto, worldLock: w.worldLock,
    listener: {x: +w.listenerX.toFixed(2), z: +w.listenerZ.toFixed(2), facingDeg: Math.round(w.listenerYaw)},
    stageWidthPct: Math.round(w.spread * 100), reverbPct: Math.round(w.reverb * 100),
    masterVolumePct: Math.round(w.volume * 100), vocalSeparationPct: Math.round((w.vocalSplit ?? 0.8) * 100), speakerMode: !!w.speakerMode, pushAwayM: w.distanceOffset, headSway: w.sway,
    room_size_m: {width: state.roomGeom.w, depth: state.roomGeom.h},
    spotsInThisScene: state.spots.map(s => ({id: s.id, name: s.name})),
    nearestSound: nearest?.id, farthestSound: farthest?.id, loudestSound: loudest?.id,
    sounds: state.stems.map((s, i) => ({
      id: s.id, heardAs: s.label,
      distanceFromYouM: rows[i].distanceM, distanceFromYouFt: rows[i].distanceFt,
      bearingFromYouDeg: rows[i].bearingDeg, clock: rows[i].clock, where: rows[i].where,
      stageDirectionDeg: Math.round(s.azimuth), stageDistanceM: +s.distance.toFixed(1),
      volumePct: rows[i].volumePct, muted: s.mute, solo: s.solo,
      placedBy: s.motion ? "moving" : s.manual ? "user/assistant (pinned)" : "AI",
      moving: describeMotion(s.motion) || undefined, loudness: rows[i].loudness
    }))
  });
}

async function runTool(name, a = {}) {
  // These work even when the audio isn't running.
  if (name === "list_presets") return {ok: true, presets: Object.values(await getPresets()).map(p => p.name)};
  if (name === "delete_preset") {
    const presets = await getPresets(), key = presetKey(a.name);
    const hit = presets[key] ? key : Object.keys(presets).find(k => k.includes(key) || key.includes(k));
    if (!hit) return {error: `No saved setup called "${a.name}".`};
    const gone = presets[hit].name;
    delete presets[hit];
    await chrome.storage.local.set({waPresets: presets});
    return {ok: true, deleted: gone};
  }
  if (name === "remember") {
    const note = String(a.note || "").trim().slice(0, 140);
    if (!note) return {error: "Nothing to remember."};
    const prefs = await getPrefs();
    if (!prefs.some(p => p.toLowerCase() === note.toLowerCase())) prefs.push(note);
    await chrome.storage.local.set({waPrefs: prefs.slice(-15)});
    return {ok: true, remembered: note};
  }
  if (name === "forget_preferences") {
    const m = String(a.match || "").trim().toLowerCase();
    const prefs = await getPrefs();
    const keep = m === "all" ? [] : prefs.filter(p => !p.toLowerCase().includes(m));
    await chrome.storage.local.set({waPrefs: keep});
    return {ok: true, forgot: prefs.length - keep.length};
  }
  if (name === "undo") return doUndo();
  if (name === "start_headphone_check") {
    chrome.runtime.sendMessage({type: "OPEN_HP_TEST"}).catch(() => {});
    return {ok: true, note: "The headphone check is open in the panel. The user needs to press Play and say what they heard."};
  }

  const state = await getState();
  if (!state?.active) return {error: "World Audio isn't running. Ask the user to open a YouTube video and press Start World Audio."};
  const world = (patch) => toOffscreen({type: "SET_WORLD", patch});
  const stem = (id, patch) => toOffscreen({type: "SET_STEM", id, patch});
  switch (name) {
    case "set_scene":
      if (!SCENE_IDS.includes(a.scene)) return {error: "Unknown scene."};
      await world({scene: a.scene});
      return {ok: true, scene: a.scene};
    case "set_room":
      if (!ROOM_IDS.includes(a.room)) return {error: "Unknown room."};
      await world({room: a.room});
      return {ok: true, room: a.room};
    case "place_sound": {
      if (a.sound === "mids") return {error: "Place midL and midR separately (for example one at -50 degrees and one at +50)."};
      if (!SOUNDS.includes(a.sound)) return {error: "Unknown sound."};
      const cur = state.stems.find(s => s.id === a.sound);
      const w = state.world;
      let patch;
      if (a.relative_to_listener && w.worldLock) {
        // Measured from where the listener stands and faces; convert to stage coordinates.
        const m = measure(state, cur);
        const b = num(a.direction_deg, m.bearingDeg) * PI / 180, d = clamp(num(a.distance_m, m.distanceM), 0.5, 12);
        const rx = Math.sin(b) * d, rz = -Math.cos(b) * d;
        const y = w.listenerYaw * PI / 180, c = Math.cos(y), s = Math.sin(y);
        const wx = w.listenerX + rx * c - rz * s, wz = w.listenerZ + rx * s + rz * c;
        patch = {
          azimuth: clamp(Math.round(Math.atan2(wx, -wz) * 180 / PI), -180, 180),
          distance: clamp(+(Math.hypot(wx, wz) - (Number(w.distanceOffset) || 0)).toFixed(1), 1, 12)
        };
      } else {
        patch = {
          azimuth: clamp(num(a.direction_deg, cur.azimuth), -180, 180),
          distance: clamp(num(a.distance_m, cur.distance), 1, 12)
        };
      }
      await stem(a.sound, patch);
      return {ok: true, sound: a.sound, ...patch, pinned: true};
    }
    case "move_sound": {
      const ids = expand(a.sound);
      if (!ids.length) return {error: "Unknown sound."};
      if (a.kind === "stop") {
        for (const id of ids) await toOffscreen({type: "SET_MOTION", id, spec: null});
        return {ok: true, stopped: ids, note: "They stay pinned where they stopped."};
      }
      if (!["orbit", "sweep", "pulse", "figure8"].includes(a.kind)) return {error: "Unknown motion. Use orbit, sweep, pulse, figure8 or stop."};
      const spec = {kind: a.kind, around: a.around === "stage" ? "stage" : "listener"};
      if (a.period_s !== undefined) spec.period = clamp(num(a.period_s, 12), 3, 120);
      if (a.direction) spec.dir = a.direction === "anticlockwise" ? -1 : 1;
      if (a.radius_m !== undefined) spec.radius = clamp(num(a.radius_m, 4), 1, 12);
      if (a.from_deg !== undefined) spec.fromDeg = clamp(num(a.from_deg, -50), -180, 180);
      if (a.to_deg !== undefined) spec.toDeg = clamp(num(a.to_deg, 50), -180, 180);
      if (a.direction_deg !== undefined) spec.deg = clamp(num(a.direction_deg, 0), -180, 180);
      if (a.near_m !== undefined) spec.nearM = clamp(num(a.near_m, 1.5), 1, 12);
      if (a.far_m !== undefined) spec.farM = clamp(num(a.far_m, 8), 1, 12);
      if (a.duration_s !== undefined) spec.duration = clamp(num(a.duration_s, 0), 0, 600);
      for (const id of ids) await toOffscreen({type: "SET_MOTION", id, spec});
      return {ok: true, moving: ids, ...spec, note: "These sounds are pinned while they move."};
    }
    case "set_sound": {
      const ids = expand(a.sound);
      if (!ids.length || a.sound === "all") return {error: "Unknown sound."};
      const patch = {};
      if (a.volume_percent !== undefined) patch.volume = clamp(num(a.volume_percent, 100), 0, 150) / 100;
      if (typeof a.mute === "boolean") patch.mute = a.mute;
      if (typeof a.solo === "boolean") patch.solo = a.solo;
      for (const id of ids) await stem(id, patch);
      return {ok: true, sound: a.sound, changed: ids, ...patch};
    }
    case "unpin_sound": {
      const ids = expand(a.sound);
      if (!ids.length) return {error: "Unknown sound."};
      for (const id of ids) await stem(id, {manual: false});
      if (a.sound === "all") await world({auto: true});
      return {ok: true, released: ids};
    }
    case "where_is": {
      const rows = soundRows(state);
      const want = a.sound && a.sound !== "all" ? expand(a.sound) : null;
      const pick = want ? rows.filter(r => want.includes(r.id)) : rows;
      if (!pick.length) return {error: "Unknown sound."};
      return {ok: true, sounds: pick.sort((p, q) => p.distanceM - q.distanceM)};
    }
    case "analyze_mix":
      return analyzeMix(state);
    case "go_to_spot": {
      const sp = state.spots.find(s => s.id === a.spot || s.name.toLowerCase() === String(a.spot).toLowerCase());
      if (!sp) return {error: `No spot "${a.spot}" here. Available: ${state.spots.map(s => s.id).join(", ")}`};
      await world({worldLock: true, listenerX: sp.x, listenerZ: sp.z, listenerYaw: sp.yaw});
      return {ok: true, spot: sp.name};
    }
    case "go_to_sound": {
      const st = state.stems.find(s => s.id === a.sound);
      if (!st) return {error: "Unknown sound."};
      const stop = clamp(num(a.stop_distance_m, 1), 0.5, 6), w = state.world, p = sceneXZ(state, st);
      // Stand on the line between the sound and where the listener is now.
      let ux = w.listenerX - p.x, uz = w.listenerZ - p.z;
      const len = Math.hypot(ux, uz);
      if (len < 1e-3) { ux = 0; uz = 1; } else { ux /= len; uz /= len; }
      const [x, z] = clampListener(state, p.x + ux * stop, p.z + uz * stop);
      const yaw = a.face === false ? Math.round(w.listenerYaw) : Math.round(Math.atan2(p.x - x, -(p.z - z)) * 180 / PI);
      await world({worldLock: true, listenerX: x, listenerZ: z, listenerYaw: yaw});
      return {ok: true, sound: st.id, nowAboutM: +Math.hypot(p.x - x, p.z - z).toFixed(1), facingDeg: yaw,
        note: st.motion ? "That sound is moving, so the distance will change." : "Position is limited by the room walls."};
    }
    case "face_sound": {
      const st = state.stems.find(s => s.id === a.sound);
      if (!st) return {error: "Unknown sound."};
      const w = state.world, p = sceneXZ(state, st);
      const yaw = Math.round(Math.atan2(p.x - w.listenerX, -(p.z - w.listenerZ)) * 180 / PI);
      await world({worldLock: true, listenerYaw: yaw});
      return {ok: true, sound: st.id, facingDeg: yaw};
    }
    case "walk": {
      const fw = clamp(num(a.forward_m), -20, 20), st = clamp(num(a.right_m), -20, 20);
      const y = state.world.listenerYaw * PI / 180;
      // Walk from where the listener is heading to, so back-to-back walks add up.
      const x = state.world.listenerX + Math.sin(y) * fw + Math.cos(y) * st;
      const z = state.world.listenerZ - Math.cos(y) * fw + Math.sin(y) * st;
      await world({worldLock: true, listenerX: x, listenerZ: z});
      return {ok: true, note: "Position is clamped to the room walls.", requestedFrom: {x: +state.world.listenerX.toFixed(1), z: +state.world.listenerZ.toFixed(1)}};
    }
    case "turn": {
      let yaw = num(a.degrees) + (a.relative ? state.world.listenerYaw : 0);
      yaw = ((yaw + 540) % 360) - 180;
      await world({worldLock: true, listenerYaw: yaw});
      return {ok: true, facingDeg: Math.round(yaw)};
    }
    case "set_world": {
      const p = {};
      if (a.stage_width_percent !== undefined) p.spread = clamp(num(a.stage_width_percent, 50), 0, 100) / 100;
      if (a.reverb_percent !== undefined) p.reverb = clamp(num(a.reverb_percent, 100), 0, 150) / 100;
      if (a.master_volume_percent !== undefined) p.volume = clamp(num(a.master_volume_percent, 100), 0, 150) / 100;
      if (a.push_away_m !== undefined) p.distanceOffset = clamp(num(a.push_away_m), 0, 8);
      if (typeof a.world_lock === "boolean") p.worldLock = a.world_lock;
      if (typeof a.auto_placement === "boolean") p.auto = a.auto_placement;
      if (typeof a.head_sway === "boolean") p.sway = a.head_sway;
      if (a.vocal_separation_percent !== undefined) p.vocalSplit = clamp(num(a.vocal_separation_percent, 80), 0, 100) / 100;
      if (typeof a.speaker_mode === "boolean") { p.speakerMode = a.speaker_mode; await chrome.storage.local.set({waSpeaker: a.speaker_mode}); }
      if (!Object.keys(p).length) return {error: "Nothing to change."};
      await world(p);
      return {ok: true, applied: p};
    }
    case "save_preset":
      return savePreset(state, a.name);
    case "load_preset":
      return loadPreset(a.name);
    case "reset_world":
      await toOffscreen({type: "RESET"});
      return {ok: true};
    default:
      return {error: `Unknown tool ${name}`};
  }
}

async function callGeminiOnce(key, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const b = {...body, generationConfig: {...body.generationConfig}};
  // A little thinking helps with multi-step requests; the lite model skips it to stay fast.
  if (/2\.5-flash/.test(model)) b.generationConfig.thinkingConfig = {thinkingBudget: /lite/.test(model) ? 0 : 256};
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json", "x-goog-api-key": key},
      body: JSON.stringify(b)
    });
  } catch {
    throw new Error("Couldn't reach Gemini. Check your internet connection.");
  }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    let text;
    if (res.status === 400 && /api key/i.test(msg)) text = "Gemini rejected the API key. Check it in the assistant settings.";
    else if (res.status === 403) text = "Gemini refused the request (403). The key may be wrong or not allowed for this model.";
    else if (res.status === 404) text = `Gemini doesn't know the model "${model}". Change it in the assistant settings.`;
    else if (res.status === 429) text = "Free Gemini limit reached for now. Wait a minute and try again.";
    else text = `Gemini error ${res.status}${msg ? ": " + msg.slice(0, 160) : ""}`;
    const err = new Error(text);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function callGemini(key, model, body) {
  const order = [model, ...FALLBACK_MODELS.filter(m => m !== model)];
  let first = null;
  for (const m of order) {
    try { return await callGeminiOnce(key, m, body); }
    catch (e) {
      first = first || e;
      if (![429, 500, 503].includes(e.status)) throw e;   // only busy/overloaded models fall back
    }
  }
  throw first;
}

async function askAssistant(text, speak) {
  const cfg = await chrome.storage.local.get(["geminiKey", "geminiModel", "waChat"]);
  const key = (cfg.geminiKey || "").trim();
  if (!key) throw new Error("Add your free Gemini API key in the assistant settings first.");
  const model = (cfg.geminiModel || DEFAULT_MODEL).trim();
  const chat = Array.isArray(cfg.waChat) ? cfg.waChat : [];

  // Earlier turns (text only) give the assistant memory of the conversation.
  const history = chat.filter(m => m.role === "user" || m.role === "model").slice(-10);
  while (history.length && history[0].role !== "user") history.shift();
  const contents = history.map(m => ({role: m.role, parts: [{text: m.text}]}));
  contents.push({role: "user", parts: [{text}]});

  const [state, video, prefs] = await Promise.all([getState(), videoTitle(), getPrefs()]);
  const body = {
    systemInstruction: {parts: [{text: `${SYSTEM_PROMPT}\n\nCurrent state of the world:\n${describeState(state, {video, prefs})}`}]},
    contents,
    tools: TOOLS,
    generationConfig: {temperature: 0.4, maxOutputTokens: 1000}
  };

  let reply = "", snapped = false;
  const actions = [];
  for (let round = 0; round < 8; round++) {
    const data = await callGemini(key, model, body);
    const cand = data.candidates?.[0];
    if (!cand?.content) {
      const why = data.promptFeedback?.blockReason || cand?.finishReason;
      throw new Error(why ? `Gemini didn't answer (${why}).` : "Gemini sent an empty answer. Try again.");
    }
    const parts = cand.content.parts || [];
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) {
      reply = parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      break;
    }
    contents.push(cand.content); // keep as-is (includes any thought signatures)
    const results = [];
    for (const p of calls) {
      const {name, args} = p.functionCall;
      let out;
      try {
        if (!snapped && !READ_ONLY.has(name)) {
          const s0 = await getState();
          if (s0?.active) { await pushUndo(s0, text); snapped = true; }
        }
        out = await runTool(name, args || {});
      } catch (e) { out = {error: e?.message || String(e)}; }
      actions.push({name, args, ok: !out.error});
      results.push({functionResponse: {name, response: out}});
    }
    contents.push({role: "user", parts: results});
  }
  if (!reply) reply = actions.length ? "Done." : "Sorry, I didn't catch that.";

  const next = [...chat, {role: "user", text}, {role: "model", text: reply}].slice(-30);
  await chrome.storage.local.set({waChat: next});
  if (speak) speakText(reply);
  return {reply, actions};
}

function speakText(text) {
  const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  chrome.tts.stop();
  const duck = (on) => toOffscreen({type: "SET_WORLD", patch: {duck: on}}).catch(() => {});
  const tell = (speaking) => chrome.runtime.sendMessage({type: "TTS_STATE", speaking}).catch(() => {});
  duck(true); tell(true);
  chrome.tts.speak(clean, {
    rate: 1.05,
    onEvent: (e) => { if (["end", "interrupted", "cancelled", "error"].includes(e.type)) { duck(false); tell(false); } }
  });
}

// =====================================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target || !HANDLED.includes(message.type)) return;
  (async () => {
    if (message.type === "ASSISTANT_ASK") {
      const text = String(message.text || "").trim().slice(0, 1000);
      if (!text) { sendResponse({ok: false, error: "Say or type something first."}); return; }
      try {
        sendResponse({ok: true, ...(await askAssistant(text, !!message.speak))});
      } catch (e) {
        sendResponse({ok: false, error: e?.message || String(e)});
      }
      return;
    }
    if (message.type === "PRESET_LOAD") {
      const st = await getState();
      if (!st?.active) { sendResponse({ok: false, error: "Start World Audio first, then load a saved setup."}); return; }
      const r = await loadPreset(message.name);
      sendResponse(r.error ? {ok: false, error: r.error} : {ok: true, loaded: r.loaded});
      return;
    }
    if (message.type === "UNDO") {
      const r = await doUndo();
      sendResponse(r.error ? {ok: false, error: r.error} : {ok: true, ...r});
      return;
    }
    if (message.type === "ASSISTANT_STOP_SPEECH") {
      chrome.tts.stop();
      if (await hasOffscreen()) toOffscreen({type: "SET_WORLD", patch: {duck: false}}).catch(() => {});
      sendResponse({ok: true});
      return;
    }
    if (message.type === "SOUND_LOCATOR_ASK") {
      const question = String(message.question || "").trim().slice(0, 500);
      if (!question) { sendResponse({ok:false,error:"Describe the sound you want located first."}); return; }
      try {
        const cfg = await chrome.storage.local.get(["geminiKey", "geminiModel"]);
        const key = String(cfg.geminiKey || "").trim();
        if (!key) { sendResponse({ok:false,error:"Add your Gemini API key in Assistant settings first."}); return; }
        const [stored] = await Promise.all([chrome.storage.local.get(["waVideoTab"])]);
        let tab = stored.waVideoTab ? await chrome.tabs.get(stored.waVideoTab).catch(() => null) : null;
        if (!tab || !/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || "")) {
          const active = await chrome.tabs.query({active:true,lastFocusedWindow:true});
          tab = active.find(t => /^https:\/\/(www\.)?youtube\.com\//.test(t.url || "")) || null;
        }
        if (!tab?.id || !tab.url) { sendResponse({ok:false,error:"Open a public YouTube video and try again."}); return; }
        let state = null;
        try { state = (await chrome.tabs.sendMessage(tab.id,{type:"WA_VIDEO_GET_STATE"}))?.state || null; } catch {}
        if (!state) { sendResponse({ok:false,error:"Reload the YouTube tab so World Audio can read the current playback timestamp, then try again."}); return; }
        const seconds = Number(state.currentTime || 0);
        const stamp = `${Math.floor(seconds/60).toString().padStart(2,"0")}:${Math.floor(seconds%60).toString().padStart(2,"0")}`;
        const videoUrl = tab.url.split("&t=")[0];
        const modelChoice = String(cfg.geminiModel || "").trim();
        const model = /^gemini-3\./i.test(modelChoice) ? modelChoice : "gemini-3.8-flash";
        const prompt = `Analyze the public YouTube video at ${videoUrl}. Focus on the moment at ${stamp} (${seconds.toFixed(1)} seconds). The user's question is: ${question}

Identify the likely sound source and where it appears to be relative to the visible scene or listener (left/right, foreground/background, on-screen/off-screen if supportable). Estimate apparent scene distance only as a broad range or near/mid/far category, and explain the audio/visual clues. Distinguish evidence from inference. If the sound or source cannot be confidently identified at this timestamp, say so and ask for a more precise timestamp or description. Do not invent an exact physical distance: movie mixing, camera perspective, compression, and unknown scene scale prevent reliable exact measurement from a video alone. Give a concise answer with: timestamp; likely source/location; apparent distance estimate with uncertainty; evidence; confidence.`;
        let response;
        try {
          response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
            method:"POST",
            headers:{"Content-Type":"application/json","x-goog-api-key":key},
            body:JSON.stringify({model, input:[{type:"video",uri:videoUrl},{type:"text",text:prompt}]})
          });
        } catch { sendResponse({ok:false,error:"Couldn't reach Gemini. Check your internet connection."}); return; }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = data?.error?.message || data?.message || "";
          const advice = response.status === 404 ? `The video-understanding model "${model}" is unavailable for this API key. Check the model in Assistant settings or try a supported Gemini video model.` : response.status === 403 ? "Gemini refused the request. Check that the API key is valid and allowed to use video understanding." : response.status === 429 ? "Gemini rate limit reached. Wait a little and try again." : `Gemini video analysis failed (${response.status}).`;
          sendResponse({ok:false,error:`${advice}${detail ? " " + String(detail).slice(0,180) : ""}`}); return;
        }
        let reply = String(data.output_text || data.outputText || "").trim();
        if (!reply && Array.isArray(data.output)) reply = data.output.map(x => x.text || x.content?.map?.(c => c.text || "").join(" ") || "").join("\n").trim();
        if (!reply && Array.isArray(data.steps)) reply = data.steps.filter(x => x.type === "model_output" || x.type === "text").map(x => x.text || x.content?.map?.(c => c.text || "").join(" ") || "").join("\n").trim();
        if (!reply) { sendResponse({ok:false,error:"Gemini returned no readable analysis. Try another supported model or timestamp."}); return; }
        sendResponse({ok:true,reply:`At ${stamp} · ${state?.title || tab.title || "YouTube video"}\n\n${reply}\n\nReminder: this is an AI estimate, not a calibrated physical distance measurement.`});
      } catch (e) {
        sendResponse({ok:false,error:e?.message || "Sound analysis failed."});
      }
      return;
    }
    if (message.type === "VIDEO_SYNC_ENABLE") {
      const [tab] = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if (!tab?.id || !/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || "")) {
        sendResponse({ok:false,error:"Open a YouTube video on this device first, then enable Video Sync."}); return;
      }
      try {
        const role = message.role === "receiver" ? "receiver" : "sender";
        await chrome.storage.local.set({waVideoTab:tab.id, waVideoRole:role});
        const result = await chrome.tabs.sendMessage(tab.id,{type:"WA_VIDEO_ENABLE",role});
        sendResponse(result || {ok:true,message:"Video sync enabled."});
      } catch(e) { sendResponse({ok:false,error:"Could not reach the YouTube page. Reload the YouTube tab and try again."}); }
      return;
    }
    if (message.type === "VIDEO_SYNC_NOW") {
      const {waVideoTab,waVideoRole} = await chrome.storage.local.get(["waVideoTab","waVideoRole"]);
      if (!waVideoTab || waVideoRole !== "sender") { sendResponse({ok:false,error:"Enable Video Sync as Main device on the host first."}); return; }
      try {
        const r = await chrome.tabs.sendMessage(waVideoTab,{type:"WA_VIDEO_GET_STATE"});
        if (!r?.state) { sendResponse({ok:false,error:"No YouTube video player was found."}); return; }
        if (!(await hasOffscreen())) { sendResponse({ok:false,error:"Start World Audio and complete WebRTC pairing first."}); return; }
        sendResponse(await toOffscreen({type:"VIDEO_SYNC_SEND",state:r.state}));
      } catch(e) { sendResponse({ok:false,error:"Could not read the host video state. Reload the YouTube tab and retry."}); }
      return;
    }
    if (message.type === "VIDEO_SYNC_STATE") {
      const {waVideoRole} = await chrome.storage.local.get("waVideoRole");
      if (waVideoRole === "sender" && await hasOffscreen()) toOffscreen({type:"VIDEO_SYNC_SEND",state:message.state}).catch(()=>{});
      sendResponse({ok:true}); return;
    }
    if (message.type === "VIDEO_SYNC_RECEIVED") {
      const {waVideoTab,waVideoRole} = await chrome.storage.local.get(["waVideoTab","waVideoRole"]);
      if (!waVideoTab || waVideoRole !== "receiver") { sendResponse({ok:false,error:"Enable Video Sync as Satellite on the receiving device."}); return; }
      try { sendResponse(await chrome.tabs.sendMessage(waVideoTab,{type:"WA_VIDEO_APPLY",state:message.state})); }
      catch(e) { sendResponse({ok:false,error:"Could not reach the receiver YouTube tab. Reload it and re-enable Video Sync."}); }
      return;
    }
    if (message.type === "STREAM_CONNECT") {
      await ensureOffscreen();
      try { sendResponse(await toOffscreen({type:"STREAM_CONNECT", role:message.role, server:message.server, room:message.room})); }
      catch(e) { sendResponse({ok:false,error:e?.message || String(e)}); }
      return;
    }
    if (message.type === "STREAM_DISCONNECT") {
      if (await hasOffscreen()) sendResponse(await toOffscreen({type:"STREAM_DISCONNECT"}));
      else sendResponse({ok:true});
      return;
    }
    if (["MANUAL_CREATE_OFFER", "MANUAL_CREATE_ANSWER", "MANUAL_APPLY_ANSWER"].includes(message.type)) {
      await ensureOffscreen();
      try { sendResponse(await toOffscreen({type:message.type, description:message.description})); }
      catch(e) { sendResponse({ok:false,error:e?.message || String(e)}); }
      return;
    }
    if (message.type === "START_WORLD_AUDIO") {
      const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
      if (!tab?.id || !/^https:\/\/(www\.)?youtube\.com\//.test(tab.url || "")) {
        sendResponse({ok: false, error: "Open a YouTube video tab first, then click Start World Audio."});
        return;
      }
      await ensureOffscreen();
      await toOffscreen({type: "STOP_CAPTURE"});
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: tab.id});
      } catch (e) {
        const msg = e?.message || String(e);
        sendResponse({ok: false, error: /invoked|activeTab/i.test(msg)
          ? "Chrome only lets World Audio capture a tab after you click its toolbar icon on that tab. Click the World Audio icon (or press Alt+Shift+W) while this YouTube tab is showing, then press Start World Audio again."
          : `Couldn't capture this tab: ${msg}`});
        return;
      }
      const started = await toOffscreen({type: "START_CAPTURE", streamId});
      if (started?.ok) {
        await chrome.storage.local.set({waTab: tab.id});
        const {waSpeaker} = await chrome.storage.local.get("waSpeaker");
        await toOffscreen({type: "SET_WORLD", patch: {speakerMode: !!waSpeaker}});
      }
      sendResponse(started?.ok ? started : {ok: false, error: started?.error || "The audio processor did not start."});
      return;
    }
    // Every other command only matters if the audio processor exists.
    if (!(await hasOffscreen())) {
      sendResponse({ok: true, state: null});
      return;
    }
    const map = {
      STOP_WORLD_AUDIO: {type: "STOP_CAPTURE"},
      SET_WORLD: {type: "SET_WORLD", patch: message.patch},
      SET_STEM: {type: "SET_STEM", id: message.id, patch: message.patch},
      SET_MOTION: {type: "SET_MOTION", id: message.id, spec: message.spec},
      RESET_WORLD: {type: "RESET"},
      GET_STATE: {type: "GET_STATE"}
    };
    const reply = await toOffscreen(map[message.type]);
    sendResponse(reply || {ok: true, state: null});
  })().catch(err => sendResponse({ok: false, error: err?.message || String(err)}));
  return true;
});
