const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

// In-memory frame store per channel
const channelFrames = {};
const channelViewers = {};

// 1. Admin phone sends captured screen frames here
app.post('/publish/:channel', express.raw({ type: 'image/jpeg', limit: '10mb' }), (req, res) => {
    const channel = req.params.channel;
    channelFrames[channel] = req.body;

    // Send latest frame to all connected internet viewers
    if (channelViewers[channel]) {
        channelViewers[channel].forEach(v => {
            try {
                v.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${req.body.length}\r\n\r\n`);
                v.write(req.body);
                v.write('\r\n');
            } catch (e) {}
        });
    }
    res.sendStatus(200);
});

// 2. Viewers on any network watch the live stream here
app.get('/watch/:channel', (req, res) => {
    const channel = req.params.channel;
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--frame');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, private');

    if (!channelViewers[channel]) channelViewers[channel] = [];
    channelViewers[channel].push(res);

    // Send initial frame if available
    if (channelFrames[channel]) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${channelFrames[channel].length}\r\n\r\n`);
        res.write(channelFrames[channel]);
        res.write('\r\n');
    }

    req.on('close', () => {
        channelViewers[channel] = channelViewers[channel].filter(v => v !== res);
    });
});

app.get('/', (req, res) => res.send('ScreenStream Cloud Relay is Online!'));

app.listen(PORT, () => console.log(`Stream Relay active on port ${PORT}`));