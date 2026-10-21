(() => {
  const $ = id => document.getElementById(id);
  const status = msg => { $('status').textContent = msg; };
  let pc = null, remoteStream = null, ws = null, senderId = null;
  const cleanCode = value => String(value || '').replace(/\D/g, '').slice(0, 6);
  function waitForIce(connection, timeoutMs = 18000) {
    if (connection.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); connection.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (connection.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, timeoutMs); connection.addEventListener('icegatheringstatechange', check);
    });
  }
  function closePeer() {
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (remoteStream) { for (const track of remoteStream.getTracks()) track.stop(); remoteStream = null; }
    $('remoteAudio').pause(); $('remoteAudio').srcObject = null;
  }
  async function acceptOffer(from, offer) {
    closePeer(); senderId = from; status('Offer received. Preparing audio connection…');
    pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    pc.ontrack = event => {
      remoteStream = event.streams?.[0] || new MediaStream([event.track]);
      $('remoteAudio').srcObject = remoteStream;
      $('remoteAudio').play().then(() => status('Connected! World Audio audio is arriving.')).catch(() => status('Connected. Select Enable audio / TV playback to hear the stream.'));
    };
    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState || 'closed';
      if (state === 'connected') status('Connected! If you cannot hear audio, press Enable audio / TV playback.');
      else if (state === 'failed') status('Connection failed. Try a fresh code session. Some networks require a TURN relay.');
      else if (state === 'disconnected') status('Connection temporarily disconnected. Check both devices and their network.');
    };
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer()); await waitForIce(pc);
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Signaling connection closed before answer was sent.');
    ws.send(JSON.stringify({type:'signal',to:from,data:{kind:'answer',description:pc.localDescription}}));
    status('Answer sent automatically. Waiting for audio connection…');
  }
  function connectWithCode() {
    const url = $('serverUrl').value.trim(), code = cleanCode($('sessionCode').value);
    if (!/^wss:\/\//i.test(url) || /YOUR-SIGNALING-SERVER/i.test(url)) { status('Enter the public WSS signaling-server URL configured by the main device.'); return; }
    if (code.length !== 6) { status('Enter the 6-digit code shown on the main World Audio computer.'); $('sessionCode').focus(); return; }
    $('sessionCode').value = code;
    if (ws) { try { ws.close(); } catch {} ws = null; }
    closePeer(); status('Connecting to the signaling server…');
    try { ws = new WebSocket(url); } catch (e) { status('Could not open signaling connection: ' + (e?.message || e)); return; }
    ws.onopen = () => { ws.send(JSON.stringify({type:'join',room:code,role:'receiver'})); status('Joining session ' + code + '…'); };
    ws.onmessage = async event => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'joined') status('Joined session ' + code + '. Waiting for the main computer…');
      else if (msg.type === 'signal' && msg.data?.kind === 'offer') { try { await acceptOffer(msg.from,msg.data.description); } catch(e) { status('Could not connect: ' + (e?.message || String(e))); } }
      else if (msg.type === 'peer-left') { senderId = null; status('Main device disconnected. Rejoin the session or ask it to restart pairing.'); }
      else if (msg.type === 'error') status('Signaling server: ' + msg.message);
    };
    ws.onerror = () => status('Signaling connection failed. Check the server URL, internet connection, and server deployment.');
    ws.onclose = () => { if (ws) status('Signaling connection closed.'); };
  }
  $('connectCode').addEventListener('click', connectWithCode);
  $('sessionCode').addEventListener('keydown', e => { if (e.key === 'Enter') connectWithCode(); });
  $('stopCode').addEventListener('click', () => { if (ws) { const old=ws; ws=null; try { old.close(); } catch {} } closePeer(); status('Pairing stopped.'); });
  $('answer').addEventListener('click', async () => {
    const text = $('signal').value.trim(); if (!text) { status('Paste an offer first.'); return; }
    try {
      closePeer(); pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
      pc.ontrack = e => { remoteStream=e.streams?.[0]||new MediaStream([e.track]); $('remoteAudio').srcObject=remoteStream; };
      await pc.setRemoteDescription(JSON.parse(text)); await pc.setLocalDescription(await pc.createAnswer()); await waitForIce(pc);
      $('signal').value=JSON.stringify(pc.localDescription); status('Manual answer created. Copy it back to the main computer.');
    } catch(e) { status('Could not create manual answer: '+(e?.message||String(e))); }
  });
  $('copy').addEventListener('click', async () => { if (!$('signal').value.trim()) return status('There is no text to copy yet.'); try { await navigator.clipboard.writeText($('signal').value); status('Text copied.'); } catch { $('signal').focus(); $('signal').select(); status(document.execCommand('copy')?'Text copied.':'Select the text and copy it manually.'); } });
  $('clear').addEventListener('click', () => { $('signal').value=''; status('Manual message cleared.'); });
  $('play').addEventListener('click', async () => { try { if (!$('remoteAudio').srcObject) return status('No audio stream has arrived yet. Connect with a code first.'); $('remoteAudio').muted=false; await $('remoteAudio').play(); status('Audio playback enabled.'); } catch(e) { status('Could not start playback. Check device volume and browser audio restrictions: '+(e?.message||String(e))); } });
  $('disconnect').addEventListener('click', () => { if(ws){const old=ws;ws=null;try{old.close()}catch{}} closePeer(); $('signal').value=''; status('Disconnected.'); });
  window.addEventListener('beforeunload',()=>{if(ws)ws.close();if(pc)pc.close();});
  const params = new URLSearchParams(location.search); if (params.get('code')) $('sessionCode').value = cleanCode(params.get('code'));
})();
