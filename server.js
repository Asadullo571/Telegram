const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===== HELPERS =====
function getColor(seed) {
    const colors = ['#667eea','#f093fb','#4facfe','#fa709a','#30cfd0','#e86ba7','#4ecc5e','#f7971e','#43e97b','#6a11cb'];
    let n = 0;
    for (let c of String(seed)) n += c.charCodeAt(0);
    return colors[n % colors.length];
}

// ===== DB =====
const users     = new Map(); // email -> user
const online    = new Map(); // socketId -> email
const messages  = new Map(); // chatKey -> [msg]
const groups    = new Map(); // groupId -> group
const usernames = new Set(); // band username'lar

// ===== SOCKET =====
io.on('connection', (socket) => {
    console.log('🔌 Ulandi:', socket.id);

    // REGISTER
    socket.on('register', ({ email, name, username, avatar }) => {
        if (!email || !name) return;

        // Username band tekshirish
        if (username && !users.has(email)) {
            const clean = username.replace('@', '');
            if (usernames.has(clean)) {
                socket.emit('registration-error', { message: `@${clean} allaqachon band!` });
                return;
            }
            usernames.add(clean);
        }

        // Eski socketni tozalash
        const old = users.get(email);
        if (old?.socketId && old.socketId !== socket.id) {
            online.delete(old.socketId);
        }

        users.set(email, {
            id: email, email, name,
            username: username || ('@' + email.split('@')[0]),
            avatar: avatar || getColor(email),
            socketId: socket.id,
            online: true,
            lastSeen: new Date()
        });
        online.set(socket.id, email);

        // Barcha userlarga ro'yxat yuborish
        const userList = Array.from(users.values()).map(u => ({
            id: u.email, email: u.email, name: u.name,
            username: u.username, avatar: u.avatar,
            online: u.online, lastSeen: u.lastSeen
        }));
        io.emit('users-list', userList);

        // Barcha guruhllarni HAMMAGA yuborish
        const groupList = Array.from(groups.values()).map(g => ({
            id: g.id, name: g.name, username: g.username,
            type: g.type, avatar: g.avatar,
            members: g.members, admins: g.admins, createdBy: g.createdBy
        }));
        io.emit('groups-list', groupList);

        io.emit('user-online', { userId: email, online: true });
        console.log(`✅ ${name} (${email})`);
    });

    // SEND MESSAGE
    socket.on('send-message', ({ senderId, receiverId, text, timestamp, replyTo }) => {
        if (!senderId || !receiverId || !text) return;

        const msg = {
            id: Date.now().toString() + Math.random().toString(36).slice(2),
            senderId, receiverId,
            text: text.trim(),
            timestamp: timestamp || new Date(),
            replyTo: replyTo || null,
            read: false, edited: false
        };

        const key = [senderId, receiverId].sort().join('::');
        if (!messages.has(key)) messages.set(key, []);
        messages.get(key).push(msg);

        const receiver = users.get(receiverId);
        if (receiver?.online) {
            io.to(receiver.socketId).emit('receive-message', msg);
        }
        socket.emit('message-sent', msg);
        console.log(`💬 ${senderId} → ${receiverId}: ${text.slice(0, 30)}`);
    });

    // GET MESSAGES
    socket.on('get-messages', ({ user1, user2 }) => {
        const key = [user1, user2].sort().join('::');
        socket.emit('messages-history', messages.get(key) || []);
    });

    // MARK AS READ
    socket.on('mark-as-read', ({ senderId, receiverId }) => {
        const key = [senderId, receiverId].sort().join('::');
        const chat = messages.get(key) || [];
        chat.forEach(msg => {
            if (msg.senderId === senderId && msg.receiverId === receiverId) {
                msg.read = true;
            }
        });
        const sender = users.get(senderId);
        if (sender?.online) {
            io.to(sender.socketId).emit('messages-read', { receiverId });
        }
    });

    // EDIT MESSAGE
    socket.on('edit-message', ({ messageId, chatKey, newText, senderId }) => {
        const chat = messages.get(chatKey) || [];
        const msg = chat.find(m => m.id === messageId);
        if (msg && msg.senderId === senderId) {
            msg.text = newText.trim();
            msg.edited = true;
            chatKey.split('::').forEach(email => {
                const u = users.get(email);
                if (u?.online) io.to(u.socketId).emit('message-edited', { messageId, newText: msg.text, chatKey });
            });
        }
    });

    // DELETE MESSAGE
    socket.on('delete-message', ({ messageId, chatKey, senderId, deleteFor }) => {
        const chat = messages.get(chatKey) || [];
        const idx = chat.findIndex(m => m.id === messageId);
        if (idx === -1 || chat[idx].senderId !== senderId) return;

        if (deleteFor === 'everyone') {
            chat.splice(idx, 1);
            chatKey.split('::').forEach(email => {
                const u = users.get(email);
                if (u?.online) io.to(u.socketId).emit('message-deleted', { messageId, chatKey });
            });
        } else {
            socket.emit('message-deleted', { messageId, chatKey });
        }
    });

    // TYPING
    socket.on('typing', ({ senderId, receiverId, isTyping }) => {
        const receiver = users.get(receiverId);
        if (receiver?.online) {
            io.to(receiver.socketId).emit('user-typing', { senderId, isTyping });
        }
    });

    // CREATE GROUP / CHANNEL
    socket.on('create-group', ({ name, username, type, createdBy }) => {
        if (!name || !username || !createdBy) return;
        const clean = username.replace('@', '');

        if (usernames.has(clean)) {
            socket.emit('group-error', { message: `@${clean} allaqachon band!` });
            return;
        }

        const groupId = 'g_' + Date.now();
        const group = {
            id: groupId,
            name: name.trim(),
            username: '@' + clean,
            type: type || 'group',
            avatar: getColor(name),
            members: [createdBy],
            admins: [createdBy],
            createdBy,
            createdAt: new Date()
        };

        groups.set(groupId, group);
        usernames.add(clean);

        // Barcha userlarga yangi guruh yuborish
        io.emit('new-group', group);
        socket.emit('group-created', group);
        console.log(`📢 Yangi ${type}: ${name} (@${clean})`);
    });

    // JOIN GROUP
    socket.on('join-group', ({ groupId, userId }) => {
        const group = groups.get(groupId);
        if (!group) return;
        if (!group.members.includes(userId)) {
            group.members.push(userId);
        }
        // Har doim group-updated yuborish
        io.emit('group-updated', group);
    });

    // LEAVE GROUP
    socket.on('leave-group', ({ groupId, userId }) => {
        const group = groups.get(groupId);
        if (!group) return;
        group.members = group.members.filter(m => m !== userId);
        group.admins  = group.admins.filter(a => a !== userId);
        io.emit('group-updated', group);
        socket.emit('left-group', { groupId });
    });

    // SEND GROUP MESSAGE
    socket.on('send-group-message', ({ groupId, senderId, text, timestamp, replyTo }) => {
        const group = groups.get(groupId);
        if (!group || !text) return;

        // A'zo emasmi — avtomatik qo'shib yuborish
        if (!group.members.includes(senderId)) {
            group.members.push(senderId);
            io.emit('group-updated', group);
        }

        const msg = {
            id: Date.now().toString() + Math.random().toString(36).slice(2),
            groupId, senderId,
            text: text.trim(),
            timestamp: timestamp || new Date(),
            replyTo: replyTo || null,
            type: 'group'
        };

        if (!messages.has(groupId)) messages.set(groupId, []);
        messages.get(groupId).push(msg);

        group.members.forEach(memberId => {
            const member = users.get(memberId);
            if (member?.online) {
                io.to(member.socketId).emit('receive-group-message', { message: msg, group });
            }
        });

        console.log(`📢 [${group.name}] ${senderId}: ${text.slice(0, 30)}`);
    });

    // GET GROUP MESSAGES
    socket.on('get-group-messages', ({ groupId }) => {
        socket.emit('group-messages-history', messages.get(groupId) || []);
    });

    // REACTION
    socket.on('add-reaction', ({ messageId, chatKey, emoji, userId }) => {
        const chat = messages.get(chatKey) || [];
        const msg = chat.find(m => m.id === messageId);
        if (!msg) return;

        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

        const idx = msg.reactions[emoji].indexOf(userId);
        if (idx === -1) {
            msg.reactions[emoji].push(userId);
        } else {
            msg.reactions[emoji].splice(idx, 1);
            if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
        }

        const notify = (ids) => ids.forEach(id => {
            const u = users.get(id);
            if (u?.online) io.to(u.socketId).emit('reaction-updated', { messageId, reactions: msg.reactions, chatKey });
        });

        if (chatKey.includes('::')) {
            notify(chatKey.split('::'));
        } else {
            const group = groups.get(chatKey);
            if (group) notify(group.members);
        }
    });

    // ===== QIDIRUV (SEARCH) QO'SHILGAN QISM =====
    socket.on('search', (query) => {
        const term = query.toLowerCase().replace('@', '').trim();
        if (!term) return;

        // Foydalanuvchilarni qidirish
        const foundUsers = Array.from(users.values())
            .filter(u => 
                (u.username && u.username.toLowerCase().includes(term)) || 
                (u.name && u.name.toLowerCase().includes(term))
            )
            .map(u => ({ id: u.email, name: u.name, username: u.username, type: 'user', avatar: u.avatar, online: u.online }));

        // Guruh va kanallarni qidirish
        const foundGroups = Array.from(groups.values())
            .filter(g => 
                (g.username && g.username.toLowerCase().includes(term)) || 
                (g.name && g.name.toLowerCase().includes(term))
            )
            .map(g => ({ id: g.id, name: g.name, username: g.username, type: g.type, avatar: g.avatar }));

        socket.emit('search-results', [...foundUsers, ...foundGroups]);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        const email = online.get(socket.id);
        if (email) {
            const user = users.get(email);
            if (user) {
                user.online = false;
                user.lastSeen = new Date();
                io.emit('user-offline', { userId: email, lastSeen: user.lastSeen });
            }
            online.delete(socket.id);
        }
        console.log('❌ Uzildi:', socket.id);
    });
});

// ===== REST API =====
app.get('/api/users', (req, res) => {
    res.json(Array.from(users.values()).map(u => ({
        id: u.email, name: u.name, username: u.username,
        online: u.online, lastSeen: u.lastSeen
    })));
});

app.get('/api/stats', (req, res) => {
    res.json({
        users: users.size,
        groups: groups.size,
        messages: Array.from(messages.values()).reduce((a, b) => a + b.length, 0),
        online: Array.from(users.values()).filter(u => u.online).length
    });
});

// ===== START =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server: http://localhost:${PORT}`);
    console.log(`📊 Stats: http://localhost:${PORT}/api/stats`);
});
