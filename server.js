const res = await fetch('/audio/' + channelId + '?t=' + Date.now());
const reader = res.body.getReader();
// Streams PCM samples directly into AudioContext with near-zero latency