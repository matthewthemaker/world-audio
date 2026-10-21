const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const turn = $("turn"), lock = $("lock"), push = $("push"), autoBox = $("auto"), spread = $("spread");
const roomSel = $("room"), reverb = $("reverb"), volume = $("volume"), sway = $("sway");
const sAngle = $("sAngle"), sDist = $("sDist"), sVol = $("sVol");
const vsplit = $("vsplit"), speaker = $("speaker"), hpStatus = $("hpStatus");
const COLORS = {bass: "#e8738a", body: "#f0a35e", voice: "#8b93ff", midL: "#a8d86a", midR: "#6fb3ff", presence: "#5ed1c0", air: "#c58bff", ambience: "#8aa0b8"};

// Display catalog (the audio engine in offscreen.js is what actually defines each scene and room).
const SCENES_UI = [
  {id: "living", name: "Living room", room: "living", desc: "The band is playing in your living room, a few steps away."},
  {id: "hall", name: "Concert hall", room: "hall", desc: "Front-row seat. The stage is ahead of you, the hall rings around you."},
  {id: "club", name: "Small club", room: "club", desc: "Up close at a club show. Tight room, short echo, loud and near."},
  {id: "studio", name: "Studio", room: "studio", desc: "You're standing in the recording room, with the players in a ring around you."},
  {id: "theater", name: "Theatre", room: "theater", desc: "Row five of a theatre. Clear and warm, voices and strings sound close."},
  {id: "arena", name: "Arena", room: "arena", desc: "On the floor of an arena. Big, loud and echoey, with the stage far ahead."},
  {id: "festival", name: "Festival", room: "openair", desc: "In the crowd at an open-air festival. No walls, just a distant echo."},
  {id: "car", name: "Car", room: "car", desc: "Sitting in a car. Speakers around you at arm's length, tight and dry."},
  {id: "bathroom", name: "Bathroom", room: "bathroom", desc: "A little speaker on the sink with tile all round. Bright, splashy and close."},
  {id: "garage", name: "Garage band", room: "garage", desc: "A garage band practising. Hard concrete walls, loud and raw."},
  {id: "warehouse", name: "Warehouse", room: "warehouse", desc: "A warehouse party. Huge concrete space, heavy bass, a long wash of echo."},
  {id: "bedroom", name: "Bedroom", room: "bedroom", desc: "At your desk with speakers either side. Small, soft and intimate."},
  {id: "free", name: "Free", room: "none", desc: "No room. The AI follows the video's stereo picture, or you place everything."}
];
const ROOM_NAMES = {none: "No room (dry)", studio: "Recording studio", living: "Living room", club: "Small club", hall: "Concert hall", cathedral: "Cathedral",
  bedroom: "Bedroom", bathroom: "Bathroom (tiles)", car: "Car interior", garage: "Garage", warehouse: "Warehouse", theater: "Theatre",
  arena: "Arena", stadium: "Open stadium", tunnel: "Tunnel", openair: "Open air"};

let state = null, selected = "voice", busyUntil = 0, synced = false;
let masterBusyUntil = 0, lastMasterKey = "";
let uiScene = "living", uiRoom = "living";

const send = (msg) => (msg.type && msg.type.startsWith("STREAM_")
  ? chrome.runtime.sendMessage({target:"offscreen", ...msg})
  : chrome.runtime.sendMessage(msg)).catch(() => null);
function say(text) { statusEl.textContent = text; }
const busy = () => { busyUntil = Date.now() + 350; };

// ---------- scenes ----------
const sceneGrid = $("scenes");
for (const sc of SCENES_UI) {
  const b = document.createElement("button");
  b.dataset.scene = sc.id; b.textContent = sc.name;
  sceneGrid.appendChild(b);
}
for (const [id, name] of Object.entries(ROOM_NAMES)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = name;
  roomSel.appendChild(o);
}
function updateScene() {
  for (const b of sceneGrid.children) b.classList.toggle("on", b.dataset.scene === uiScene);
  $("sceneDesc").textContent = SCENES_UI.find(s => s.id === uiScene)?.desc || "";
  roomSel.value = uiRoom;
}
sceneGrid.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scene]");
  if (!b) return;
  uiScene = b.dataset.scene;
  uiRoom = SCENES_UI.find(s => s.id === uiScene).room;
  updateScene();
  if (state) {
    state.world.scene = uiScene; state.world.room = uiRoom;
    state.stems.forEach(s => { s.manual = false; });
  }
  send({type: "SET_WORLD", patch: {scene: uiScene, room: uiRoom}});
  render();
});
roomSel.addEventListener("input", () => {
  uiRoom = roomSel.value;
  if (state) state.world.room = uiRoom;
  send({type: "SET_WORLD", patch: {room: uiRoom}});
  render();
});

// ---------- master controls ----------
function updateWorldLabels() {
  $("turnVal").textContent = `${turn.value}°`;
  $("pushVal").textContent = `+${Number(push.value).toFixed(1)} m`;
  $("lockText").textContent = lock.checked ? "ON" : "OFF";
  $("autoText").textContent = autoBox.checked ? "ON" : "OFF";
  $("swayText").textContent = sway.checked ? "ON" : "OFF";
  $("spreadVal").textContent = `${spread.value}%`;
  $("reverbVal").textContent = `${reverb.value}%`;
  $("volumeVal").textContent = `${volume.value}%`;
  $("vsplitVal").textContent = `${vsplit.value}%`;
  $("speakerText").textContent = speaker.checked ? "ON" : "OFF";
}
function sendWorld() {
  masterBusyUntil = Date.now() + 700;
  updateWorldLabels();
  send({type: "SET_WORLD", patch: {
    listenerYaw: Number(turn.value), worldLock: lock.checked,
    distanceOffset: Number(push.value), auto: autoBox.checked, spread: Number(spread.value) / 100,
    reverb: Number(reverb.value) / 100, volume: Number(volume.value) / 100, sway: sway.checked,
    vocalSplit: Number(vsplit.value) / 100, speakerMode: speaker.checked,
    scene: uiScene, room: uiRoom
  }});
}
["turn", "lock", "push", "auto", "spread", "reverb", "volume", "sway", "vsplit", "speaker"].forEach(id => $(id).addEventListener("input", sendWorld));
speaker.addEventListener("input", () => chrome.storage.local.set({waSpeaker: speaker.checked}));

function syncMaster() {
  const w = state.world;
  turn.value = w.listenerYaw; lock.checked = w.worldLock; push.value = w.distanceOffset;
  autoBox.checked = w.auto; spread.value = Math.round(w.spread * 100);
  reverb.value = Math.round(w.reverb * 100); volume.value = Math.round(w.volume * 100); sway.checked = w.sway;
  vsplit.value = Math.round((w.vocalSplit ?? 0.8) * 100); speaker.checked = !!w.speakerMode;
  uiScene = w.scene; uiRoom = w.room;
  updateWorldLabels(); updateScene();
}

// ---------- start / stop / reset ----------
$("start").addEventListener("click", async () => {
  say("Starting audio capture…");
  try {
    const result = await send({type: "START_WORLD_AUDIO"});
    if (result?.ok) {
      const name = SCENES_UI.find(s => s.id === uiScene)?.name || "";
      say(`World Audio is running in the ${name.toLowerCase()} scene. The AI is placing each sound. Walk around with W A S D, or drag yourself on the map.`);
      sendWorld();
    } else {
      say(result?.error || "Could not start capture. Try reloading the extension.");
    }
  } catch (e) { say(`Error: ${e.message || e}`); }
});
$("stop").addEventListener("click", async () => {
  try {
    await send({type: "STOP_WORLD_AUDIO"});
    say("World Audio stopped. The tab's normal audio should resume.");
  } catch (e) { say(`Stop error: ${e.message || e}`); }
});
$("reset").addEventListener("click", async () => {
  turn.value = 0; push.value = 0; lock.checked = true; autoBox.checked = true; spread.value = 50;
  reverb.value = 100; volume.value = 100; sway.checked = true; vsplit.value = 80;
  uiScene = "living"; uiRoom = "living";
  updateWorldLabels(); updateScene();
  await send({type: "RESET_WORLD"});
  synced = false;
  say("World reset to the living room. AI auto-placement is on and every sound is back under its control.");
});

// ---------- sound list ----------
const list = $("stems");
function buildList() {
  list.innerHTML = "";
  for (const s of state.stems) {
    const row = document.createElement("div");
    row.className = "stem"; row.dataset.id = s.id;
    row.innerHTML = `<span class="dot" style="background:${COLORS[s.id]}"></span><span class="nm"></span><span class="dist"></span>` +
      `<span class="meter"><i style="background:${COLORS[s.id]}"></i></span>` +
      `<button class="mini" data-act="mute" title="Mute">M</button>` +
      `<button class="mini" data-act="solo" title="Solo">S</button>` +
      `<button class="mini" data-act="auto" title="AI-placed, or pinned where you put it"></button>`;
    list.appendChild(row);
  }
}
list.addEventListener("click", (e) => {
  const row = e.target.closest(".stem");
  if (!row || !state) return;
  const id = row.dataset.id, st = state.stems.find(s => s.id === id);
  const act = e.target.dataset?.act;
  if (act === "mute") { st.mute = !st.mute; send({type: "SET_STEM", id, patch: {mute: st.mute}}); }
  else if (act === "solo") { st.solo = !st.solo; send({type: "SET_STEM", id, patch: {solo: st.solo}}); }
  else if (act === "auto") { st.manual = !st.manual; send({type: "SET_STEM", id, patch: {manual: st.manual}}); }
  else { selected = id; busyUntil = 0; }
  render();
});

// ---------- selected sound sliders ----------
function sendStem(patch) {
  busy();
  const st = state?.stems.find(s => s.id === selected);
  if (st) {
    Object.assign(st, patch);
    if ("azimuth" in patch || "distance" in patch) st.manual = true;
  }
  send({type: "SET_STEM", id: selected, patch});
  render();
}
sAngle.addEventListener("input", () => sendStem({azimuth: Number(sAngle.value)}));
sDist.addEventListener("input", () => sendStem({distance: Number(sDist.value)}));
sVol.addEventListener("input", () => sendStem({volume: Number(sVol.value) / 100}));

// ---------- motion of the selected sound ----------
const mKind = $("mKind"), mPeriod = $("mPeriod");
function sendMotion() {
  busy(); busyUntil = Date.now() + 900;
  $("mPeriodVal").textContent = `${mPeriod.value} s`;
  const kind = mKind.value;
  send({type: "SET_MOTION", id: selected, spec: kind === "none" ? null : {kind, period: Number(mPeriod.value), around: "listener"}});
}
mKind.addEventListener("input", sendMotion);
mPeriod.addEventListener("input", () => { $("mPeriodVal").textContent = `${mPeriod.value} s`; busyUntil = Date.now() + 900; });
mPeriod.addEventListener("change", () => { if (mKind.value !== "none") sendMotion(); });
$("stopMotion").addEventListener("click", () => send({type: "SET_MOTION", id: "all", spec: null}));

// ---------- physical room mapper (best-effort device motion tracking) ----------
const mapNameEl = $("mapName"), mapStatus = $("mapStatus"), savedRoomsEl = $("savedRooms");
let mapActive = false, mapPoints = [], mapPosition = {x:0,z:0}, mapHeading = 0, lastStepAt = 0, motionBaseline = 0, motionReady = false, currentMapId = "";
let savedRoomMaps = [];
const mapButtons = () => { $("mapCorner").disabled = !mapActive; $("mapFinish").disabled = !mapActive || mapPoints.length < 3; $("mapCancel").disabled = !mapActive; };
function updateMapStatus(msg) { mapStatus.textContent = msg; }
async function loadRoomMaps() {
  const got = await chrome.storage.local.get("waRoomMaps"); savedRoomMaps = Array.isArray(got.waRoomMaps) ? got.waRoomMaps : [];
  const previous = savedRoomsEl.value; savedRoomsEl.replaceChildren();
  const empty = document.createElement("option"); empty.value = ""; empty.textContent = savedRoomMaps.length ? "Choose a saved room…" : "No saved maps yet"; savedRoomsEl.appendChild(empty);
  for (const m of savedRoomMaps) { const o = document.createElement("option"); o.value = m.id; o.textContent = `${m.name} (${m.points.length} corners)`; savedRoomsEl.appendChild(o); }
  if (savedRoomMaps.some(m => m.id === previous)) savedRoomsEl.value = previous;
  $("mapLoad").disabled = !savedRoomsEl.value; $("mapDelete").disabled = !savedRoomsEl.value;
}
savedRoomsEl.addEventListener("change", () => { $("mapLoad").disabled = !savedRoomsEl.value; $("mapDelete").disabled = !savedRoomsEl.value; });
function startRoomScan() {
  mapActive = true; mapPoints = []; mapPosition = {x:0,z:0}; mapHeading = 0; lastStepAt = 0; motionBaseline = 0; motionReady = false;
  currentMapId = ""; mapNameEl.value = mapNameEl.value.trim() || "My Room";
  mapButtons();
  updateMapStatus("Click an empty spot on the sound map for each room corner. Add at least three points, then finish and save.");
  render();
}
function addMapPointFromCanvas(p) {
  if (!mapActive) return;
  const w = fromScr(p.x, p.y, view());
  const point = {x:+w.x.toFixed(2), z:+w.z.toFixed(2)};
  const last = mapPoints[mapPoints.length-1];
  if (last && Math.hypot(point.x-last.x, point.z-last.z) < .35) {
    updateMapStatus("That point is too close to the previous corner. Click farther away."); return;
  }
  mapPoints.push(point); mapButtons();
  updateMapStatus(`Corner ${mapPoints.length} added on the map. Click the next corner; at least three are needed to save.`);
  render();
}
function markRoomCorner() {
  if (!mapActive) return;
  updateMapStatus("Click directly on the sound-map canvas to place each corner.");
}
function polygonDimensions(points) {
  const xs=points.map(p=>p.x), zs=points.map(p=>p.z), minX=Math.min(...xs), maxX=Math.max(...xs), minZ=Math.min(...zs), maxZ=Math.max(...zs);
  return {w:Math.max(2, +(maxX-minX).toFixed(1)), h:Math.max(2, +(maxZ-minZ).toFixed(1)), minX, minZ, maxX, maxZ};
}
async function finishRoomScan() {
  if (!mapActive || mapPoints.length < 3) return;
  const dims=polygonDimensions(mapPoints), id=`room-${Date.now()}`;
  const points=mapPoints.map(p=>({x:+(p.x-(dims.minX+dims.maxX)/2).toFixed(2),z:+(p.z-(dims.minZ+dims.maxZ)/2).toFixed(2)}));
  const room={id,name:mapNameEl.value.trim()||"My Room",points,w:dims.w,h:dims.h,createdAt:Date.now()};
  savedRoomMaps.push(room); currentMapId=id; mapPoints=points; await chrome.storage.local.set({waRoomMaps:savedRoomMaps}); mapActive=false; mapButtons();
  // Apply the measured room footprint to the existing spatial listener bounds; acoustic character remains the selected room preset.
  send({type:"SET_WORLD",patch:{customRoomGeom:{w:room.w,h:room.h,ly:.5}}});
  await loadRoomMaps(); savedRoomsEl.value=id; $("mapLoad").disabled=false; $("mapDelete").disabled=false;
  updateMapStatus(`Saved “${room.name}” (${room.w.toFixed(1)} m × ${room.h.toFixed(1)} m, ${points.length} corners). The outline is an estimate; acoustic reverb still uses your selected room preset.`); render();
}
$("mapStart").addEventListener("click", startRoomScan);
$("mapCorner").addEventListener("click", markRoomCorner);
$("mapFinish").addEventListener("click", finishRoomScan);
$("mapCancel").addEventListener("click",()=>{mapActive=false;mapPoints=[];mapButtons();updateMapStatus("Scan cancelled.");render();});
$("mapLoad").addEventListener("click",()=>{const m=savedRoomMaps.find(x=>x.id===savedRoomsEl.value);if(!m)return;currentMapId=m.id;send({type:"SET_WORLD",patch:{customRoomGeom:{w:m.w,h:m.h,ly:.5},listenerX:0,listenerZ:0,snap:true}});mapPoints=m.points;updateMapStatus(`Loaded “${m.name}” (${m.w.toFixed(1)} m × ${m.h.toFixed(1)} m).`);render();});
$("mapDelete").addEventListener("click",async()=>{const id=savedRoomsEl.value;savedRoomMaps=savedRoomMaps.filter(m=>m.id!==id);await chrome.storage.local.set({waRoomMaps:savedRoomMaps});if(currentMapId===id){currentMapId="";send({type:"SET_WORLD",patch:{customRoomGeom:null}});}await loadRoomMaps();updateMapStatus("Room map deleted.");render();});
// Device orientation gives heading; acceleration peaks estimate steps. This is intentionally approximate, not survey-grade.
window.addEventListener("deviceorientation",e=>{if(!mapActive)return;const a=Number.isFinite(e.alpha)?e.alpha:null;if(a!==null)mapHeading=(360-a)*Math.PI/180;},{passive:true});
window.addEventListener("devicemotion",e=>{if(!mapActive)return;const a=e.accelerationIncludingGravity;if(!a)return;const mag=Math.hypot(a.x||0,a.y||0,a.z||0);if(!motionReady){motionBaseline=mag;motionReady=true;return;}motionBaseline=motionBaseline*.88+mag*.12;const now=Date.now();if(Math.abs(mag-motionBaseline)>1.25 && now-lastStepAt>320){lastStepAt=now;const stride=.62;mapPosition.x+=Math.sin(mapHeading)*stride;mapPosition.z-=Math.cos(mapHeading)*stride;}},{passive:true});
loadRoomMaps();

// ---------- radar ----------
const cv = $("radar"), g = cv.getContext("2d");
let W = 298, H = 226, R = 104;
const dpr = window.devicePixelRatio || 1;
// The map fills the width of the side panel and stays sharp at any size.
function resizeCanvas() {
  const w = Math.max(260, Math.min(620, Math.floor(document.body.clientWidth - 32)));
  if (w === W && cv.width === Math.round(W * dpr)) return;
  W = w; H = Math.round(w * 0.76); R = H * 0.46;
  cv.style.width = W + "px"; cv.style.height = H + "px";
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas();
new ResizeObserver(resizeCanvas).observe(document.body);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let dots = {}, youPos = null, dragStem = null, dragYou = false, dragPos = null;

// World coordinates: x = right, z = back (the stage is at negative z). The map is zoomed to fit the room.
function view() {
  const gm = state?.roomGeom;
  if (gm && gm.w > 0) return {s: clamp(Math.min((W - 24) / gm.w, (H - 24) / gm.h), 2.5, 28), zc: (1 - 2 * gm.ly) * gm.h / 2};
  return {s: R / 12, zc: 0};
}
const toScr = (x, z, v) => ({x: W / 2 + x * v.s, y: H / 2 + (z - v.zc) * v.s});
const fromScr = (px, py, v) => ({x: (px - W / 2) / v.s, z: (py - H / 2) / v.s + v.zc});
function clampPos(x, z) {
  const gm = state?.roomGeom;
  if (gm && gm.w > 0) return {x: clamp(x, -gm.w / 2 + .3, gm.w / 2 - .3), z: clamp(z, -gm.ly * gm.h + .3, (1 - gm.ly) * gm.h - .3)};
  return {x: clamp(x, -12, 12), z: clamp(z, -12, 12)};
}
function effD(st) { return Math.max(1, st.distance + (state.world.distanceOffset || 0)); }
function stemWorld(st) {
  const a = st.azimuth * Math.PI / 180, d = effD(st);
  return {x: Math.sin(a) * d, z: -Math.cos(a) * d};
}
// How far a sound is from you right now, and which way (0 = ahead, positive = right).
function relInfo(st) {
  const w = stemWorld(st), wd = state.world;
  let rx = w.x, rz = w.z;
  if (wd.worldLock) {
    const dx = w.x - wd.listenerX, dz = w.z - wd.listenerZ, y = wd.listenerYaw * Math.PI / 180, c = Math.cos(y), s = Math.sin(y);
    rx = dx * c + dz * s; rz = -dx * s + dz * c;
  }
  return {d: Math.hypot(rx, rz), b: Math.round(Math.atan2(rx, -rz) * 180 / Math.PI)};
}
function bearingText(b) {
  const a = Math.abs(b);
  if (a < 12) return "straight ahead";
  if (a > 168) return "behind you";
  return `${a}° ${b > 0 ? "right" : "left"}`;
}
function ensureLock() {
  if (lock.checked) return;
  lock.checked = true;
  sendWorld();
  say("World Lock turned on so you can walk around.");
}

function drawRadar() {
  g.clearRect(0, 0, W, H);
  const v = view(), gm = state?.roomGeom;
  if (state?.active && gm && gm.w > 0) {
    const tl = toScr(-gm.w / 2, -gm.ly * gm.h, v);
    g.fillStyle = "rgba(139,147,255,0.06)";
    g.strokeStyle = "#3a4562"; g.lineWidth = 1.5; g.setLineDash([5, 4]);
    g.beginPath();
    if (g.roundRect) g.roundRect(tl.x, tl.y, gm.w * v.s, gm.h * v.s, 8); else g.rect(tl.x, tl.y, gm.w * v.s, gm.h * v.s);
    g.fill(); g.stroke(); g.setLineDash([]);
    g.fillStyle = "#6f7b92"; g.font = "10px system-ui, sans-serif"; g.textAlign = "left";
    g.fillText(ROOM_NAMES[state.world.room] || "", 5, H - 3);
  }
  const o = toScr(0, 0, v);
  g.strokeStyle = "#262d3d"; g.lineWidth = 1;
  for (const m of [4, 8, 12]) { g.beginPath(); g.arc(o.x, o.y, m * v.s, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = "#6f7b92"; g.font = "10px system-ui, sans-serif"; g.textAlign = "center";
  g.fillText("front", W / 2, 10);
  g.textAlign = "left"; g.fillText("L", 4, H / 2 - 4); g.textAlign = "right"; g.fillText("R", W - 4, H / 2 - 4);

  if (!state || !state.active) {
    g.fillStyle = "#8a96ab"; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("Start World Audio to see the sounds", W / 2, H / 2 + 4);
    dots = {}; youPos = null;
    return;
  }

  // Saved/current room outline. Coordinates use the same metres as the spatial map.
  const outline = mapActive ? mapPoints : (savedRoomMaps.find(m=>m.id===currentMapId)?.points || []);
  if (outline.length > 1) {
    g.save(); const pts=outline.map(p=>toScr(p.x,p.z,v));
    g.beginPath(); g.moveTo(pts[0].x,pts[0].y); for(let i=1;i<pts.length;i++)g.lineTo(pts[i].x,pts[i].y);
    if(outline.length>=3) { g.lineTo(pts[0].x,pts[0].y); if(!mapActive) g.closePath(); }
    g.strokeStyle="#5ed1c0";g.lineWidth=2;g.setLineDash(mapActive?[5,4]:[]);g.stroke();g.setLineDash([]);
    pts.forEach((p,i)=>{g.fillStyle="#5ed1c0";g.beginPath();g.arc(p.x,p.y,4,0,Math.PI*2);g.fill();g.fillStyle="#10131a";g.font="9px system-ui";g.textAlign="center";g.fillText(String(i+1),p.x,p.y+3);});g.restore();
  }
  dots = {};
  for (const st of state.stems) {
    const w = stemWorld(st), p = toScr(w.x, w.z, v);
    dots[st.id] = p;
    const rad = 5 + Math.min(1, Math.sqrt(st.level) * 2.2) * 6;
    const silent = st.mute || (state.stems.some(s => s.solo) && !st.solo);
    g.globalAlpha = silent ? 0.3 : 1;
    g.fillStyle = COLORS[st.id];
    g.beginPath(); g.arc(p.x, p.y, rad, 0, Math.PI * 2); g.fill();
    if (st.manual || st.id === selected) {
      g.lineWidth = st.id === selected ? 2.5 : 1.5;
      g.strokeStyle = st.id === selected ? "#ffffff" : "#e6c46e";
      g.beginPath(); g.arc(p.x, p.y, rad + 2, 0, Math.PI * 2); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // you: the white arrow (position + which way you face)
  const lockOn = state.world.worldLock;
  const lx = lockOn ? state.world.listenerX : 0, lz = lockOn ? state.world.listenerZ : 0;
  youPos = toScr(lx, lz, v);
  g.save(); g.translate(youPos.x, youPos.y);
  g.rotate((lockOn ? state.world.listenerYaw : 0) * Math.PI / 180);
  g.fillStyle = "#f2f4f8"; g.strokeStyle = "#10131a"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 7); g.lineTo(0, 3.5); g.lineTo(-7, 7); g.closePath(); g.stroke(); g.fill();
  g.restore();

  // measuring line from you to the selected sound
  const sd = dots[selected], sst = state.stems.find(s => s.id === selected);
  if (sd && sst) {
    const label = `${relInfo(sst).d.toFixed(1)} m`;
    g.save();
    g.strokeStyle = "rgba(242,244,248,0.45)"; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(youPos.x, youPos.y); g.lineTo(sd.x, sd.y); g.stroke(); g.setLineDash([]);
    const mx = (youPos.x + sd.x) / 2, my = (youPos.y + sd.y) / 2;
    g.font = "10px system-ui, sans-serif"; g.textAlign = "center";
    const tw = g.measureText(label).width + 8;
    g.fillStyle = "rgba(16,19,26,0.85)"; g.fillRect(mx - tw / 2, my - 9, tw, 14);
    g.fillStyle = "#f2f4f8"; g.fillText(label, mx, my + 2);
    g.restore();
  }
}

function canvasPt(e) {
  const b = cv.getBoundingClientRect();
  return {x: (e.clientX - b.left) * (W / b.width), y: (e.clientY - b.top) * (H / b.height)};
}
function moveDot(p) {
  const st = state?.stems.find(s => s.id === dragStem);
  if (!st) return;
  const w = fromScr(p.x, p.y, view());
  const az = Math.round(Math.atan2(w.x, -w.z) * 180 / Math.PI);
  const eff = clamp(Math.hypot(w.x, w.z), 1, 12);
  const dist = clamp(Math.round((eff - (state.world.distanceOffset || 0)) * 10) / 10, 1, 12);
  sendStem({azimuth: az, distance: dist});
}
function moveYou(p) {
  const w = fromScr(p.x, p.y, view());
  const c = clampPos(w.x, w.z);
  dragPos = c;
  state.world.listenerX = c.x; state.world.listenerZ = c.z;
  send({type: "SET_WORLD", patch: {listenerX: c.x, listenerZ: c.z}});
}
cv.addEventListener("pointerdown", (e) => {
  if (!state?.active) return;
  const p = canvasPt(e);
  if (mapActive) { addMapPointFromCanvas(p); return; }
  let best = null, bd = 20, isYou = false;
  for (const [id, d] of Object.entries(dots)) {
    const dist = Math.hypot(d.x - p.x, d.y - p.y);
    if (dist < bd) { bd = dist; best = id; }
  }
  if (youPos) {
    const dy = Math.hypot(youPos.x - p.x, youPos.y - p.y) * 0.7; // slight priority for grabbing yourself
    if (dy < Math.min(bd, 16)) { isYou = true; }
  }
  if (isYou) {
    ensureLock();
    dragYou = true; cv.setPointerCapture(e.pointerId); cv.style.cursor = "grabbing"; moveYou(p);
    return;
  }
  if (!best) return;
  selected = best; dragStem = best;
  cv.setPointerCapture(e.pointerId);
  cv.style.cursor = "grabbing";
  moveDot(p);
});
cv.addEventListener("pointermove", (e) => {
  if (dragStem) moveDot(canvasPt(e));
  else if (dragYou) moveYou(canvasPt(e));
});
const endDrag = () => { dragStem = null; dragYou = false; dragPos = null; cv.style.cursor = "grab"; };
cv.addEventListener("pointerup", endDrag);
cv.addEventListener("pointercancel", endDrag);

// ---------- go-to spots ----------
const spotsEl = $("spots");
let spotsKey = "";
function renderSpots() {
  const sp = state?.spots || [];
  const key = sp.map(s => `${s.id}${s.x}${s.z}`).join("|");
  if (key === spotsKey) return;
  spotsKey = key;
  spotsEl.innerHTML = "";
  for (const s of sp) {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.id = s.id; b.textContent = s.name;
    spotsEl.appendChild(b);
  }
}
spotsEl.addEventListener("click", (e) => {
  const b = e.target.closest("button.chip");
  const s = b && state?.spots.find(x => x.id === b.dataset.id);
  if (!s) return;
  ensureLock();
  masterBusyUntil = Date.now() + 700;
  turn.value = s.yaw; updateWorldLabels();
  send({type: "SET_WORLD", patch: {listenerX: s.x, listenerZ: s.z, listenerYaw: s.yaw}});
});

// ---------- walking with the keyboard ----------
const keys = new Set();
document.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  const typing = e.target.matches?.("input[type=text], input[type=password], textarea");
  if (k.length === 1 && "wasdqe".includes(k) && e.target.tagName !== "SELECT" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    keys.add(k); e.preventDefault();
  }
});
document.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear());
let lastT = performance.now(), walk = null;
setInterval(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!state?.active || !keys.size) { walk = null; return; }
  ensureLock();
  let yaw = Number(turn.value);
  if (keys.has("q")) yaw -= 90 * dt;
  if (keys.has("e")) yaw += 90 * dt;
  yaw = ((yaw + 540) % 360) - 180;
  const fw = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
  const st = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
  masterBusyUntil = Date.now() + 700;
  if (!walk) walk = {x: state.world.listenerX, z: state.world.listenerZ};
  const y = yaw * Math.PI / 180, speed = 1.6 * dt;
  walk.x += (Math.sin(y) * fw + Math.cos(y) * st) * speed;
  walk.z += (-Math.cos(y) * fw + Math.sin(y) * st) * speed;
  const c = clampPos(walk.x, walk.z);
  walk.x = c.x; walk.z = c.z;
  turn.value = yaw; updateWorldLabels();
  send({type: "SET_WORLD", patch: {listenerX: c.x, listenerZ: c.z, listenerYaw: yaw}});
}, 33);

// ---------- render ----------
function render() {
  drawRadar();
  renderSpots();
  if (!state) return;
  if (!list.children.length) buildList();
  $("stopMotion").hidden = !state.stems.some(s => s.motion);
  const anySolo = state.stems.some(s => s.solo);
  for (const row of list.children) {
    const st = state.stems.find(s => s.id === row.dataset.id);
    if (!st) continue;
    row.classList.toggle("sel", st.id === selected);
    row.querySelector(".nm").textContent = st.label + (st.motion ? "  ↻" : "");
    row.querySelector(".dist").textContent = state.active ? `${relInfo(st).d.toFixed(1)} m` : "";
    row.querySelector(".meter i").style.width = `${Math.min(100, Math.sqrt(st.level) * 220)}%`;
    const [m, s, a] = row.querySelectorAll("button");
    m.className = "mini" + (st.mute ? " warn" : "");
    s.className = "mini" + (st.solo ? " on" : "");
    a.className = "mini" + (st.manual ? " pin" : " on");
    a.textContent = st.manual ? "Pinned" : "AI";
    row.style.opacity = (st.mute || (anySolo && !st.solo)) ? 0.5 : 1;
  }
  const st = state.stems.find(s => s.id === selected);
  if (!st) return;
  $("detailName").textContent = st.label;
  if (state.active) {
    const ri = relInfo(st);
    $("distLine").textContent = `From you: ${ri.d.toFixed(1)} m (${(ri.d * 3.281).toFixed(0)} ft) · ${bearingText(ri.b)}`;
  } else $("distLine").textContent = "";
  if (Date.now() > busyUntil && !dragStem) {
    sAngle.value = Math.round(st.azimuth); sDist.value = st.distance; sVol.value = Math.round(st.volume * 100);
    mKind.value = st.motion?.kind || "none";
    if (st.motion) mPeriod.value = Math.min(60, Math.round(st.motion.period));
  }
  $("mPeriodVal").textContent = `${mPeriod.value} s`;
  $("sAngleVal").textContent = `${Math.round(st.azimuth)}°`;
  $("sDistVal").textContent = `${st.distance.toFixed(1)} m`;
  $("sVolVal").textContent = `${Math.round(st.volume * 100)}%`;
}

async function poll() {
  const r = await send({type: "GET_STATE"});
  const prev = state;
  state = r?.state || null;
  if (state && dragStem && prev) {
    // keep the dragged dot under the pointer until the audio side catches up
    const a = prev.stems.find(s => s.id === dragStem), b = state.stems.find(s => s.id === dragStem);
    if (a && b) { b.azimuth = a.azimuth; b.distance = a.distance; b.manual = true; }
  }
  if (state && dragYou && dragPos) { state.world.listenerX = dragPos.x; state.world.listenerZ = dragPos.z; }
  if (state && !synced) { syncMaster(); synced = true; }
  // The assistant can change the world behind the popup's back. Pull those changes into the
  // controls (otherwise the next slider move would send stale values and undo them).
  if (state && synced && Date.now() > masterBusyUntil && !keys.size && !dragYou) {
    const w = state.world;
    const key = JSON.stringify([w.auto, w.spread, w.reverb, w.volume, w.sway, w.worldLock, w.distanceOffset,
      w.scene, w.room, Math.round(w.listenerYaw), w.vocalSplit, w.speakerMode]);
    if (key !== lastMasterKey) {
      lastMasterKey = key;
      syncMaster();
    }
  }
  render();
  setTimeout(poll, 100);
}
// ---------- AI assistant (Gemini) ----------
const chatEl = $("chat"), askText = $("askText"), micBtn = $("mic"), askBtn = $("ask");
const keyIn = $("geminiKey"), modelIn = $("geminiModel"), speakBox = $("speakReply");
let localChat = [], pending = false, errorMsg = "", lastActs = "", voiceTurn = false;
const PLACEHOLDER = "Try: put me next to the singer";

function renderChat() {
  chatEl.innerHTML = "";
  const add = (cls, text) => {
    const d = document.createElement("div");
    d.className = `msg ${cls}`; d.textContent = text;
    chatEl.appendChild(d);
    return d;
  };
  if (!localChat.length && !pending && !errorMsg) {
    add("hint", "Ask me to move you around, rebalance the sounds, or change the room. Add your free Gemini key in Assistant settings to begin.");
  }
  localChat.forEach((m, i) => {
    add(m.role === "user" ? "me" : "ai", m.text);
    if (lastActs && i === localChat.length - 1) {
      const a = document.createElement("div");
      a.className = "acts"; a.textContent = lastActs;
      chatEl.appendChild(a);
    }
  });
  if (pending) add("ai hint", "Thinking…");
  if (errorMsg) add("err", errorMsg);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function ask(text, byVoice = false) {
  text = (text || "").trim();
  if (!text || pending) return;
  voiceTurn = byVoice;
  pending = true; errorMsg = ""; lastActs = ""; askText.value = "";
  localChat = [...localChat, {role: "user", text}];
  renderChat();
  const r = await send({type: "ASSISTANT_ASK", text, speak: speakBox.checked});
  pending = false;
  if (r?.ok) {
    lastActs = (r.actions || []).map(a => a.name.replace(/_/g, " ") + (a.ok ? "" : " (failed)")).join(" · ");
    const c = await chrome.storage.local.get("waChat");
    localChat = c.waChat || [];
  } else {
    errorMsg = r?.error || "The assistant didn't respond. Try reloading the extension.";
    if (/API key/i.test(errorMsg)) $("cfg").open = true;
  }
  renderChat();
  if (r?.ok && byVoice && !speakBox.checked) startFollow(5000);
}
$("suggest").addEventListener("click", () => ask("Look at the video title and analyze the mix, then pick and apply the best scene, room and sound placement for this video. Tell me what you chose and why in two short sentences."));
$("undo").addEventListener("click", async () => {
  const r = await send({type: "UNDO"});
  masterBusyUntil = 0; busyUntil = 0;
  say(r?.ok ? `Undid: ${r.undid}.` : (r?.error || "Nothing to undo."));
});
askBtn.addEventListener("click", () => ask(askText.value));
askText.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ask(askText.value); } });

// settings
chrome.storage.local.get(["geminiKey", "geminiModel", "speakReply", "waChat", "wakeWord", "waSpeaker"]).then((c) => {
  speaker.checked = !!c.waSpeaker;
  keyIn.value = c.geminiKey || "";
  modelIn.value = c.geminiModel || "";
  speakBox.checked = c.speakReply !== false;
  localChat = c.waChat || [];
  if (!c.geminiKey) $("cfg").open = true;
  wakeOn = !!c.wakeWord; wakeBox.checked = wakeOn;
  if (wakeOn) scheduleWake(800);
  renderChat();
});
keyIn.addEventListener("change", () => chrome.storage.local.set({geminiKey: keyIn.value.trim()}));
modelIn.addEventListener("change", () => chrome.storage.local.set({geminiModel: modelIn.value.trim()}));
speakBox.addEventListener("change", () => chrome.storage.local.set({speakReply: speakBox.checked}));
$("stopSpeech").addEventListener("click", () => send({type: "ASSISTANT_STOP_SPEECH"}));
$("clearChat").addEventListener("click", async () => {
  await chrome.storage.local.set({waChat: []});
  localChat = []; errorMsg = ""; lastActs = ""; renderChat();
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.waChat && !pending) { localChat = ch.waChat.newValue || []; renderChat(); }
});

// ---------- voice: push-to-talk, the keyboard shortcut and the "Hey World" wake word ----------
// The side panel stays open, so (unlike a popup) it can keep listening. One recognizer at a time.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const wakeBox = $("wake"), wakeState = $("wakeState");
const WAKE_RE = /\b(?:hey|hay|hi|okay|ok)[\s,.!-]*(?:world|word|whirled)\b[\s,.!:-]*/i;
let rec = null, recMode = "off";                 // "off" | "ptt" | "wake"
let wakeOn = false, armed = false, armTimer = null, wakeFails = 0, restartTimer = null;
let speaking = false, followTimer = null, followUntil = 0;
const duck = (on) => send({type: "SET_WORLD", patch: {duck: on}});
const setWakeState = (t) => { wakeState.textContent = t; };

function dropRec() {
  clearTimeout(restartTimer);
  if (rec) { rec.onstart = rec.onresult = rec.onerror = rec.onend = null; try { rec.abort(); } catch {} }
  rec = null; recMode = "off";
}
function micDenied() {
  wakeOn = false; wakeBox.checked = false; chrome.storage.local.set({wakeWord: false});
  setWakeState("");
  errorMsg = "I need microphone access. A new tab opened to ask for it. Allow it there, then tap the mic again.";
  chrome.tabs.create({url: chrome.runtime.getURL("mic.html")});
  renderChat();
}
function newRec(continuous) {
  const r = new SR();
  r.lang = navigator.language || "en-US";
  r.interimResults = true; r.continuous = continuous; r.maxAlternatives = 1;
  return r;
}

// push-to-talk (the mic button and Alt+Shift+W)
function startPtt() {
  if (!SR) { errorMsg = "Voice input isn't available in this browser. You can still type."; renderChat(); return; }
  dropRec(); disarm();
  send({type: "ASSISTANT_STOP_SPEECH"});
  errorMsg = ""; renderChat();
  const r = rec = newRec(false); recMode = "ptt";
  r.onstart = () => { micBtn.classList.add("listening"); askText.value = ""; askText.placeholder = "Listening…"; duck(true); };
  r.onresult = (e) => {
    let t = "";
    for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
    askText.value = t.trim();
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") micDenied();
    else if (e.error === "no-speech") { errorMsg = "I didn't hear anything. Tap the mic and try again."; renderChat(); }
    else if (e.error !== "aborted") { errorMsg = `Voice input error: ${e.error}`; renderChat(); }
  };
  r.onend = () => {
    micBtn.classList.remove("listening"); askText.placeholder = PLACEHOLDER;
    duck(false); rec = null; recMode = "off";
    const t = askText.value.trim();
    if (t && !errorMsg) ask(t, true);
    scheduleWake(400);
  };
  try { r.start(); } catch (e) { errorMsg = `Couldn't start the mic: ${e.message || e}`; renderChat(); dropRec(); scheduleWake(1000); }
}
micBtn.addEventListener("click", () => { if (recMode === "ptt") rec?.stop(); else startPtt(); });

// wake word: keeps listening, wakes on "Hey World", sends the command after a short pause
function disarm() { armed = false; clearTimeout(armTimer); armTimer = null; }
function scheduleWake(ms = 300) {
  clearTimeout(restartTimer);
  if (wakeOn && recMode === "off") restartTimer = setTimeout(startWake, ms);
}
function restartWake() { if (recMode === "ptt") return; disarm(); dropRec(); scheduleWake(150); }
function startWake() {
  if (!wakeOn || !SR || recMode !== "off") return;
  const r = rec = newRec(true); recMode = "wake";
  r.onstart = () => setWakeState(Date.now() < followUntil ? "Listening for a follow-up…" : "Listening for “Hey World”…");
  r.onresult = onWakeResult;
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") micDenied();
    else if (e.error !== "no-speech" && e.error !== "aborted") wakeFails++;
  };
  r.onend = () => { rec = null; recMode = "off"; disarm(); scheduleWake(wakeFails > 4 ? 4000 : 250); };
  try { r.start(); } catch { rec = null; recMode = "off"; scheduleWake(1500); }
}
function onWakeResult(e) {
  wakeFails = 0;
  if (speaking || pending) return;                // don't react to the assistant's own voice
  let text = "";
  for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
  text = text.trim();
  let cmd = null;
  const m = text.match(WAKE_RE);
  if (m) cmd = text.slice(m.index + m[0].length).trim();
  else if (armed || Date.now() < followUntil) cmd = text;    // follow-up: no wake phrase needed
  if (cmd === null) return;
  if (!armed) { armed = true; duck(true); setWakeState("Listening…"); }
  askText.value = cmd;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => finishWake(askText.value.trim()), cmd ? 1400 : 7000);
}
function finishWake(cmd) {
  disarm(); dropRec(); duck(false); askText.value = ""; setWakeState("");
  if (cmd) ask(cmd, true);
  scheduleWake(500);
}
// After a spoken answer, listen a few seconds for a follow-up without needing the wake phrase.
function startFollow(ms) {
  if (!wakeOn || !voiceTurn) return false;
  followUntil = Date.now() + ms; clearTimeout(followTimer);
  duck(true); restartWake();
  followTimer = setTimeout(() => { followUntil = 0; if (!armed) { duck(false); if (wakeOn) setWakeState("Listening for “Hey World”…"); } }, ms);
  return true;
}
wakeBox.addEventListener("change", () => {
  wakeOn = wakeBox.checked;
  chrome.storage.local.set({wakeWord: wakeOn});
  if (wakeOn) {
    if (!SR) { errorMsg = "Voice input isn't available in this browser."; wakeOn = wakeBox.checked = false; renderChat(); return; }
    scheduleWake(50);
  } else {
    disarm(); if (recMode === "wake") dropRec();
    setWakeState(""); duck(false);
  }
});

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === "TTS_STATE") {
    speaking = !!m.speaking;
    if (!speaking && wakeOn && !startFollow(5000)) restartWake();   // start fresh so it never hears its own words
  } else if (m?.type === "HOTKEY_TALK") {
    micBtn.click();
  } else if (m?.type === "OPEN_HP_TEST") {
    hpOpen();
  }
});

// saved setups (create them by telling the assistant "save this as front row")
const presetsEl = $("presets");
async function renderPresets() {
  const presets = (await chrome.storage.local.get("waPresets")).waPresets || {};
  const names = Object.values(presets).map(p => p.name);
  presetsEl.innerHTML = "";
  $("presetsSection").hidden = !names.length;
  for (const n of names) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = n; b.dataset.name = n;
    presetsEl.appendChild(b);
  }
}
presetsEl.addEventListener("click", async (e) => {
  const b = e.target.closest("button.chip");
  if (!b) return;
  const r = await send({type: "PRESET_LOAD", name: b.dataset.name});
  masterBusyUntil = 0;
  say(r?.ok ? `Loaded "${r.loaded}".` : (r?.error || "Couldn't load that setup."));
});
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.waPresets) renderPresets(); });
renderPresets();

// ---------- headphone check ----------
// Headphones need to be on for the 3D effect. This plays a beep hard in the left ear, then one hard in the right, and
// asks what you heard. On headphones each beep stays in its own ear; on speakers both ears hear both beeps.
const hpEl = $("hp"), hpText = $("hpText"), hpBtns = $("hpBtns");
let hpCtx = null, hpBusy = false;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function hpButtons(list) {
  hpBtns.innerHTML = "";
  for (const [label, fn, cls] of list) {
    const b = document.createElement("button");
    b.className = "chip" + (cls ? " " + cls : ""); b.textContent = label; b.onclick = fn;
    hpBtns.appendChild(b);
  }
}
function hpClose() { hpEl.hidden = true; }
async function outputHint() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput");
    const d = devs.find(x => x.deviceId === "default") || devs[0];
    const label = (d?.label || "").trim();
    if (!label) return "";
    const looks = /head(phone|set)|airpods|earbud|earphone|buds|bluetooth/i.test(label);
    return `Chrome reports your output as “${label}”${looks ? ", which sounds like headphones" : ""}. The test below is more reliable.`;
  } catch { return ""; }
}
function hpOpen() {
  hpEl.hidden = false;
  hpEl.scrollIntoView?.({block: "nearest"});
  hpText.textContent = "Put your headphones on and set a comfortable volume. The video goes quiet during the test. You will hear a short beep in your left ear, then one in your right.";
  hpButtons([["▶ Play test", hpPlay, "go"], ["Close", hpClose]]);
  outputHint().then(t => { if (t && !hpBusy) hpText.textContent += " " + t; });
}
function hpBeep(pan, at) {
  const g = hpCtx.createGain(), p = hpCtx.createStereoPanner();
  p.pan.value = pan; g.gain.value = 0;
  for (const f of [520, 780]) {
    const o = hpCtx.createOscillator(); o.type = "sine"; o.frequency.value = f;
    o.connect(g); o.start(at); o.stop(at + 0.75);
  }
  for (let i = 0; i < 3; i++) {
    const t = at + i * 0.24;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.02);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.18);
  }
  g.connect(p); p.connect(hpCtx.destination);
}
async function hpPlay() {
  if (hpBusy) return;
  hpBusy = true;
  hpButtons([["Playing…", () => {}]]);
  send({type: "SET_WORLD", patch: {duck: "mute"}});
  try {
    hpCtx = hpCtx || new AudioContext();
    await hpCtx.resume();
    const t0 = hpCtx.currentTime + 0.3;
    hpBeep(-1, t0);        // left ear only
    hpBeep(1, t0 + 1.3);   // right ear only
    await wait(2800);
  } catch (e) {
    hpText.textContent = `Couldn't play the test sound: ${e.message || e}`;
  }
  send({type: "SET_WORLD", patch: {duck: false}});
  hpBusy = false;
  hpText.textContent = "What did you hear?";
  hpButtons([
    ["The first beep was only in my left ear and the second only in my right", () => hpDone("headphones")],
    ["Both beeps came from both sides, out in the room", () => hpDone("speakers")],
    ["They were the wrong way round (left beep in my right ear)", () => hpDone("swapped")],
    ["Play it again", hpPlay]
  ]);
}
function hpDone(kind) {
  if (kind === "swapped") {
    hpText.textContent = "Your headphones are on the wrong way round, or your system is swapping the channels. Fix that and run the check again, otherwise everything will be mirrored left to right.";
    hpButtons([["Run the check again", hpOpen], ["Close", hpClose]]);
    return;
  }
  const spk = kind === "speakers";
  speaker.checked = spk;
  sendWorld();
  chrome.storage.local.set({waSpeaker: spk, waHeadphones: {kind, at: Date.now()}});
  hpText.textContent = spk
    ? "You're on speakers, so the full 3D effect can't reach you. Speaker mode is on: placement is gentler, sounds behind you fold to the front and get duller. Use headphones for the full effect."
    : "Headphones confirmed. Full 3D placement is on.";
  hpButtons([["Done", hpClose, "go"], ["Run it again", hpOpen]]);
}
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
}
async function renderHp() {
  const c = await chrome.storage.local.get(["waHeadphones", "waSpeaker"]);
  const h = c.waHeadphones, spk = !!c.waSpeaker;
  if (!h) { hpStatus.textContent = spk ? "Listening setup: speaker mode on (set by hand)." : "Listening setup: not checked yet. Run the headphone check for the best 3D effect."; return; }
  const matches = (h.kind === "speakers") === spk;
  hpStatus.textContent = `Listening setup: ${spk ? "speakers" : "headphones"}${matches ? `, checked ${ago(h.at)}.` : " (set by hand)."}`;
}
$("hpBtn").addEventListener("click", hpOpen);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !(ch.waHeadphones || ch.waSpeaker)) return;
  if (ch.waSpeaker && speaker.checked !== !!ch.waSpeaker.newValue) { speaker.checked = !!ch.waSpeaker.newValue; updateWorldLabels(); }
  renderHp();
});
renderHp();

updateWorldLabels();
updateScene();
poll();

// Experimental YouTube video synchronization over the manual WebRTC data channel.
const videoSyncStatusEl = $("videoSyncStatus");
const videoSyncStatus = (s) => { if(videoSyncStatusEl) videoSyncStatusEl.textContent=s; };
$("videoSyncEnable")?.addEventListener("click", async () => {
  const role = $("streamRole").value === "receiver" ? "receiver" : "sender";
  videoSyncStatus("Enabling Video Sync on this YouTube tab…");
  const r = await send({type:"VIDEO_SYNC_ENABLE",role});
  videoSyncStatus(r?.ok ? r.message : (r?.error || "Could not enable Video Sync."));
});
$("videoSyncNow")?.addEventListener("click", async () => {
  videoSyncStatus("Sending current playback state…");
  const r = await send({type:"VIDEO_SYNC_NOW"});
  videoSyncStatus(r?.ok ? r.message : (r?.error || "Could not synchronize video."));
});

// Experimental AI sound localization: sends the public YouTube URL and playhead timestamp to Gemini's video-understanding API.
const soundQuestionEl = $("soundQuestion");
const soundStatusEl = $("soundStatus");
$("soundAnalyze")?.addEventListener("click", async () => {
  const question = (soundQuestionEl?.value || "").trim();
  if (!question) { soundStatusEl.textContent = "Describe the sound you want located first."; soundQuestionEl?.focus(); return; }
  soundStatusEl.textContent = "Analyzing the video and sound around the current timestamp…";
  const r = await send({type:"SOUND_LOCATOR_ASK", question});
  soundStatusEl.textContent = r?.ok ? r.reply : (r?.error || "Sound analysis failed. Check the Gemini API key and try again.");
});
if (soundQuestionEl) soundQuestionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("soundAnalyze")?.click(); }
});

// Open the standalone receiver web app in a full browser tab.
$("openMultiDeviceApp")?.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("multi-device.html") });
  } catch (e) {
    say(`Could not open the multi-device web app: ${e.message || e}`);
  }
});

// Multi-device streaming controls: manual WebRTC offer/answer exchange, no local server.
const streamStatusEl = $("streamStatus");
const streamStatus = (s) => { if (streamStatusEl) streamStatusEl.textContent = s; };
const manualText = $("manualOfferText");
$("manualOffer")?.addEventListener("click", async () => {
  if ($("streamRole").value !== "sender") { streamStatus("Choose Main device on the YouTube device first."); return; }
  streamStatus("Creating offer and gathering connection details…");
  const r = await send({type:"MANUAL_CREATE_OFFER"});
  if (r?.ok) { manualText.value = r.description; streamStatus("Offer created. Copy all the text, paste it into the satellite device, and click Create answer."); }
  else streamStatus(r?.error || "Could not create offer. Start World Audio on the main device first.");
});
$("manualAnswer")?.addEventListener("click", async () => {
  if ($("streamRole").value !== "receiver") { streamStatus("Choose Satellite on the receiving device first."); return; }
  streamStatus("Creating answer…");
  const r = await send({type:"MANUAL_CREATE_ANSWER", description:manualText.value});
  if (r?.ok) { manualText.value = r.description; streamStatus("Answer created. Copy all the text and paste it on the main device, replacing the offer, then click Apply answer."); }
  else streamStatus(r?.error || "Could not create answer.");
});
$("manualApply")?.addEventListener("click", async () => {
  if ($("streamRole").value !== "sender") { streamStatus("Apply answer on the main device only."); return; }
  streamStatus("Applying answer…");
  const r = await send({type:"MANUAL_APPLY_ANSWER", description:manualText.value});
  streamStatus(r?.ok ? r.message : (r?.error || "Could not apply answer."));
});
$("streamDisconnect")?.addEventListener("click", async () => {
  const r = await send({type:"STREAM_DISCONNECT"});
  streamStatus(r?.ok ? "Disconnected from multi-device audio." : (r?.error || "Disconnected."));
});


// Automatic short-code pairing. The signaling server exchanges SDP only; media remains WebRTC peer-to-peer.
(() => {
  const $ = id => document.getElementById(id);
  const codeEl = $('pairSessionCode'), serverEl = $('pairServerUrl'), statusEl = $('autoPairStatus');
  if (!codeEl || !serverEl || !statusEl) return;
  let ws = null, senderPeerId = null, pairingBusy = false;
  const setStatus = msg => { statusEl.textContent = msg; streamStatus(msg); };
  const cleanCode = value => String(value || '').replace(/\D/g, '').slice(0, 6);
  $('generatePairCode')?.addEventListener('click', () => {
    const n = new Uint32Array(1); crypto.getRandomValues(n);
    codeEl.value = String(n[0] % 1000000).padStart(6, '0');
    setStatus('Code generated. Use this same 6-digit code on the receiving device.');
  });
  async function sendSignal(to, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Signaling server is not connected.');
    ws.send(JSON.stringify({type:'signal', to, data}));
  }
  async function handlePeerJoined(peerId, role) {
    if (role !== 'receiver' || pairingBusy) return;
    pairingBusy = true; senderPeerId = peerId;
    try {
      if ($('streamRole')?.value !== 'sender') throw new Error('Choose Main device on the YouTube computer first.');
      setStatus('Receiver found. Creating secure peer connection offer…');
      const result = await send({type:'MANUAL_CREATE_OFFER'});
      if (!result?.ok) throw new Error(result?.error || 'Could not create offer. Start World Audio on the main device first.');
      await sendSignal(peerId, {kind:'offer', description:JSON.parse(result.description)});
      setStatus('Offer sent automatically. Keep this panel open while the receiver connects.');
    } catch (e) { setStatus('Automatic pairing error: ' + (e?.message || String(e))); pairingBusy = false; }
  }
  $('startAutoPair')?.addEventListener('click', () => {
    if ($('streamRole')?.value !== 'sender') { setStatus('Choose Main device on the YouTube computer first.'); return; }
    const url = serverEl.value.trim(); const code = cleanCode(codeEl.value);
    if (!/^wss:\/\//i.test(url) || /YOUR-SIGNALING-SERVER/i.test(url)) { setStatus('Enter your real public WSS signaling-server URL first. The included server must be deployed before code pairing can work across devices.'); return; }
    if (code.length !== 6) { setStatus('Enter or generate a 6-digit session code.'); return; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    codeEl.value = code; setStatus('Connecting to signaling server…');
    try { ws = new WebSocket(url); } catch (e) { setStatus('Could not open signaling connection: ' + e.message); return; }
    ws.onopen = () => { ws.send(JSON.stringify({type:'join', room:code, role:'sender'})); setStatus('Connected to signaling server. Waiting for a device using code ' + code + '…'); };
    ws.onmessage = async ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'joined') setStatus('Session ' + code + ' is ready. On the TV/device, enter this code in the receiver app.');
      else if (msg.type === 'peer-joined') handlePeerJoined(msg.peerId, msg.role);
      else if (msg.type === 'signal' && msg.data?.kind === 'answer') {
        try {
          const result = await send({type:'MANUAL_APPLY_ANSWER', description:JSON.stringify(msg.data.description)});
          if (!result?.ok) throw new Error(result?.error || 'Could not apply receiver answer.');
          setStatus('Answer received automatically. Connecting audio to the receiver…');
        } catch (e) { setStatus('Could not apply answer: ' + (e?.message || String(e))); }
      } else if (msg.type === 'peer-left') { senderPeerId = null; pairingBusy = false; setStatus('Receiver left. The session code is still active; another receiver can join.'); }
      else if (msg.type === 'error') setStatus('Signaling server: ' + msg.message);
    };
    ws.onerror = () => setStatus('Signaling connection failed. Check the WSS URL and server deployment.');
    ws.onclose = () => { if (ws) setStatus('Signaling disconnected. Start automatic pairing to reconnect.'); };
  });
  $('stopAutoPair')?.addEventListener('click', () => {
    if (ws) { const old=ws; ws=null; try { old.close(); } catch {} }
    senderPeerId=null; pairingBusy=false;
    send({type:'STREAM_DISCONNECT'}).catch(()=>{});
    setStatus('Automatic pairing stopped.');
  });
})();
