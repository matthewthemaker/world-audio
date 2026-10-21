WORLD AUDIO 1.1.0 — CHROME EXTENSION + SHORT-CODE RECEIVER WEB APP

CONTENTS
- world-audio-1.1.0/: Chrome extension source, including the receiver page and manual pairing fallback.
- web-app/: static receiver web app for laptops, phones, tablets and compatible smart-TV browsers.
- signaling-server/: optional Node.js WebSocket signaling server for automatic 6-digit code pairing.

1. INSTALL THE EXTENSION (MAIN WINDOWS COMPUTER)
1. Extract this ZIP.
2. In desktop Chrome or Edge, open chrome://extensions.
3. Enable Developer mode, click Load unpacked, and select the world-audio-1.1.0 folder.
4. Open a YouTube video and start World Audio. In the multi-device section, choose Main device.

2. SET UP AUTOMATIC SESSION-CODE PAIRING
1. Deploy the signaling-server folder as a Node.js web service that supports WSS. Follow signaling-server/README.txt. This ZIP does NOT include a live/public signaling server.
2. Host the web-app folder on an HTTPS static site.
3. Copy the public WSS URL ending in /ws into the extension's Signaling server URL field and the receiver app's Signaling server URL field. Replace the placeholder URL.
4. In the extension, click Generate code, then Start automatic pairing. Keep the panel open.
5. On the receiving device, open the hosted receiver app, enter the same six-digit code, and click Connect with code.
6. On a phone/TV, tap Enable audio / TV playback if the browser blocks autoplay.

3. SMART TV SUPPORT
The receiver has a large, remote-friendly numeric code field, so no extension installation or QR scanner is required on the TV. It can work only if that TV's browser supports WebSockets, WebRTC (RTCPeerConnection), and audio playback. TV browser support varies by model/firmware; this software cannot add missing browser features. If the TV browser does not support WebRTC, use a laptop/phone as the receiver instead.

4. MANUAL FALLBACK
The original manual offer/answer text workflow remains available in the receiver app and extension if you do not want to run a signaling server.

PRIVACY AND LIMITATIONS
- The signaling server relays session setup messages only; audio is sent peer-to-peer via WebRTC, not uploaded through the signaling server.
- A six-digit code is a temporary pairing secret. Share it only with trusted devices and use a fresh code for each session.
- Some networks require a TURN relay; none is included.
- One active receiver per session is supported by this beta.
- Syntax and package checks can be performed locally, but real TV and cross-network connections still require testing on the actual devices and a deployed WSS server.
