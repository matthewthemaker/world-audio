// World Audio v0.9.9 minimal WebRTC signaling relay.
// Deploy behind HTTPS/WSS for use across the internet. Signaling only; audio travels peer-to-peer.
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const port = Number(process.env.PORT || 8787);
const wss = new WebSocketServer({ host: process.env.HOST || "0.0.0.0", port, path: "/ws" });
const rooms = new Map();
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
wss.on("connection", ws => {
  ws.id = crypto.randomUUID(); ws.room = null; ws.role = null;
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return send(ws,{type:"error",message:"Invalid JSON"}); }
    if (m.type === "join") {
      const room = String(m.room || "").trim().replace(/\D/g, "").slice(0,6);
      const role = m.role === "sender" ? "sender" : "receiver";
      if (room.length !== 6) return send(ws,{type:"error",message:"Enter a 6-digit session code"});
      ws.room=room; ws.role=role;
      if (!rooms.has(room)) rooms.set(room,new Map());
      const peers=rooms.get(room);
      // One sender and one receiver per room; the extension currently supports one active peer.
      if ([...peers.values()].some(p => p.role === role)) {
        ws.room=null; return send(ws,{type:"error",message: role === "sender" ? "This session already has a main device." : "A receiver is already using this session. Generate a new code for another receiver."});
      }
      ws.send(JSON.stringify({type:"joined",peerId:ws.id,peers:[...peers.keys()]}));
      for (const [id,p] of peers) {
        send(p,{type:"peer-joined",peerId:ws.id,role});
        if (role==="sender") send(ws,{type:"peer-joined",peerId:id,role:p.role});
      }
      peers.set(ws.id,ws);
      return;
    }
    if (m.type === "signal" && ws.room) {
      const peer=rooms.get(ws.room)?.get(String(m.to));
      if (peer) send(peer,{type:"signal",from:ws.id,data:m.data});
    }
  });
  ws.on("close",()=>{
    if (!ws.room) return;
    const peers=rooms.get(ws.room); if(!peers)return;
    peers.delete(ws.id);
    for(const p of peers.values()) send(p,{type:"peer-left",peerId:ws.id});
    if(!peers.size) rooms.delete(ws.room);
  });
});
console.log(`World Audio signaling server listening on ws://localhost:${port}/ws`);
