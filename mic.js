// The side panel may not be able to show Chrome's microphone prompt, so the first time the user taps the mic
// this normal tab asks for it. Permission belongs to the extension, so the panel can use it afterwards.
const msg = document.getElementById("msg");
(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({audio: true});
    s.getTracks().forEach(t => t.stop());
    msg.textContent = "Microphone allowed. You can close this tab and tap the mic button in World Audio.";
    setTimeout(() => window.close(), 1800);
  } catch (e) {
    msg.textContent = "The microphone was blocked. Click the camera/lock icon in the address bar, allow the microphone for this extension, then reload this page.";
  }
})();
