const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 // 10MB तक की फाइल और वॉइस नोट के लिए
});

app.use(express.json());
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ---------------- State ----------------
const activeUsers = {};      // USERNAME -> socket.id
const pendingMessages = {};  // USERNAME -> [{ payload, sentTo:Set }]  (रिसीवर के 'message-delivered' तक सेव)
const fcmTokens = {};        // USERNAME -> Android FCM token
const webSubs = {};          // USERNAME -> Web Push subscription
const pendingCalls = {};     // CALLEE -> { callId, from, offer, callType, ice[], delivered:Set, timer }

const CALL_TTL_MS = 45000;   // कॉल कितनी देर रिंग होगी
const MAX_PENDING_PER_USER = 500;

const norm = (u) => (u || '').toString().trim().toUpperCase();

// ---------------- Firebase (Android push) ----------------
// Render Environment Variable: FIREBASE_SERVICE_ACCOUNT = service account JSON (पूरा)
let admin = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        admin = require('firebase-admin');
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        console.log('Firebase push enabled');
    }
} catch (e) {
    console.error('Firebase init failed:', e.message);
    admin = null;
}

// ---------------- Web Push (Chrome / PWA) ----------------
// Render Environment Variables: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (जैसे mailto:you@example.com)
// कुंजियाँ बनाने के लिए एक बार चलाएँ: npx web-push generate-vapid-keys
let webpush = null;
try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush = require('web-push');
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
            process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        console.log('Web push enabled');
    }
} catch (e) {
    console.error('Web push init failed:', e.message);
    webpush = null;
}

// p: { type: 'incoming_call' | 'missed_call' | 'new_message', from, callId, callType, title, body, ttl, collapseKey }
async function sendFcm(user, p) {
    if (!admin || !fcmTokens[user]) return false;
    const raw = { type: p.type, from: p.from, to: user, callId: p.callId, callType: p.callType, title: p.title, body: p.body };
    const data = {};
    Object.keys(raw).forEach((k) => { if (raw[k] !== undefined && raw[k] !== null) data[k] = String(raw[k]); });
    const message = { token: fcmTokens[user], data, android: { priority: 'high', ttl: p.ttl || 60000 } };
    if (p.collapseKey) message.android.collapseKey = p.collapseKey;
    // कॉल data-only रहती है (नेटिव कोड कॉल स्क्रीन बनाएगा); बाकी में सिस्टम खुद notification दिखा देगा
    if (p.type !== 'incoming_call') message.notification = { title: p.title, body: p.body };
    try {
        await admin.messaging().send(message);
        return true;
    } catch (e) {
        console.error('FCM failed for', user, e.code || e.message);
        if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
            delete fcmTokens[user];
        }
        return false;
    }
}

async function sendWebPush(user, p) {
    if (!webpush || !webSubs[user]) return false;
    const payload = JSON.stringify({ type: p.type, from: p.from, to: user, callId: p.callId, callType: p.callType, title: p.title, body: p.body });
    try {
        await webpush.sendNotification(webSubs[user], payload, { TTL: Math.ceil((p.ttl || 60000) / 1000), urgency: 'high' });
        return true;
    } catch (e) {
        console.error('WebPush failed for', user, e.statusCode || e.message);
        if (e.statusCode === 404 || e.statusCode === 410) delete webSubs[user];
        return false;
    }
}

async function notify(user, p) {
    const results = await Promise.all([sendFcm(user, p), sendWebPush(user, p)]);
    return results.some(Boolean);
}

function clearPendingCall(callee) {
    const c = pendingCalls[callee];
    if (c) {
        clearTimeout(c.timer);
        delete pendingCalls[callee];
    }
    return c;
}

function emitIncomingCall(socketId, call) {
    call.delivered.add(socketId);
    io.to(socketId).emit('incoming-call', { from: call.from, offer: call.offer, callType: call.callType, callId: call.callId });
    call.ice.forEach((c) => io.to(socketId).emit('ice-candidate', { candidate: c }));
}

// ---------------- HTTP ----------------
// public/ फ़ोल्डर में index.html और sw.js रखें -> ऐप सीधे Render के https लिंक से खुलेगा (PWA)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.send('GG Messenger server is running'));
app.get('/health', (req, res) => res.json({ ok: true, online: Object.keys(activeUsers).length }));
app.get('/vapid-public-key', (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || '' }));

// notification का ❌ काटें बटन: ऐप खोले बिना कॉल reject
app.post('/reject-call', (req, res) => {
    const body = req.body || {};
    const to = norm(body.to);
    const from = norm(body.from);
    const pc = pendingCalls[to];
    if (pc && pc.from === from && (!body.callId || body.callId === pc.callId)) {
        clearPendingCall(to);
        const callerSid = activeUsers[from];
        if (callerSid) io.to(callerSid).emit('hangup');
        return res.json({ ok: true });
    }
    res.json({ ok: false });
});

// ---------------- Socket events ----------------
io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    // 1. रजिस्टर + पेंडिंग मैसेज / कॉल डिलीवर करना (हर सॉकेट को हर चीज़ सिर्फ़ एक बार)
    socket.on('register', (username) => {
        const cleanUser = norm(username);
        if (!cleanUser) return;
        activeUsers[cleanUser] = socket.id;
        socket.username = cleanUser;

        io.emit('online-users-list', Object.keys(activeUsers));
        io.emit('user-status-changed', { username: cleanUser, status: 'online' });

        (pendingMessages[cleanUser] || []).forEach((entry) => {
            if (entry.sentTo.has(socket.id)) return;
            entry.sentTo.add(socket.id);
            io.to(socket.id).emit('private-message', entry.payload);
        });

        const pc = pendingCalls[cleanUser];
        if (pc && !pc.delivered.has(socket.id)) emitIncomingCall(socket.id, pc);
    });

    socket.on('register-fcm', (token) => {
        if (!socket.username || !token || typeof token !== 'string') return;
        fcmTokens[socket.username] = token;
    });

    socket.on('register-webpush', (sub) => {
        if (!socket.username || !sub || !sub.endpoint) return;
        webSubs[socket.username] = sub;
    });

    socket.on('check-user-status', (targetUser) => {
        const cleanTarget = norm(targetUser);
        if (!cleanTarget) return;
        socket.emit('user-status-changed', {
            username: cleanTarget,
            status: activeUsers[cleanTarget] ? 'online' : 'offline'
        });
    });

    // 2. मैसेज भेजना
    socket.on('send-message', (data, callback) => {
        if (!data || !data.to || !data.from) return;
        const targetKey = norm(data.to);
        const senderKey = norm(data.from);

        const msgPayload = {
            messageId: data.messageId,
            from: senderKey,
            message: data.message,
            isFile: data.isFile || false,
            fileName: data.fileName || ''
        };

        if (typeof callback === 'function') {
            callback({ status: 'sent', messageId: data.messageId });
        }

        const entry = { payload: msgPayload, sentTo: new Set() };
        if (!pendingMessages[targetKey]) pendingMessages[targetKey] = [];
        pendingMessages[targetKey].push(entry);
        if (pendingMessages[targetKey].length > MAX_PENDING_PER_USER) pendingMessages[targetKey].shift();

        const targetSocketId = activeUsers[targetKey];
        if (targetSocketId) {
            entry.sentTo.add(targetSocketId);
            io.to(targetSocketId).emit('private-message', msgPayload);
        }

        // कुछ देर में डिलीवरी रसीद नहीं आई (ऑफलाइन / बैकग्राउंड) -> push
        setTimeout(() => {
            const stillPending = (pendingMessages[targetKey] || []).some((e) => e.payload.messageId === msgPayload.messageId);
            if (!stillPending) return;
            notify(targetKey, {
                type: 'new_message',
                from: senderKey,
                title: '💬 ' + senderKey,
                body: msgPayload.isFile ? 'फ़ाइल / वॉइस नोट भेजा' : 'नया संदेश',
                ttl: 24 * 3600 * 1000,
                collapseKey: 'msg-' + senderKey
            });
        }, targetSocketId ? 4000 : 0);
    });

    // 3. डिलीवर होने पर डबल टिक
    socket.on('message-delivered', (data) => {
        if (!data || !data.to || !data.messageId) return;
        const receiver = socket.username || norm(data.from);
        if (pendingMessages[receiver]) {
            pendingMessages[receiver] = pendingMessages[receiver].filter((e) => e.payload.messageId !== data.messageId);
        }
        const senderSocketId = activeUsers[norm(data.to)];
        if (senderSocketId) {
            io.to(senderSocketId).emit('message-status-update', { from: data.from, messageId: data.messageId, status: 'delivered' });
        }
    });

    // 4. देख लेने पर नीला टिक
    socket.on('message-seen', (data) => {
        if (!data || !data.to) return;
        const senderSocketId = activeUsers[norm(data.to)];
        if (senderSocketId) {
            io.to(senderSocketId).emit('message-status-update', { from: data.from, messageId: data.messageId, status: 'seen' });
        }
    });

    socket.on('mark-seen', (data) => {
        if (!data || !data.to) return;
        const senderSocketId = activeUsers[norm(data.to)];
        if (senderSocketId) {
            io.to(senderSocketId).emit('all-messages-seen', { from: norm(data.from) });
        }
    });

    // 5. WebRTC कॉलिंग
    socket.on('call-user', (data) => {
        if (!data || !data.to) return;
        const to = norm(data.to);
        const from = socket.username || norm(data.from);
        if (!to || !from) return;

        clearPendingCall(to);

        const callId = data.callId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        const call = { callId, from, offer: data.offer, callType: data.callType, ice: [], delivered: new Set() };

        // 45 सेकंड में किसी ने नहीं उठाई -> मिस्ड कॉल
        call.timer = setTimeout(() => {
            if (pendingCalls[to] !== call) return;
            delete pendingCalls[to];
            const callerSid = activeUsers[from];
            if (callerSid) {
                io.to(callerSid).emit('call-status', { status: 'no-answer', to });
                io.to(callerSid).emit('hangup');
            }
            const calleeSid = activeUsers[to];
            if (calleeSid) io.to(calleeSid).emit('hangup');
            notify(to, {
                type: 'missed_call', from, callId,
                title: '📵 मिस्ड कॉल', body: from + ' का कॉल छूट गया',
                ttl: 24 * 3600 * 1000
            });
        }, CALL_TTL_MS);

        pendingCalls[to] = call;

        const targetSocketId = activeUsers[to];
        if (targetSocketId) emitIncomingCall(targetSocketId, call);

        // हमेशा push भी भेजें: ऐप बैकग्राउंड/बंद हो तो यही notification (उठाएँ/काटें बटन) दिखाएगा
        // SDP offer push में नहीं जाता; ऐप खुलते ही 'register' पर सर्वर कॉल भेज देता है
        notify(to, {
            type: 'incoming_call', from, callId, callType: data.callType || 'audio',
            title: '📞 आने वाली कॉल',
            body: from + ' आपको ' + (data.callType === 'video' ? 'वीडियो' : 'ऑडियो') + ' कॉल कर रहे हैं',
            ttl: CALL_TTL_MS
        }).then((pushed) => {
            socket.emit('call-status', { status: (!targetSocketId && !pushed) ? 'callee-offline' : 'ringing', to });
        });
    });

    socket.on('make-answer', (data) => {
        if (!data || !data.to) return;
        if (socket.username) clearPendingCall(socket.username); // कॉल उठ गई
        const targetSocketId = activeUsers[norm(data.to)];
        if (targetSocketId) io.to(targetSocketId).emit('call-answered', { answer: data.answer });
    });

    socket.on('ice-candidate', (data) => {
        if (!data || !data.to) return;
        const to = norm(data.to);
        const pc = pendingCalls[to];
        if (pc && pc.from === socket.username && data.candidate) pc.ice.push(data.candidate);

        const targetSocketId = activeUsers[to];
        if (targetSocketId) io.to(targetSocketId).emit('ice-candidate', { candidate: data.candidate });
    });

    socket.on('hangup', (data) => {
        if (!data || !data.to) return;
        const to = norm(data.to);
        const me = socket.username;

        if (me) {
            const outgoing = pendingCalls[to];
            if (outgoing && outgoing.from === me) {
                // कॉलर ने उठने से पहले काट दी -> रिंग बंद + मिस्ड कॉल
                clearPendingCall(to);
                notify(to, {
                    type: 'missed_call', from: me, callId: outgoing.callId,
                    title: '📵 मिस्ड कॉल', body: me + ' का कॉल छूट गया',
                    ttl: 24 * 3600 * 1000
                });
            }
            const incoming = pendingCalls[me];
            if (incoming && incoming.from === to) clearPendingCall(me); // रिसीवर ने reject किया
        }

        const targetSocketId = activeUsers[to];
        if (targetSocketId) io.to(targetSocketId).emit('hangup');
    });

    // 6. डिस्कनेक्ट
    socket.on('disconnect', () => {
        let disconnectedUser = '';
        for (const username in activeUsers) {
            if (activeUsers[username] === socket.id) {
                disconnectedUser = username;
                delete activeUsers[username];
                break;
            }
        }
        if (disconnectedUser) {
            io.emit('user-status-changed', { username: disconnectedUser, status: 'offline' });
            io.emit('online-users-list', Object.keys(activeUsers));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
