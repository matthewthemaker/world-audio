// World Audio 0.9 processor. Runs in the offscreen document so audio keeps playing
// even when the popup is closed.
//
// Pipeline: tab audio -> stereo split -> 5 frequency "stems" + 1 ambience (side) stem.
// Each stem is analysed ~20x/second (level, stereo position, stereo correlation, punch).
// The analysis labels each stem and, in Auto mode, places it in the 3D world.
// NEW in 0.9: a real LEAD VOCAL sound (the centre of the stereo picture, lifted out of the band), guitars/keys kept
// as true left and right channels, 16 rooms and 13 scenes, a vocal-separation control, and a speaker mode for
// people who are not on headphones.
// NEW in 0.5: YOU can move. The listener has a position in the room (and a facing), so you can
// stand next to the singer, inside the band, or at the back of the hall. Sounds stay where they
// are on the stage; what you hear is calculated relative to where you stand.
// 0.4: every scene puts the stems on a stage inside a virtual room. Each stem
// is HRTF-positioned, gets distance-based air absorption, and feeds a room reverb whose
// impulse response is generated for the chosen room (living room, studio, club, hall...).

const PI = Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The eight sounds. Each one is a movable object in the room.
//  - bass: below 160 Hz, from the raw stereo signal.
//  - body / presence / air: frequency bands of the "instruments" signal (the track with the lead vocal taken out).
//  - voice: the LEAD VOCAL, taken from the centre of the stereo picture (what L and R share) between 200 Hz and 5.5 kHz.
//  - midL / midR: guitars, keys and other mid-range instruments, kept as the real left and real right channel.
//  - ambience: the side signal (what is different between L and R).
const VOCAL = {lo: 200, hi: 5500};
const STEM_DEFS = [
  {id: "bass",     name: "Bass",                    lo: 20,   hi: 160,   src: "raw",  elev: -0.3, spreadDeg: 0,   sendBias: 0.3},
  {id: "body",     name: "Low instruments",         lo: 160,  hi: 700,   src: "inst", elev: -0.1, spreadDeg: -40, sendBias: 0.8},
  {id: "voice",    name: "Lead vocal",                                                 elev: 0,    spreadDeg: 0,   sendBias: 1},
  {id: "midL",     name: "Guitars / keys · left",   lo: 700,  hi: 3500,  side: -1,     elev: 0,    spreadDeg: 0,   sendBias: 1},
  {id: "midR",     name: "Guitars / keys · right",  lo: 700,  hi: 3500,  side: 1,      elev: 0,    spreadDeg: 0,   sendBias: 1},
  {id: "presence", name: "Presence",                lo: 3500, hi: 8000,  src: "inst", elev: 0.2,  spreadDeg: 40,  sendBias: 1},
  {id: "air",      name: "Cymbals / air",           lo: 8000, hi: 20000, src: "inst", elev: 0.5,  spreadDeg: -70, sendBias: 1},
  {id: "ambience", name: "Ambience / room",                                            elev: 0.3,  spreadDeg: 0,   sendBias: 1.6}
];

// Rooms: reverb time, pre-delay, how dark the tail gets, early-reflection taps [ms, gain].
// bright = where the reverb is rolled off (Hz): low for soft, damped rooms, high for tile and concrete.
const ROOMS = {
  none:      {name: "No room (dry)",    rt60: 0,    pre: 0,     wet: 0,    rolloff: 0.4,  damp: [0.5, 0.2],   taps: []},
  studio:    {name: "Recording studio", rt60: 0.24, pre: 0.002, wet: 0.32, rolloff: 0.25, damp: [0.55, 0.2],  taps: [[3, .5], [5, .4], [8, .3], [12, .22]]},
  living:    {name: "Living room",      rt60: 0.45, pre: 0.004, wet: 0.55, rolloff: 0.28, damp: [0.5, 0.15],  taps: [[6, .5], [9, .45], [13, .38], [18, .3], [24, .24], [33, .18]]},
  club:      {name: "Small club",       rt60: 0.9,  pre: 0.010, wet: 0.6,  rolloff: 0.22, damp: [0.45, 0.12], taps: [[11, .5], [16, .42], [23, .36], [31, .3], [42, .24]]},
  hall:      {name: "Concert hall",     rt60: 2.3,  pre: 0.032, wet: 0.7,  rolloff: 0.18, damp: [0.4, 0.08],  taps: [[24, .5], [33, .42], [46, .36], [60, .3], [78, .25], [96, .2]]},
  cathedral: {name: "Cathedral",        rt60: 4.4,  pre: 0.065, wet: 0.8,  rolloff: 0.15, damp: [0.35, 0.06], taps: [[45, .45], [62, .4], [85, .35], [110, .3]]},
  // new in 0.9
  bedroom:   {name: "Bedroom",          rt60: 0.22, pre: 0.002, wet: 0.3,  rolloff: 0.3,  damp: [0.6, 0.22],  bright: 7500,  taps: [[4, .4], [7, .32], [11, .24], [16, .16]]},
  bathroom:  {name: "Bathroom (tiles)", rt60: 1.15, pre: 0.003, wet: 0.7,  rolloff: 0.28, damp: [0.85, 0.45], bright: 15000, taps: [[2, .6], [3, .55], [4.5, .5], [6, .45], [8, .4], [10, .35], [13, .3], [17, .25]]},
  car:       {name: "Car interior",     rt60: 0.13, pre: 0.001, wet: 0.18, rolloff: 0.45, damp: [0.4, 0.2],   bright: 6000,  taps: [[1.5, .5], [2.5, .4], [4, .3], [6, .2]]},
  garage:    {name: "Garage",           rt60: 0.85, pre: 0.008, wet: 0.55, rolloff: 0.24, damp: [0.6, 0.3],   bright: 11000, taps: [[9, .5], [14, .45], [20, .4], [28, .32], [38, .25]]},
  warehouse: {name: "Warehouse",        rt60: 3.1,  pre: 0.045, wet: 0.62, rolloff: 0.18, damp: [0.5, 0.1],   bright: 9000,  taps: [[40, .4], [58, .36], [79, .32], [103, .27], [131, .22]]},
  theater:   {name: "Theatre",          rt60: 1.35, pre: 0.02,  wet: 0.62, rolloff: 0.2,  damp: [0.42, 0.1],  bright: 12000, taps: [[16, .5], [24, .42], [34, .36], [47, .3], [62, .24]]},
  arena:     {name: "Arena",            rt60: 3.7,  pre: 0.075, wet: 0.7,  rolloff: 0.15, damp: [0.45, 0.07], bright: 8500,  taps: [[70, .38], [96, .34], [125, .3], [160, .26], [200, .2]]},
  stadium:   {name: "Open stadium",     rt60: 2.4,  pre: 0.05,  wet: 0.5,  rolloff: 0.14, damp: [0.35, 0.08], bright: 6500,  taps: [[150, .3], [260, .22], [380, .16]]},
  tunnel:    {name: "Tunnel",           rt60: 2.8,  pre: 0.01,  wet: 0.65, rolloff: 0.2,  damp: [0.55, 0.12], bright: 9000,  taps: [[18, .5], [36, .45], [54, .4], [72, .36], [90, .32], [108, .28], [126, .24], [144, .2]]},
  openair:   {name: "Open air",         rt60: 0.5,  pre: 0.03,  wet: 0.2,  rolloff: 0.12, damp: [0.3, 0.1],   bright: 8000,  taps: [[110, .18], [230, .1]]}
};

const GEOM = {
  none: {w: 0, h: 0, ly: .5}, studio: {w: 6, h: 6, ly: .5}, living: {w: 7, h: 7, ly: .5},
  club: {w: 10, h: 10, ly: .6}, hall: {w: 20, h: 24, ly: .72}, cathedral: {w: 16, h: 30, ly: .7},
  bedroom: {w: 3.6, h: 4.2, ly: .5}, bathroom: {w: 2.4, h: 3, ly: .5}, car: {w: 1.9, h: 3.2, ly: .5},
  garage: {w: 6, h: 7, ly: .62}, warehouse: {w: 26, h: 34, ly: .72}, theater: {w: 14, h: 20, ly: .72},
  arena: {w: 44, h: 56, ly: .76}, stadium: {w: 64, h: 80, ly: .8}, tunnel: {w: 5, h: 44, ly: .5},
  openair: {w: 0, h: 0, ly: .5}
};
for (const k of Object.keys(ROOMS)) Object.assign(ROOMS[k], GEOM[k]);

// Scenes: where each sound sits (azimuth deg, distance m, elevation m). panWidth is how far (deg) a sound's own
// stereo position can pull it left/right of its anchor (the left/right guitar channels are never pulled).
const A = (az, d, elev = 0) => ({az, d, elev});
const SCENES = {
  living: {name: "Living room", room: "living", panWidth: 35, anchors: {
    bass: A(-35, 2.8, -0.3), body: A(35, 2.8, -0.1), voice: A(0, 2.0), midL: A(-55, 3.0), midR: A(55, 3.0),
    presence: A(-14, 3.2, 0.2), air: A(18, 3.5, 0.5), ambience: A(180, 3.5, 0.3)}},
  hall: {name: "Concert hall", room: "hall", panWidth: 30, anchors: {
    bass: A(-30, 8.5, -0.2), body: A(30, 8), voice: A(0, 6.5, 0.1), midL: A(-50, 7.6), midR: A(50, 7.6),
    presence: A(-12, 8, 0.3), air: A(14, 10, 0.8), ambience: A(180, 6, 0.5)}},
  club: {name: "Small club", room: "club", panWidth: 30, anchors: {
    bass: A(-28, 4.5, -0.2), body: A(28, 4.2), voice: A(0, 3.6, 0.1), midL: A(-48, 4.2), midR: A(48, 4.2),
    presence: A(-10, 4.6, 0.3), air: A(12, 5.2, 0.7), ambience: A(180, 4, 0.4)}},
  studio: {name: "Studio", room: "studio", panWidth: 40, anchors: {
    bass: A(-110, 2.4, -0.2), body: A(80, 2.2), voice: A(0, 1.4), midL: A(-35, 2.0, 0.05), midR: A(125, 2.3, 0.05),
    presence: A(-70, 2.0, 0.1), air: A(20, 1.6, 1.4), ambience: A(180, 3, 0.3)}},
  theater: {name: "Theatre", room: "theater", panWidth: 30, anchors: {
    bass: A(-28, 7, -0.2), body: A(28, 6.8), voice: A(0, 5.5, 0.1), midL: A(-50, 6.5), midR: A(50, 6.5),
    presence: A(-12, 6.8, 0.3), air: A(14, 8, 0.7), ambience: A(180, 5, 0.4)}},
  arena: {name: "Arena", room: "arena", panWidth: 30, anchors: {
    bass: A(-30, 10.5, -0.2), body: A(30, 10), voice: A(0, 9, 0.2), midL: A(-52, 10), midR: A(52, 10),
    presence: A(-14, 10), air: A(16, 11.5, 1), ambience: A(180, 8, 0.5)}},
  festival: {name: "Festival", room: "openair", panWidth: 30, anchors: {
    bass: A(-30, 9, -0.2), body: A(30, 8.5), voice: A(0, 7, 0.2), midL: A(-55, 8.5), midR: A(55, 8.5),
    presence: A(-12, 8.5, 0.3), air: A(14, 10, 0.8), ambience: A(180, 10, 0.4)}},
  car: {name: "Car", room: "car", panWidth: 20, anchors: {
    bass: A(170, 1.8, -0.3), body: A(110, 1.4, -0.1), voice: A(0, 1.3, 0.1), midL: A(-75, 1.1), midR: A(75, 1.1),
    presence: A(-35, 1.3, 0.3), air: A(35, 1.3, 0.3), ambience: A(180, 1.8, 0.2)}},
  bathroom: {name: "Bathroom", room: "bathroom", panWidth: 15, anchors: {
    bass: A(-40, 1.6, -0.3), body: A(-30, 1.5, -0.1), voice: A(-25, 1.3, 0.1), midL: A(-45, 1.6), midR: A(-15, 1.5),
    presence: A(-35, 1.5, 0.3), air: A(-30, 1.6, 0.5), ambience: A(180, 1.5, 0.3)}},
  garage: {name: "Garage band", room: "garage", panWidth: 35, anchors: {
    bass: A(-35, 3.4, -0.2), body: A(35, 3.2), voice: A(0, 2.8, 0.1), midL: A(-55, 3.2), midR: A(55, 3.2),
    presence: A(-15, 3.4, 0.2), air: A(20, 3.8, 0.9), ambience: A(180, 3, 0.3)}},
  warehouse: {name: "Warehouse", room: "warehouse", panWidth: 30, anchors: {
    bass: A(-20, 6, -0.3), body: A(20, 6), voice: A(0, 5.5, 0.2), midL: A(-50, 6.8), midR: A(50, 6.8),
    presence: A(-10, 7, 0.3), air: A(12, 8, 0.8), ambience: A(180, 7, 0.5)}},
  bedroom: {name: "Bedroom", room: "bedroom", panWidth: 30, anchors: {
    bass: A(-30, 1.8, -0.2), body: A(30, 1.8), voice: A(0, 1.3, 0.1), midL: A(-45, 1.7), midR: A(45, 1.7),
    presence: A(-12, 1.9, 0.3), air: A(15, 2.1, 0.5), ambience: A(180, 2.2, 0.3)}},
  free: {name: "Free (no room)", room: "none", panWidth: 90, anchors: null}
};

// Places you can jump to in each scene. x = metres right of the default seat, z = metres back
// (negative = toward the stage). look = the point you face when you get there.
const SPOTS = {
  living: [
    {id: "seat", name: "Your seat", x: 0, z: 0, look: [0, -5]},
    {id: "singer", name: "Next to the singer", x: 0.9, z: -1.4, look: [0, -2]},
    {id: "band", name: "Inside the band", x: 0, z: -2.7, look: [0, -6]},
    {id: "corner", name: "Back corner", x: -2.8, z: 2.8, look: [0, -2.5]}],
  hall: [
    {id: "seat", name: "Front row", x: 0, z: 0, look: [0, -8]},
    {id: "side", name: "Side of the stage", x: -7.5, z: -7, look: [0, -7.5]},
    {id: "stage", name: "On stage, facing the crowd", x: 0, z: -7.8, look: [0, 6]},
    {id: "back", name: "Back of the hall", x: 0, z: 5.5, look: [0, -7]}],
  club: [
    {id: "seat", name: "Mid-crowd", x: 0, z: 0, look: [0, -5]},
    {id: "rail", name: "Right at the stage", x: 0, z: -2.6, look: [0, -3.6]},
    {id: "drums", name: "Behind the drums", x: 1, z: -5.5, look: [0, 3]},
    {id: "bar", name: "By the bar", x: 4, z: 3, look: [0, -3.5]}],
  studio: [
    {id: "seat", name: "Middle of the room", x: 0, z: 0, look: [0, -3]},
    {id: "vocal", name: "Beside the vocalist", x: 0.8, z: -1.2, look: [0, -1.4]},
    {id: "amp", name: "Next to the bass amp", x: -1.7, z: 0.4, look: [-2.26, 0.82]},
    {id: "corner", name: "Control corner", x: 2.4, z: 2.4, look: [0, -1]}],
  theater: [
    {id: "seat", name: "Row five", x: 0, z: 0, look: [0, -6]},
    {id: "balcony", name: "Balcony", x: 0, z: 5, look: [0, -6]},
    {id: "box", name: "Side box", x: -5.5, z: -3, look: [0, -6]},
    {id: "stage", name: "On stage", x: 0, z: -5.8, look: [0, 6]}],
  arena: [
    {id: "seat", name: "On the floor", x: 0, z: 0, look: [0, -10]},
    {id: "pit", name: "At the barrier", x: 0, z: -7.5, look: [0, -9.5]},
    {id: "upper", name: "Upper seats", x: 0, z: 12, look: [0, -10]},
    {id: "side", name: "Side stand", x: -14, z: -4, look: [0, -10]}],
  festival: [
    {id: "seat", name: "In the crowd", x: 0, z: 0, look: [0, -8]},
    {id: "barrier", name: "Front barrier", x: 0, z: -5, look: [0, -8]},
    {id: "back", name: "Far back", x: 0, z: 10, look: [0, -8]},
    {id: "side", name: "Side of the crowd", x: -9, z: -4, look: [0, -8]}],
  car: [
    {id: "seat", name: "Middle of the car", x: 0, z: 0, look: [0, -3]},
    {id: "driver", name: "Driver's seat", x: -0.45, z: 0.1, look: [0, -3]},
    {id: "passenger", name: "Passenger seat", x: 0.45, z: 0.1, look: [0, -3]},
    {id: "back", name: "Back seat", x: 0, z: 1.0, look: [0, -3]}],
  bathroom: [
    {id: "seat", name: "In the shower", x: 0, z: 0, look: [0, -3]},
    {id: "sink", name: "At the sink", x: -0.6, z: -0.9, look: [-0.8, -1.3]},
    {id: "door", name: "In the doorway", x: 0.3, z: 1.1, look: [0, -3]}],
  garage: [
    {id: "seat", name: "On the couch", x: 0, z: 0, look: [0, -5]},
    {id: "mic", name: "At the mic", x: 0, z: -2.2, look: [0, -3]},
    {id: "drums", name: "Behind the drums", x: 1, z: -3.4, look: [0, 3]},
    {id: "door", name: "By the door", x: 2.4, z: 2.2, look: [0, -3]}],
  warehouse: [
    {id: "seat", name: "Dance floor", x: 0, z: 0, look: [0, -8]},
    {id: "stacks", name: "In front of the speakers", x: 0, z: -4.5, look: [0, -7]},
    {id: "booth", name: "On the DJ booth", x: 0, z: -7, look: [0, 8]},
    {id: "bar", name: "Back by the bar", x: 5, z: 8, look: [0, -7]}],
  bedroom: [
    {id: "seat", name: "At the desk", x: 0, z: 0, look: [0, -3]},
    {id: "between", name: "Between the speakers", x: 0, z: -1.2, look: [0, -2]},
    {id: "bed", name: "Lying on the bed", x: 1.1, z: 1.3, look: [0, -2]},
    {id: "door", name: "By the door", x: -1.4, z: 1.6, look: [0, -2]}],
  free: [{id: "seat", name: "Center", x: 0, z: 0, look: [0, -5]}]
};
for (const k of Object.keys(SCENES)) SCENES[k].spots = SPOTS[k] || [];

const DEFAULT_WORLD = {
  listenerYaw: 0, listenerX: 0, listenerZ: 0, worldLock: true, distanceOffset: 0, auto: true, spread: 0.5, customRoomGeom: null,
  scene: "living", room: "living", reverb: 1, volume: 1, sway: true,
  vocalSplit: 0.8,      // how much of the centred lead vocal is lifted out of the instruments (0 = none, 1 = all of it)
  speakerMode: false    // milder placement for speakers: no HRTF, rear sounds fold to the front and get duller
};

let world = {...DEFAULT_WORLD};
// While the assistant is listening or speaking (or the headphone test is playing), the video is turned down.
// It expires on its own, so a closed popup can never leave the volume stuck low.
let duckUntil = 0, duckLevel = 0.15;
const stems = STEM_DEFS.map(b => ({
  id: b.id, name: b.name, label: b.name, baseElev: b.elev, elev: b.elev, spreadDeg: b.spreadDeg, sendBias: b.sendBias, side: b.side || 0,
  azimuth: 0, distance: 2, volume: 1, mute: false, solo: false, manual: false, motion: null,
  level: 0, slow: 0, pan: 0, corr: 1, punch: 0, punchy: false,
  anL: null, anR: null, damp: null, panner: null, gain: null, send: null
}));
resetStems();
let split = null;   // the nodes that lift the vocal out of the instruments

let stream = null, audioContext = null, master = null, limiter = null;
let streamOut = null, signalSocket = null, streamRole = null, streamRoom = null, streamPeers = new Map(), receiverAudio = null, manualPeer = null;
let reverbIn = null, convolver = null, reverbOut = null, reverbLP = null;
let allNodes = [];
let active = false, timer = null, irToken = 0;
let walkTX = 0, walkTZ = 0; // where the listener is walking to; world.listenerX/Z glide toward it

// Keep the listener inside the room (or within 12 m when there is no room).
function clampListener(x, z) {
  const r = world.customRoomGeom?.w > 0 ? {...ROOMS[world.room], ...world.customRoomGeom} : ROOMS[world.room];
  if (r && r.w > 0) {
    return [clamp(x, -r.w / 2 + 0.3, r.w / 2 - 0.3), clamp(z, -r.ly * r.h + 0.3, (1 - r.ly) * r.h - 0.3)];
  }
  return [clamp(x, -12, 12), clamp(z, -12, 12)];
}
function setWalkTarget(x, z, snap) {
  [walkTX, walkTZ] = clampListener(Number(x) || 0, Number(z) || 0);
  if (snap) { world.listenerX = walkTX; world.listenerZ = walkTZ; }
}

function resetStems() {
  for (const st of stems) {
    const amb = st.id === "ambience";
    st.azimuth = amb ? 180 : st.side * 50;
    st.distance = amb ? 3.5 : 2;
    st.elev = st.baseElev;
    st.volume = 1; st.mute = false; st.solo = false; st.manual = false; st.motion = null;
    st.pan = 0; st.corr = 1; st.punch = 0; st.punchy = false; st.slow = 0; st.level = 0;
    st.label = st.name;
  }
}

function snapshot() {
  const room = ROOMS[world.room];
  const geom = world.customRoomGeom?.w > 0 ? {...room, ...world.customRoomGeom} : room;
  const sc = SCENES[world.scene] || SCENES.free;
  return {
    active,
    world: {...world},
    roomGeom: {w: geom.w, h: geom.h, ly: geom.ly},
    spots: sc.spots.map(sp => ({
      id: sp.id, name: sp.name, x: sp.x, z: sp.z,
      yaw: Math.round(Math.atan2(sp.look[0] - sp.x, -(sp.look[1] - sp.z)) * 180 / PI)
    })),
    stems: stems.map(s => ({
      id: s.id, name: s.name, label: s.label, azimuth: s.azimuth, distance: s.distance,
      volume: s.volume, mute: s.mute, solo: s.solo, manual: s.manual,
      level: s.level, slow: s.slow, punch: s.punch, pan: s.pan, corr: s.corr,
      motion: s.motion ? (({t0, from, ...rest}) => rest)(s.motion) : null
    }))
  };
}

// ---------- room impulse response ----------
function makeIR(ctx, room) {
  const sr = ctx.sampleRate;
  const pre = Math.floor(room.pre * sr);
  const len = pre + Math.floor(room.rt60 * 1.15 * sr) + 64;
  const buf = ctx.createBuffer(2, len, sr);
  const ramp = Math.max(1, Math.floor(0.012 * sr));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Early reflections: a few discrete bounces, slightly different per ear for width.
    for (const [ms, g] of room.taps) {
      const i = pre + Math.floor((ms + (Math.random() * 2 - 1) * 1.5) * sr / 1000);
      if (i > 0 && i < len) d[i] += g * (Math.random() < 0.5 ? -1 : 1);
    }
    // Late tail: decaying noise that gets darker over time, like real rooms.
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-6.9078 * t / room.rt60);
      const k = room.damp[0] + (room.damp[1] - room.damp[0]) * Math.min(1, t / room.rt60);
      lp += ((Math.random() * 2 - 1) - lp) * k;
      d[i] += lp * env * Math.min(1, (i - pre) / ramp) * 0.6;
    }
  }
  return buf;
}

function setRoom(id, immediate) {
  if (!ROOMS[id]) return;
  world.room = id;
  setWalkTarget(walkTX, walkTZ);
  if (!audioContext || !convolver) return;
  const room = ROOMS[id];
  for (const st of stems) if (st.panner) st.panner.rolloffFactor = room.rolloff;
  if (reverbLP) reverbLP.frequency.setTargetAtTime(room.bright || 16000, audioContext.currentTime, 0.05);
  if (room.wet <= 0) return; // sends drop to zero in applyStem
  const token = ++irToken, ctx = audioContext;
  if (immediate || !convolver.buffer) { convolver.buffer = makeIR(ctx, room); return; }
  // Fade the reverb out, swap the impulse response, fade back in (avoids clicks).
  reverbOut.gain.cancelScheduledValues(ctx.currentTime);
  reverbOut.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
  setTimeout(() => {
    if (token !== irToken || !audioContext || audioContext !== ctx || !convolver) return;
    convolver.buffer = makeIR(ctx, ROOMS[world.room]);
    reverbOut.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
  }, 90);
}

function applyScene(id) {
  const sc = SCENES[id];
  if (!sc) return;
  world.scene = id;
  setWalkTarget(0, 0);
  for (const st of stems) {
    st.manual = false; st.motion = null;
    const a = sc.anchors?.[st.id];
    st.elev = a?.elev ?? st.baseElev;
    if (a && !world.auto) { st.azimuth = a.az; st.distance = a.d; }
  }
  setRoom(sc.room);
}

// ---------- graph building ----------
function track(node) { allNodes.push(node); return node; }

function bandChain(ctx, lo, hi) {
  const nodes = [];
  if (lo > 25) for (let i = 0; i < 2; i++) {
    const f = track(ctx.createBiquadFilter()); f.type = "highpass"; f.frequency.value = lo; f.Q.value = 0.707; nodes.push(f);
  }
  if (hi < 19000) for (let i = 0; i < 2; i++) {
    const f = track(ctx.createBiquadFilter()); f.type = "lowpass"; f.frequency.value = hi; f.Q.value = 0.707; nodes.push(f);
  }
  if (!nodes.length) nodes.push(track(ctx.createGain()));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return {input: nodes[0], output: nodes[nodes.length - 1]};
}

function makeAnalyser(ctx) {
  const a = track(ctx.createAnalyser());
  a.fftSize = 2048;
  a.smoothingTimeConstant = 0;
  return a;
}

function makePanner(ctx) {
  const p = track(ctx.createPanner());
  p.panningModel = "HRTF";
  p.distanceModel = "inverse";
  p.refDistance = 1;
  p.maxDistance = 50;
  p.rolloffFactor = ROOMS[world.room].rolloff;
  p.positionX.value = 0;
  p.positionY.value = 0;
  p.positionZ.value = -1;
  return p;
}

function attachOutput(ctx, st, monoNode) {
  // mono -> distance air-absorption lowpass -> HRTF panner -> stem gain -> dry master
  //                                                         \-> reverb send -> room reverb
  st.damp = track(ctx.createBiquadFilter());
  st.damp.type = "lowpass"; st.damp.frequency.value = 18000; st.damp.Q.value = 0.5;
  st.panner = makePanner(ctx);
  st.gain = track(ctx.createGain());
  st.send = track(ctx.createGain());
  st.send.gain.value = 0;
  monoNode.connect(st.damp);
  st.damp.connect(st.panner);
  st.panner.connect(st.gain);
  st.gain.connect(master);
  st.gain.connect(st.send);
  st.send.connect(reverbIn);
}

function buildGraph(ctx, splitter) {
  // 1. The centre of the picture (what L and R share), and the lead vocal band cut out of it.
  const mid = track(ctx.createGain());
  for (const ch of [0, 1]) {
    const h = track(ctx.createGain()); h.gain.value = 0.5;
    splitter.connect(h, ch); h.connect(mid);
  }
  const vb = bandChain(ctx, VOCAL.lo, VOCAL.hi);
  mid.connect(vb.input);
  // 2. Instruments = the original left/right with that vocal subtracted. The vocal sound plays the same signal at the
  //    same strength, so with everything un-muted the sum is the original track. applySplit() sets the strength.
  const inst = [track(ctx.createGain()), track(ctx.createGain())];
  const sub = [track(ctx.createGain()), track(ctx.createGain())];
  for (const ch of [0, 1]) {
    splitter.connect(inst[ch], ch);
    vb.output.connect(sub[ch]); sub[ch].connect(inst[ch]);
  }
  const vg = track(ctx.createGain());
  vb.output.connect(vg);
  split = {sub, vg};
  const feed = (d, ch, node) => { if (d.src === "raw") splitter.connect(node, ch); else inst[ch].connect(node); };

  for (const d of STEM_DEFS) {
    const st = stems.find(s => s.id === d.id);
    if (d.id === "voice") {
      st.anL = makeAnalyser(ctx); vg.connect(st.anL);
      attachOutput(ctx, st, vg);
    } else if (d.side) {
      // A real left or right channel, so a wide mix keeps its width and each side can be moved on its own.
      const c = bandChain(ctx, d.lo, d.hi);
      inst[d.side < 0 ? 0 : 1].connect(c.input);
      st.anL = makeAnalyser(ctx); c.output.connect(st.anL);
      const g = track(ctx.createGain()); g.gain.value = 0.75;
      c.output.connect(g);
      attachOutput(ctx, st, g);
    } else if (d.id === "ambience") {
      // Ambience = the side signal (L - R): what is different between the two ears.
      const sl = track(ctx.createGain()); sl.gain.value = 0.7;
      const sr = track(ctx.createGain()); sr.gain.value = -0.7;
      splitter.connect(sl, 0); splitter.connect(sr, 1);
      const side = track(ctx.createGain());
      sl.connect(side); sr.connect(side);
      const hp = track(ctx.createBiquadFilter()); hp.type = "highpass"; hp.frequency.value = 200;
      side.connect(hp);
      st.anL = makeAnalyser(ctx); st.anR = null;
      hp.connect(st.anL);
      attachOutput(ctx, st, hp);
    } else {
      const cl = bandChain(ctx, d.lo, d.hi);
      const cr = bandChain(ctx, d.lo, d.hi);
      feed(d, 0, cl.input); feed(d, 1, cr.input);
      st.anL = makeAnalyser(ctx); st.anR = makeAnalyser(ctx);
      cl.output.connect(st.anL); cr.output.connect(st.anR);
      const mono = track(ctx.createGain()); mono.gain.value = 0.5;
      cl.output.connect(mono); cr.output.connect(mono);
      attachOutput(ctx, st, mono);
    }
  }
}

function applySplit(immediate) {
  if (!audioContext || !split) return;
  const now = audioContext.currentTime, a = clamp(Number(world.vocalSplit) || 0, 0, 1), tc = immediate ? 0.001 : 0.08;
  split.sub[0].gain.setTargetAtTime(-a, now, tc);
  split.sub[1].gain.setTargetAtTime(-a, now, tc);
  split.vg.gain.setTargetAtTime(a, now, tc);
}

// ---------- applying the world ----------
function effectiveGain(st) {
  const anySolo = stems.some(s => s.solo);
  const audible = anySolo ? st.solo : !st.mute;
  return audible ? st.volume * (st.id === "ambience" ? (world.speakerMode ? 0.9 : 1.4) : 1) : 0;
}

// Tiny involuntary head movement. It makes the world feel outside your head,
// the way a real room does. Only matters while World Lock is on.
function swayDeg(t) { return 1.3 * Math.sin(t * 0.5) + 0.7 * Math.sin(t * 1.3 + 1); }

function applyStem(st, immediate) {
  if (!audioContext || !st.panner) return;
  const now = audioContext.currentTime;
  const tc = immediate ? 0.001 : 0.06;
  const room = ROOMS[world.room];
  const lock = world.worldLock;
  const spk = !!world.speakerMode;
  const sway = (world.sway && lock && !spk) ? swayDeg(now) : 0;
  const yaw = (world.listenerYaw + sway) * PI / 180;
  const az = st.azimuth * PI / 180;
  // Where the sound sits on the stage, in world coordinates (x right, z back, stage at -z).
  const dEff = Math.max(1, st.distance + (Number(world.distanceOffset) || 0));
  const wx = Math.sin(az) * dEff, wz = -Math.cos(az) * dEff;
  let rx, rz; // the same spot, relative to where you stand and which way you face
  if (lock) {
    // World Lock: sources stay fixed in the room, so walking and turning change what you hear.
    const dx = wx - world.listenerX, dz = wz - world.listenerZ;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    rx = dx * c + dz * s;
    rz = -dx * s + dz * c;
  } else {
    // Sources ride along with your head (like normal headphones). Walking has no effect.
    rx = wx; rz = wz;
  }
  // Don't let a source sit inside your head when you walk right up to it.
  const flat = Math.hypot(rx, rz);
  if (flat < 0.35) {
    if (flat < 1e-6) { rx = 0; rz = -0.35; } else { rx *= 0.35 / flat; rz *= 0.35 / flat; }
  }
  const d = Math.hypot(rx, st.elev, rz);
  // Speaker mode: plain stereo panning instead of HRTF (HRTF needs headphones). It can't place sounds behind you,
  // so rear sounds fold to the front and get duller to keep some sense of "behind".
  const model = spk ? "equalpower" : "HRTF";
  if (st.panner.panningModel !== model) st.panner.panningModel = model;
  const rear = spk && rz > 0.3;
  st.panner.positionX.setTargetAtTime(rx, now, tc);
  st.panner.positionY.setTargetAtTime(st.elev, now, tc);
  st.panner.positionZ.setTargetAtTime(rz, now, tc);
  st.gain.gain.setTargetAtTime(effectiveGain(st), now, 0.03);
  // Air soaks up treble with distance, so walking away darkens a sound.
  st.damp.frequency.setTargetAtTime(Math.max(5000, 18000 / (1 + 0.09 * (d - 1))) * (rear ? 0.55 : 1), now, tc);
  // Further sounds are wetter: more of what you hear is the room, less is the direct sound.
  const send = room.wet > 0 ? Math.min(1.5, room.wet * world.reverb * (0.25 + 0.09 * d) * st.sendBias) : 0;
  st.send.gain.setTargetAtTime(send, now, 0.05);
}

function applyAll(immediate) {
  if (audioContext && master) {
    const duck = Date.now() < duckUntil ? duckLevel : 1;
    master.gain.setTargetAtTime(world.volume * duck, audioContext.currentTime, 0.05);
  }
  applySplit(immediate);
  for (const st of stems) applyStem(st, immediate);
}

// ---------- analysis ("the AI") ----------
const bufL = new Float32Array(2048), bufR = new Float32Array(2048);

function labelFor(st) {
  if (st.punch > 0.55) st.punchy = true; else if (st.punch < 0.3) st.punchy = false;
  switch (st.id) {
    case "bass": return st.punchy ? "Kick / drums" : "Bass";
    case "body": return st.punchy ? "Toms / low hits" : "Low instruments";
    case "voice": return "Lead vocal";
    case "midL": return st.punchy ? "Hits · left" : "Guitars / keys · left";
    case "midR": return st.punchy ? "Hits · right" : "Guitars / keys · right";
    case "presence": return st.punchy ? "Snare / claps" : "Presence / detail";
    case "air": return "Cymbals / air";
    default: return st.name;
  }
}

function analyse() {
  const n = bufL.length;
  let maxSlow = 1e-5;
  for (const st of stems) {
    if (!st.anL) continue;
    st.anL.getFloatTimeDomainData(bufL);
    let sl = 0, sr = 0, dot = 0;
    if (st.anR) {
      st.anR.getFloatTimeDomainData(bufR);
      for (let i = 0; i < n; i++) { const l = bufL[i], r = bufR[i]; sl += l * l; sr += r * r; dot += l * r; }
    } else {
      for (let i = 0; i < n; i++) { const l = bufL[i]; sl += l * l; }
      sr = sl; dot = sl;
    }
    const rmsL = Math.sqrt(sl / n), rmsR = Math.sqrt(sr / n);
    const level = Math.sqrt((sl + sr) / (2 * n));
    if (level > 0.002) {
      // Only trust stereo measurements while the stem is actually carrying sound.
      const panTarget = (rmsR - rmsL) / (rmsR + rmsL + 1e-9);
      const corr = dot / (Math.sqrt(sl * sr) + 1e-12);
      st.pan += (panTarget - st.pan) * Math.min(0.25, 0.04 + level * 2);
      st.corr += (corr - st.corr) * 0.1;
    }
    st.level += (level - st.level) * 0.4;
    st.slow += (level - st.slow) * 0.02;
    const onset = Math.max(0, level / (st.slow + 1e-4) - 1);
    st.punch += (Math.min(onset, 3) - st.punch) * 0.1;
    st.label = labelFor(st);
    if (st.slow > maxSlow) maxSlow = st.slow;
  }
  if (!world.auto) return;
  const scene = SCENES[world.scene] || SCENES.free;
  const w = world.spread * 2; // "Stage width": 0 = everything in the middle, 1 = normal, 2 = very wide
  for (const st of stems) {
    if (st.manual) continue;
    const rel = st.slow / maxSlow;
    let az, dist;
    const a = scene.anchors?.[st.id];
    if (a) {
      // Scene placement: each sound has a spot on the stage; its own stereo position nudges it.
      if (st.id === "ambience") { az = a.az; dist = a.d; }
      else {
        az = clamp(a.az * w + (st.side ? 0 : st.pan * scene.panWidth * w), -170, 170);
        dist = a.d * (0.9 + 0.25 * (1 - rel)); // quieter sounds sit slightly further back
      }
    } else if (st.id === "ambience") {
      az = 180; dist = 3.5;
    } else {
      // Free mode (same as 0.3): follow the stereo picture, fanning out mono sources by type.
      if (st.side) az = st.side * (15 + 75 * world.spread);
      else {
        const off = st.spreadDeg * (world.spread * 2) * (1 - Math.min(1, Math.abs(st.pan) * 1.5));
        az = clamp(st.pan * 90 + off, -170, 170);
      }
      dist = 1.5 + (1 - rel) * 1.5;
    }
    st.azimuth += (az - st.azimuth) * 0.15;
    st.distance += (dist - st.distance) * 0.1;
  }
}

function tick() {
  if (!active || !audioContext) return;
  // Glide toward the walk target so moving feels like walking, not teleporting.
  world.listenerX += (walkTX - world.listenerX) * 0.2;
  world.listenerZ += (walkTZ - world.listenerZ) * 0.2;
  stepMotions();
  analyse();
  applyAll(false);
}

// ---------- capture lifecycle ----------
async function startCapture(streamId) {
  if (active) await stopCapture();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {mandatory: {chromeMediaSource: "tab", chromeMediaSourceId: streamId}},
      video: false
    });
    audioContext = new AudioContext();
    await audioContext.resume();
    const ctx = audioContext;
    const src = track(ctx.createMediaStreamSource(stream));
    // Force stereo so mono videos feed both channels.
    const stereo = track(ctx.createGain());
    stereo.channelCount = 2; stereo.channelCountMode = "explicit"; stereo.channelInterpretation = "speakers";
    const splitter = track(ctx.createChannelSplitter(2));
    src.connect(stereo); stereo.connect(splitter);

    master = track(ctx.createGain());
    master.gain.value = world.volume;
    limiter = track(ctx.createDynamicsCompressor());
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.15;
    master.connect(limiter); limiter.connect(ctx.destination);
    streamOut = ctx.createMediaStreamDestination(); limiter.connect(streamOut);

    // Room reverb bus (highpassed so the room doesn't get muddy).
    reverbIn = track(ctx.createGain());
    const rhp = track(ctx.createBiquadFilter()); rhp.type = "highpass"; rhp.frequency.value = 140;
    convolver = track(ctx.createConvolver()); convolver.normalize = true;
    reverbLP = track(ctx.createBiquadFilter()); reverbLP.type = "lowpass"; reverbLP.frequency.value = ROOMS[world.room].bright || 16000;
    reverbOut = track(ctx.createGain());
    reverbIn.connect(rhp); rhp.connect(convolver); convolver.connect(reverbLP); reverbLP.connect(reverbOut); reverbOut.connect(master);

    const now = ctx.currentTime, L = ctx.listener;
    if (L.forwardX) {
      L.positionX.setValueAtTime(0, now); L.positionY.setValueAtTime(0, now); L.positionZ.setValueAtTime(0, now);
      L.forwardX.setValueAtTime(0, now); L.forwardY.setValueAtTime(0, now); L.forwardZ.setValueAtTime(-1, now);
      L.upX.setValueAtTime(0, now); L.upY.setValueAtTime(1, now); L.upZ.setValueAtTime(0, now);
    }

    buildGraph(ctx, splitter);
    active = true;
    setRoom(world.room, true);
    applyAll(true);
    timer = setInterval(tick, 50);
    return {ok: true, state: snapshot()};
  } catch (err) {
    await stopCapture();
    return {ok: false, error: `Audio capture failed: ${err.message || err}. Make sure YouTube is playing, then try again.`};
  }
}

async function stopCapture() {
  active = false;
  irToken++;
  if (timer) clearInterval(timer);
  timer = null;
  for (const n of allNodes) { try { n.disconnect(); } catch {} }
  allNodes = [];
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; master = null; limiter = null; reverbIn = null; convolver = null; reverbOut = null; reverbLP = null; split = null;
  for (const st of stems) { st.anL = st.anR = st.damp = st.panner = st.gain = st.send = null; st.level = 0; }
  if (audioContext) { try { await audioContext.close(); } catch {} }
  audioContext = null;
  return {ok: true, state: snapshot()};
}

// ---------- moving sounds (new in 0.8) ----------
// A moving sound follows a path that is computed from the clock, so it stays smooth and keeps
// going with the panel closed. Paths are described in the listener's own frame (right / forward),
// or in the stage's frame, and turned into the same azimuth + distance every other sound uses.
// A moving sound is pinned (manual) so auto-placement leaves it alone.
const MOTION_KINDS = ["orbit", "sweep", "pulse", "figure8"];
const numOr = (v, d) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

function motionBase(around) {
  if (around === "listener" && world.worldLock) return {x: world.listenerX, z: world.listenerZ, yaw: world.listenerYaw * PI / 180};
  return {x: 0, z: 0, yaw: 0};
}
function toLocal(b, x, z) {
  const dx = x - b.x, dz = z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return {right: dx * c + dz * s, forward: dx * s - dz * c};
}
function toWorld(b, right, forward) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return {x: b.x + right * c + forward * s, z: b.z + right * s - forward * c};
}
function stemPoint(st) {
  const a = st.azimuth * PI / 180, d = Math.max(1, st.distance + (Number(world.distanceOffset) || 0));
  return {x: Math.sin(a) * d, z: -Math.cos(a) * d};
}

function setMotion(id, spec) {
  const st = stems.find(s => s.id === id);
  if (!st) return;
  if (!spec || !MOTION_KINDS.includes(spec.kind)) { st.motion = null; return; }
  const around = spec.around === "stage" ? "stage" : "listener";
  const p = stemPoint(st), loc = toLocal(motionBase(around), p.x, p.z);
  const curDist = clamp(Math.hypot(loc.right, loc.forward), 1, 12);
  const curDeg = Math.atan2(loc.right, loc.forward) * 180 / PI;
  const dur = numOr(spec.duration, 0);
  st.motion = {
    kind: spec.kind, around,
    period: clamp(numOr(spec.period, 12), 3, 120),
    dir: numOr(spec.dir, 1) < 0 ? -1 : 1,
    radius: clamp(numOr(spec.radius, curDist), 1, 12),
    startDeg: numOr(spec.startDeg, curDeg),
    fromDeg: clamp(numOr(spec.fromDeg, -50), -180, 180),
    toDeg: clamp(numOr(spec.toDeg, 50), -180, 180),
    deg: numOr(spec.deg, curDeg),
    nearM: clamp(numOr(spec.nearM, Math.max(1, curDist * 0.4)), 1, 12),
    farM: clamp(numOr(spec.farM, Math.min(12, Math.max(curDist * 1.8, 6))), 1, 12),
    distance: clamp(numOr(spec.distance, curDist), 1, 12),
    duration: dur > 0 ? clamp(dur, 3, 600) : 0,
    from: p,                       // glide in from where the sound is now, so it never jumps
    t0: performance.now()
  };
  st.manual = true;
}

function stepMotions() {
  const now = performance.now(), off = Number(world.distanceOffset) || 0;
  for (const st of stems) {
    const m = st.motion;
    if (!m) continue;
    const t = (now - m.t0) / 1000;
    if (m.duration && t > m.duration) { st.motion = null; continue; }   // stays where it ended, pinned
    const ph = t / m.period, ease = 0.5 - 0.5 * Math.cos(2 * PI * ph);
    let right = 0, forward = 0;
    switch (m.kind) {
      case "orbit": {
        const a = m.startDeg * PI / 180 + m.dir * 2 * PI * ph;
        right = Math.sin(a) * m.radius; forward = Math.cos(a) * m.radius; break;
      }
      case "sweep": {
        const a = (m.fromDeg + (m.toDeg - m.fromDeg) * ease) * PI / 180;
        right = Math.sin(a) * m.radius; forward = Math.cos(a) * m.radius; break;
      }
      case "pulse": {
        const d = m.nearM + (m.farM - m.nearM) * ease, a = m.deg * PI / 180;
        right = Math.sin(a) * d; forward = Math.cos(a) * d; break;
      }
      case "figure8": {
        const th = m.dir * 2 * PI * ph;
        right = Math.sin(th) * m.radius; forward = m.distance + Math.sin(2 * th) * m.radius * 0.5; break;
      }
    }
    let p = toWorld(motionBase(m.around), right, forward);
    const k = Math.min(1, t / 1.2);
    if (k < 1) { const e = k * k * (3 - 2 * k); p = {x: m.from.x + (p.x - m.from.x) * e, z: m.from.z + (p.z - m.from.z) * e}; }
    const r = Math.hypot(p.x, p.z);
    st.azimuth = r < 1e-6 ? 0 : Math.atan2(p.x, -p.z) * 180 / PI;
    st.distance = clamp(r - off, 1, 12);
    st.manual = true;
  }
}


// ---------- multi-device WebRTC audio ----------
function wsSend(obj) { if (signalSocket?.readyState === WebSocket.OPEN) signalSocket.send(JSON.stringify(obj)); }
function sendStreamStatus(text) { try { chrome.runtime.sendMessage({type:"STREAM_STATUS", text}).catch(()=>{}); } catch {} }
async function makePeer(peerId) {
  if (!streamOut) throw new Error("Start World Audio on the main device first.");
  if (streamPeers.has(peerId)) return streamPeers.get(peerId);
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  streamPeers.set(peerId, pc);
  if (streamRole === "sender") {
    for (const track of streamOut.stream.getAudioTracks()) pc.addTrack(track, streamOut.stream);
  } else {
    pc.ontrack = (ev) => {
      if (!receiverAudio) {
        receiverAudio = document.createElement("audio");
        receiverAudio.autoplay = true;
        receiverAudio.controls = true;
        receiverAudio.style.cssText = "position:fixed;bottom:8px;right:8px;width:220px;z-index:999999";
        document.body.appendChild(receiverAudio);
      }
      receiverAudio.srcObject = ev.streams[0];
      receiverAudio.play().catch(()=>sendStreamStatus("Tap the receiver audio player to allow playback."));
    };
  }
  pc.onicecandidate = ev => { if (ev.candidate) wsSend({type:"signal",to:peerId,data:{type:"candidate",candidate:ev.candidate}}); };
  pc.onconnectionstatechange = () => sendStreamStatus("Device "+peerId.slice(0,6)+": "+pc.connectionState);
  return pc;
}
async function connectStream({role,server,room}) {
  await disconnectStream();
  if (role === "sender" && !active) throw new Error("Start World Audio on the YouTube device before connecting.");
  streamRole=role; streamRoom=room;
  return await new Promise((resolve,reject)=>{
    let settled=false;
    try { signalSocket = new WebSocket(server); } catch(e) { reject(e); return; }
    const timeout=setTimeout(()=>{if(!settled){settled=true;reject(new Error("Signaling connection timed out."));}},10000);
    signalSocket.onopen=()=>wsSend({type:"join",room,role,client:"world-audio"});
    signalSocket.onerror=()=>{if(!settled){settled=true;clearTimeout(timeout);reject(new Error("Could not reach signaling server. Check its URL and that it is running."));}};
    signalSocket.onmessage=async ev=>{
      let m; try{m=JSON.parse(ev.data)}catch{return}
      try {
        if(m.type==="joined" && !settled){settled=true;clearTimeout(timeout);resolve({ok:true,message:"Connected to session "+room+" as "+role+"."});}
        if(m.type==="peer-joined" && streamRole==="sender") {
          const pc=await makePeer(m.peerId); const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
          wsSend({type:"signal",to:m.peerId,data:{type:"offer",sdp:pc.localDescription}});
        }
        if(m.type==="signal" && m.data) {
          const pc=await makePeer(m.from);
          if(m.data.type==="offer") { await pc.setRemoteDescription(m.data.sdp); const ans=await pc.createAnswer(); await pc.setLocalDescription(ans); wsSend({type:"signal",to:m.from,data:{type:"answer",sdp:pc.localDescription}}); }
          else if(m.data.type==="answer") await pc.setRemoteDescription(m.data.sdp);
          else if(m.data.type==="candidate" && m.data.candidate) await pc.addIceCandidate(m.data.candidate);
        }
        if(m.type==="peer-left"){const pc=streamPeers.get(m.peerId);if(pc)pc.close();streamPeers.delete(m.peerId);}
        if(m.type==="error") sendStreamStatus(m.message||"Signaling server error.");
      } catch(e){sendStreamStatus("WebRTC error: "+(e.message||e));}
    };
    signalSocket.onclose=()=>sendStreamStatus("Signaling server disconnected.");
  });
}
async function disconnectStream(){
  if (manualPeer) { try { manualPeer.close(); } catch {} manualPeer = null; }
  manualVideoChannel = null;
  for(const pc of streamPeers.values()) try{pc.close()}catch{}
  streamPeers.clear();
  if(signalSocket){try{signalSocket.close()}catch{} signalSocket=null}
  if(receiverAudio){receiverAudio.pause();receiverAudio.srcObject=null;receiverAudio.remove();receiverAudio=null}
  streamRole=null; streamRoom=null;
  return {ok:true};
}


// Manual pairing mode: exchanges SDP by copy/paste, so no Node.js or signaling server is needed.
function attachReceiverAudio(pc) {
  pc.ontrack = (ev) => {
    if (!receiverAudio) {
      receiverAudio = document.createElement("audio");
      receiverAudio.autoplay = true; receiverAudio.controls = true;
      receiverAudio.style.cssText = "position:fixed;bottom:8px;right:8px;width:220px;z-index:999999";
      document.body.appendChild(receiverAudio);
    }
    receiverAudio.srcObject = ev.streams[0];
    receiverAudio.play().catch(() => sendStreamStatus("Tap the receiver audio player to allow playback."));
  };
}
function waitForIce(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(done, 12000);
    function done() { clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", check); resolve(); }
    function check() { if (pc.iceGatheringState === "complete") done(); }
    pc.addEventListener("icegatheringstatechange", check);
  });
}
function setupManualVideoChannel(channel) {
  manualVideoChannel = channel;
  channel.onopen = () => sendStreamStatus("Video sync data channel connected.");
  channel.onclose = () => sendStreamStatus("Video sync data channel closed.");
  channel.onerror = () => sendStreamStatus("Video sync data channel error.");
  channel.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && data.kind === "video-state") chrome.runtime.sendMessage({type:"VIDEO_SYNC_RECEIVED", state:data}).catch(()=>{});
    } catch {}
  };
}
function sendManualVideoState(state) {
  if (!manualVideoChannel || manualVideoChannel.readyState !== "open") return {ok:false,error:"Video sync data channel is not connected yet. Complete offer/answer pairing first."};
  manualVideoChannel.send(JSON.stringify(state));
  return {ok:true,message:"Video state sent to connected receivers."};
}

function newManualPeer(role) {
  if (manualPeer) { try { manualPeer.close(); } catch {} }
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  manualPeer = pc; streamRole = role;
  if (role === "sender") {
    setupManualVideoChannel(pc.createDataChannel("world-audio-video-sync", {ordered:true}));
    if (!streamOut) throw new Error("Start World Audio on the main device first.");
    for (const track of streamOut.stream.getAudioTracks()) pc.addTrack(track, streamOut.stream);
  } else {
    attachReceiverAudio(pc);
    pc.ondatachannel = (ev) => { if (ev.channel.label === "world-audio-video-sync") setupManualVideoChannel(ev.channel); };
  }
  pc.onconnectionstatechange = () => sendStreamStatus("Manual pairing: " + pc.connectionState + ".");
  return pc;
}
async function manualCreateOffer() {
  const pc = newManualPeer("sender");
  await pc.setLocalDescription(await pc.createOffer()); await waitForIce(pc);
  return {ok:true, description:JSON.stringify(pc.localDescription), message:"Offer ready. Copy it to the satellite device."};
}
async function manualCreateAnswer(offerText) {
  if (!offerText?.trim()) throw new Error("Paste the offer from the main device first.");
  const pc = newManualPeer("receiver");
  await pc.setRemoteDescription(JSON.parse(offerText));
  await pc.setLocalDescription(await pc.createAnswer()); await waitForIce(pc);
  return {ok:true, description:JSON.stringify(pc.localDescription), message:"Answer ready. Copy it back to the main device."};
}
async function manualApplyAnswer(answerText) {
  if (!manualPeer || streamRole !== "sender") throw new Error("Create an offer on the main device first.");
  if (!answerText?.trim()) throw new Error("Paste the answer from the satellite device.");
  await manualPeer.setRemoteDescription(JSON.parse(answerText));
  return {ok:true, message:"Answer applied. Connecting to the satellite device…"};
}

// ---------- messages ----------
function patchWorld(p = {}) {
  if (Object.prototype.hasOwnProperty.call(p, "customRoomGeom")) {
    const q=p.customRoomGeom;
    world.customRoomGeom = q && Number(q.w)>0 && Number(q.h)>0 ? {w:clamp(Number(q.w),2,100),h:clamp(Number(q.h),2,100),ly:.5} : null;
  }
  if ("listenerYaw" in p) world.listenerYaw = Number(p.listenerYaw) || 0;
  if ("worldLock" in p) world.worldLock = !!p.worldLock;
  if ("distanceOffset" in p) world.distanceOffset = Math.max(0, Number(p.distanceOffset) || 0);
  if ("auto" in p) world.auto = !!p.auto;
  if ("spread" in p) world.spread = clamp(Number(p.spread) || 0, 0, 1);
  if ("reverb" in p) world.reverb = clamp(Number(p.reverb) || 0, 0, 1.5);
  if ("volume" in p) world.volume = clamp(Number(p.volume) || 0, 0, 1.5);
  if ("sway" in p) world.sway = !!p.sway;
  if ("duck" in p) { duckUntil = p.duck ? Date.now() + 20000 : 0; duckLevel = p.duck === "mute" ? 0 : 0.15; }
  if (p.vocalSplit !== undefined) world.vocalSplit = clamp(Number(p.vocalSplit) || 0, 0, 1);
  if (p.speakerMode !== undefined) world.speakerMode = !!p.speakerMode;
  if ("listenerX" in p || "listenerZ" in p) {
    setWalkTarget("listenerX" in p ? p.listenerX : walkTX, "listenerZ" in p ? p.listenerZ : walkTZ, !!p.snap);
  }
  // Scene first (it sets that scene's room), then an explicit room choice overrides it.
  // Both only act on a real change, so sending the whole state again never resets anything.
  if ("scene" in p && SCENES[p.scene] && p.scene !== world.scene) applyScene(p.scene);
  if ("room" in p && ROOMS[p.room] && p.room !== world.room) setRoom(p.room);
}

function patchStem(id, p = {}) {
  const st = stems.find(s => s.id === id);
  if (!st) return;
  if ("azimuth" in p) st.azimuth = clamp(Number(p.azimuth) || 0, -180, 180);
  if ("distance" in p) st.distance = clamp(Number(p.distance) || 1, 1, 12);
  if ("volume" in p) st.volume = clamp(Number(p.volume), 0, 1.5);
  if ("mute" in p) st.mute = !!p.mute;
  if ("solo" in p) st.solo = !!p.solo;
  // Touching direction or distance pins the stem so the auto-placement stops moving it.
  if (("azimuth" in p || "distance" in p) && !("manual" in p)) st.manual = true;
  if ("manual" in p) st.manual = !!p.manual;
  // Dragging, placing or releasing a sound stops its motion.
  if ("azimuth" in p || "distance" in p || ("manual" in p && !p.manual)) st.motion = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  (async () => {
    switch (message.type) {
      case "START_CAPTURE": sendResponse(await startCapture(message.streamId)); break;
      case "STREAM_CONNECT": sendResponse(await connectStream(message)); break;
      case "STREAM_DISCONNECT": sendResponse(await disconnectStream()); break;
      case "MANUAL_CREATE_OFFER": sendResponse(await manualCreateOffer()); break;
      case "MANUAL_CREATE_ANSWER": sendResponse(await manualCreateAnswer(message.description)); break;
      case "MANUAL_APPLY_ANSWER": sendResponse(await manualApplyAnswer(message.description)); break;
      case "VIDEO_SYNC_SEND": sendResponse(sendManualVideoState(message.state || {})); break;
      case "STOP_CAPTURE": sendResponse(await stopCapture()); break;
      case "SET_WORLD": patchWorld(message.patch); applyAll(false); sendResponse({ok: true, state: snapshot()}); break;
      case "SET_STEM": patchStem(message.id, message.patch); applyAll(false); sendResponse({ok: true, state: snapshot()}); break;
      case "RESET":
        world = {...DEFAULT_WORLD, speakerMode: world.speakerMode}; resetStems(); setWalkTarget(0, 0, true); applyScene(world.scene); applyAll(false);
        sendResponse({ok: true, state: snapshot()}); break;
      case "SET_MOTION":
        if (message.id === "all") for (const st of stems) st.motion = null; else setMotion(message.id, message.spec);
        applyAll(false); sendResponse({ok: true, state: snapshot()}); break;
      case "GET_STATE": sendResponse({ok: true, state: snapshot()}); break;
      default: sendResponse({ok: false, error: "Unknown command"});
    }
  })().catch(err => sendResponse({ok: false, error: err?.message || String(err)}));
  return true;
});
