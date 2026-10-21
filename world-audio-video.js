(() => {
  if (window.__worldAudioVideoInstalled) return;
  window.__worldAudioVideoInstalled = true;
  let role = null;
  let lastSent = 0;
  let enabled = false;
  let lastVideoId = '';
  const getVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const getId = () => { try { return new URL(location.href).searchParams.get('v') || (location.pathname.match(/\/shorts\/([^/?]+)/)||[])[1] || ''; } catch { return ''; } };
  function state() {
    const v = getVideo();
    if (!v) return null;
    return { kind:'video-state', videoId:getId(), url:location.href, title:document.title.replace(/\s*-\s*YouTube.*$/i,''), currentTime:Number(v.currentTime)||0, paused:!!v.paused, playbackRate:Number(v.playbackRate)||1, sentAt:Date.now() };
  }
  function sendState(force=false) {
    if (!enabled || role !== 'sender') return;
    const now=Date.now(); if (!force && now-lastSent<350) return; lastSent=now;
    const s=state(); if(s) chrome.runtime.sendMessage({type:'VIDEO_SYNC_STATE', state:s}).catch(()=>{});
  }
  function attach() {
    const v=getVideo(); if(!v || v.dataset.waVideoBound==='1') return;
    v.dataset.waVideoBound='1';
    if (role === 'receiver') v.muted = true;
    v.addEventListener('volumechange',()=>{ if(role==='receiver' && !v.muted) v.muted=true; });
    ['play','pause','seeked','ratechange','loadedmetadata'].forEach(ev=>v.addEventListener(ev,()=>sendState(true)));
    v.addEventListener('timeupdate',()=>sendState(false));
    sendState(true);
  }
  const observer = new MutationObserver(()=>{ attach(); const id=getId(); if(id!==lastVideoId){lastVideoId=id; if(enabled&&role==='sender') setTimeout(()=>sendState(true),700);} });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(attach,1500);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if(msg?.type==='WA_VIDEO_ENABLE') {
      enabled=true; role=msg.role; attach();
      if(role==='receiver') { const v=getVideo(); if(v) v.muted=true; }
      sendState(true);
      sendResponse({ok:true, message: role==='sender' ? 'Video sync host enabled. Playback changes will be shared.' : 'Video sync receiver enabled. Waiting for host state.'}); return true;
    }
    if(msg?.type==='WA_VIDEO_GET_STATE') { sendResponse({ok:!!state(), state:state()}); return true; }
    if(msg?.type==='WA_VIDEO_APPLY' && msg.state) {
      const s=msg.state, v=getVideo();
      if(!v) { sendResponse({ok:false,error:'No YouTube video player found on this device.'}); return true; }
      if(s.videoId && getId() && s.videoId!==getId()) { sendResponse({ok:false,error:'The receiver is playing a different video. Open the same YouTube video on both devices.'}); return true; }
      try {
        // Do not extrapolate from sender wall-clock time: device clocks may differ.
        // Repeated state updates and bounded correction handle ordinary playback drift.
        const target=Math.max(0,Number(s.currentTime)||0);
        if(Math.abs(v.currentTime-target)>0.8) v.currentTime=target;
        if(Number(s.playbackRate)>0) v.playbackRate=Number(s.playbackRate);
        if(s.paused) v.pause(); else v.play().catch(()=>{});
        sendResponse({ok:true});
      } catch(e) { sendResponse({ok:false,error:e?.message||String(e)}); }
      return true;
    }
  });
})();
