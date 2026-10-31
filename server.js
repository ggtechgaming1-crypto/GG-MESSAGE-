const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 1e7 // 10MB तक की फाइल और वॉइस नोट के लिए
});

const activeUsers = {};
const pendingMessages = {}; // ऑफलाइन यूजर्स के मैसेज सेव रखने के लिए

io.on('connection', (socket) => {
    console.log('User connected: ' + socket.id);

    // 1. यूजर रजिस्टर होना और पेंडिंग मैसेज डिलीवर करना
    socket.on('register', (username) => {
        if (!username) return;
        const cleanUser = username.trim().toUpperCase();
        activeUsers[cleanUser] = socket.id;
        socket.username = cleanUser;

        // सभी को ऑनलाइन यूजर्स की लिस्ट और स्टेटस भेजें
        io.emit('online-users-list', Object.keys(activeUsers));
        io.emit('user-status-changed', { username: cleanUser, status: 'online' });

        // अगर यूजर के ऑफलाइन रहते कोई मैसेज आया था, तो तुरंत भेजें
        if (pendingMessages[cleanUser] && pendingMessages[cleanUser].length > 0) {
            pendingMessages[cleanUser].forEach((msg) => {
                io.to(socket.id).emit('private-message', msg);
                // भेजने वाले को डबल टिक (Delivered) भेजें
                const senderSocket = activeUsers[msg.from];
                if (senderSocket) {
                    io.to(senderSocket).emit('message-status-update', {
                        from: cleanUser,
                        messageId: msg.messageId,
                        status: 'delivered'
                    });
                }
            });
            pendingMessages[cleanUser] = [];
        }
    });

    // किसी खास यूजर का स्टेटस चेक करना
    socket.on('check-user-status', (targetUser) => {
        if (!targetUser) return;
        const cleanTarget = targetUser.trim().toUpperCase();
        const isOnline = !!activeUsers[cleanTarget];
        socket.emit('user-status-changed', {
            username: cleanTarget,
            status: isOnline ? 'online' : 'offline'
        });
    });

    // 2. मैसेज भेजना + सिंगल/डबल टिक कन्फर्मेशन
    socket.on('send-message', (data, callback) => {
        if (!data || !data.to || !data.from) return;
        const targetKey = data.to.trim().toUpperCase();
        const senderKey = data.from.trim().toUpperCase();
        const targetSocketId = activeUsers[targetKey];

        const msgPayload = {
            messageId: data.messageId,
            from: senderKey,
            message: data.message,
            isFile: data.isFile || false,
            fileName: data.fileName || ''
        };

        // भेजने वाले को तुरंत 1 टिक (Sent) का सिग्नल दें
        if (typeof callback === 'function') {
            callback({ status: 'sent', messageId: data.messageId });
        }

        if (targetSocketId) {
            // सामने वाला ऑनलाइन है -> तुरंत मैसेज भेजें
            io.to(targetSocketId).emit('private-message', msgPayload);
        } else {
            // सामने वाला ऑफलाइन है -> क्यू में सेव करें
            if (!pendingMessages[targetKey]) pendingMessages[targetKey] = [];
            pendingMessages[targetKey].push(msgPayload);
        }
    });

    // 3. मैसेज रिसीव होने पर डबल टिक (Delivered) अपडेट करना
    socket.on('message-delivered', (data) => {
        if (!data || !data.to) return;
        const senderSocketId = activeUsers[data.to.trim().toUpperCase()];
        if (senderSocketId) {
            io.to(senderSocketId).emit('message-status-update', {
                from: data.from,
                messageId: data.messageId,
                status: 'delivered'
            });
        }
    });

    // 4. मैसेज देख लेने पर नीला टिक (Blue Seen Tick) अपडेट करना
    socket.on('message-seen', (data) => {
        if (!data || !data.to) return;
        const senderSocketId = activeUsers[data.to.trim().toUpperCase()];
        if (senderSocketId) {
            io.to(senderSocketId).emit('message-status-update', {
                from: data.from,
                messageId: data.messageId,
                status: 'seen'
            });
        }
    });

    // पूरी चैट खोलने पर सभी पुराने मैसेज को एक साथ Blue Tick करना
    socket.on('mark-seen', (data) => {
        if (!data || !data.to) return;
        const senderSocketId = activeUsers[data.to.trim().toUpperCase()];
        if (senderSocketId) {
            io.to(senderSocketId).emit('all-messages-seen', {
                from: data.from.trim().toUpperCase()
            });
        }
    });

    // 5. WebRTC कॉलिंग इवेंट्स
    socket.on('call-user', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.trim().toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('incoming-call', {
                    from: data.from.trim().toUpperCase(),
                    offer: data.offer,
                    callType: data.callType
                });
            }
        }
    });

    socket.on('make-answer', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.trim().toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('call-answered', { answer: data.answer });
            }
        }
    });

    socket.on('ice-candidate', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.trim().toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('ice-candidate', { candidate: data.candidate });
            }
        }
    });

    socket.on('hangup', (data) => {
        if (data && data.to) {
            const targetSocketId = activeUsers[data.to.trim().toUpperCase()];
            if (targetSocketId) {
                io.to(targetSocketId).emit('hangup');
            }
        }
    });

    // 6. डिस्कनेक्ट होने पर ऑफलाइन स्टेटस भेजना
    socket.on('disconnect', () => {
        let disconnectedUser = '';
        for (let username in activeUsers) {
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
