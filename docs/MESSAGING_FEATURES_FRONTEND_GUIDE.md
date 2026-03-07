# Frontend Integration Guide: Messaging Features

## Quick Summary

**Three Major Features Implemented:**
1. ✅ **Delete for Everyone** - 24-hour time limit for deleting messages for all participants
2. ✅ **Online Status & Last Seen** - Privacy controls (everyone, followers, nobody)
3. ✅ **Message Status Indicators** - Sent, Delivered, Seen ticks (single/double/blue)

**Main Frontend Changes Required:**
1. Add UI for "Delete for Me" vs "Delete for Everyone" options
2. Implement privacy settings UI for online status and last seen
3. Display message status ticks (sent/delivered/seen)
4. Emit Socket.IO events for delivery confirmation
5. Listen for real-time status update events

---

## Feature 1: Delete for Everyone (24-Hour Time Limit)

### Backend Changes Summary
- Messages can be deleted for everyone within 24 hours of sending
- After 24 hours, only "Delete for Me" option is available
- Two new endpoints and updated Socket.IO events

### API Endpoints

#### 1. Delete Message for Everyone (24-hour limit)
```http
DELETE /api/v1/chats/:chatId/messages/:messageId
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "statusCode": 200,
  "data": {},
  "message": "Message deleted for everyone successfully",
  "success": true
}
```

**Error Response (400) - After 24 hours:**
```json
{
  "statusCode": 400,
  "message": "Cannot delete messages older than 24 hours. Use 'Delete for Me' instead.",
  "success": false
}
```

#### 2. Delete Message for Me (no time limit)
```http
DELETE /api/v1/chats/:chatId/messages/:messageId/for-me
Authorization: Bearer <token>
```

**Success Response (200):**
```json
{
  "statusCode": 200,
  "data": {},
  "message": "Message deleted for you successfully",
  "success": true
}
```

### Socket.IO Events

#### Listen for deletion events:

**Event: `message_deleted_for_everyone`**
```javascript
socket.on('message_deleted_for_everyone', (data) => {
  console.log('Message deleted for everyone:', data);
  // data: { chatId, messageId, deletedBy: { _id, username, fullName } }

  // Update UI: Replace message with "[Message deleted]" placeholder
  updateMessageInUI(data.chatId, data.messageId, {
    message: '[Message deleted]',
    isDeleted: true
  });
});
```

**Event: `message_deleted_for_me`**
```javascript
socket.on('message_deleted_for_me', (data) => {
  console.log('Message deleted for me:', data);
  // data: { chatId, messageId }

  // Update UI: Remove message from chat
  removeMessageFromUI(data.chatId, data.messageId);
});
```

### Frontend Implementation

#### 1. Add Delete Options UI

Create a message context menu with two delete options:

```javascript
// Calculate if message is within 24 hours
const isWithin24Hours = (messageTimestamp) => {
  const messageTime = new Date(messageTimestamp).getTime();
  const currentTime = Date.now();
  const hoursDiff = (currentTime - messageTime) / (1000 * 60 * 60);
  return hoursDiff <= 24;
};

// Show delete options
const showDeleteOptions = (message) => {
  const within24Hours = isWithin24Hours(message.timestamp);
  const isSender = message.sender._id === currentUserId;

  if (!isSender) return null; // Only sender can delete

  return (
    <ContextMenu>
      {/* Always show Delete for Me */}
      <MenuItem onClick={() => deleteForMe(message._id)}>
        Delete for Me
      </MenuItem>

      {/* Show Delete for Everyone only within 24 hours */}
      {within24Hours && (
        <MenuItem onClick={() => deleteForEveryone(message._id)}>
          Delete for Everyone
        </MenuItem>
      )}
    </ContextMenu>
  );
};
```

#### 2. Implement Delete Functions

```javascript
// Delete for everyone (24-hour limit)
const deleteForEveryone = async (messageId) => {
  try {
    await axios.delete(`/chats/${chatId}/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Success - message will be updated via Socket event
    showToast('Message deleted for everyone');
  } catch (error) {
    if (error.response?.status === 400) {
      // After 24 hours
      showToast('Cannot delete messages older than 24 hours');
    } else {
      showToast('Failed to delete message');
    }
  }
};

// Delete for me (no time limit)
const deleteForMe = async (messageId) => {
  try {
    await axios.delete(`/chats/${chatId}/messages/${messageId}/for-me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    // Success - message will be removed via Socket event
    showToast('Message deleted for you');
  } catch (error) {
    showToast('Failed to delete message');
  }
};
```

#### 3. UI/UX Recommendations

- Show "[Message deleted]" placeholder for messages deleted for everyone
- Add a trash icon or "Deleted" badge next to deleted messages
- Disable delete for everyone option after 24 hours (grey out or hide)
- Show countdown timer (optional): "Delete for everyone available for 23h 45m"

---

## Feature 2: Online Status & Last Seen with Privacy Controls

### Backend Changes Summary
- Users can control who sees their online status and last seen
- Privacy options: everyone, followers, nobody
- Privacy reciprocity: If you hide your status, you can't see others'

### API Endpoints

#### 1. Get Messaging Privacy Settings
```http
GET /api/v1/users/messaging/privacy
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "privacy": {
      "onlineStatus": "everyone",
      "lastSeen": "followers"
    }
  },
  "message": "Messaging privacy settings retrieved successfully",
  "success": true
}
```

#### 2. Update Messaging Privacy Settings
```http
PATCH /api/v1/users/messaging/privacy
Authorization: Bearer <token>
Content-Type: application/json

{
  "onlineStatus": "followers",  // "everyone" | "followers" | "nobody"
  "lastSeen": "nobody"          // "everyone" | "followers" | "nobody"
}
```

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "privacy": {
      "onlineStatus": "followers",
      "lastSeen": "nobody"
    }
  },
  "message": "Messaging privacy settings updated successfully",
  "success": true
}
```

#### 3. Get Online Status (with privacy filtering)
```http
GET /api/v1/chats/users/online-status?userIds=userId1,userId2,userId3
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "onlineStatus": {
      "userId1": {
        "online": true,
        "lastSeen": "2026-01-09T10:30:00.000Z"
      },
      "userId2": {
        "online": false,
        "lastSeen": null  // Hidden due to privacy settings
      },
      "userId3": {
        "online": false,
        "lastSeen": "2026-01-09T08:15:00.000Z"
      }
    }
  },
  "message": "Online status fetched successfully",
  "success": true
}
```

### Frontend Implementation

#### 1. Add Privacy Settings UI

Create a settings page for messaging privacy:

```javascript
const MessagingPrivacySettings = () => {
  const [onlineStatus, setOnlineStatus] = useState('everyone');
  const [lastSeen, setLastSeen] = useState('everyone');

  useEffect(() => {
    // Fetch current settings
    fetchPrivacySettings();
  }, []);

  const fetchPrivacySettings = async () => {
    try {
      const response = await axios.get('/users/messaging/privacy', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const { privacy } = response.data.data;
      setOnlineStatus(privacy.onlineStatus || 'everyone');
      setLastSeen(privacy.lastSeen || 'everyone');
    } catch (error) {
      console.error('Failed to fetch privacy settings:', error);
    }
  };

  const updatePrivacySettings = async () => {
    try {
      await axios.patch('/users/messaging/privacy', {
        onlineStatus,
        lastSeen
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      showToast('Privacy settings updated');
    } catch (error) {
      showToast('Failed to update privacy settings');
    }
  };

  return (
    <div className="privacy-settings">
      <h2>Messaging Privacy</h2>

      {/* Online Status Setting */}
      <div className="setting-group">
        <label>Who can see when I'm online?</label>
        <select value={onlineStatus} onChange={(e) => setOnlineStatus(e.target.value)}>
          <option value="everyone">Everyone</option>
          <option value="followers">My Followers</option>
          <option value="nobody">Nobody</option>
        </select>
        <p className="help-text">
          {onlineStatus === 'nobody' &&
            "⚠️ If you hide your online status, you won't be able to see others' online status"}
        </p>
      </div>

      {/* Last Seen Setting */}
      <div className="setting-group">
        <label>Who can see my last seen?</label>
        <select value={lastSeen} onChange={(e) => setLastSeen(e.target.value)}>
          <option value="everyone">Everyone</option>
          <option value="followers">My Followers</option>
          <option value="nobody">Nobody</option>
        </select>
        <p className="help-text">
          {lastSeen === 'nobody' &&
            "⚠️ If you hide your last seen, you won't be able to see others' last seen"}
        </p>
      </div>

      <button onClick={updatePrivacySettings}>Save Settings</button>
    </div>
  );
};
```

#### 2. Display Online Status and Last Seen

```javascript
// Fetch online status for chat participants
const fetchOnlineStatus = async (userIds) => {
  try {
    const response = await axios.get(
      `/chats/users/online-status?userIds=${userIds.join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return response.data.data.onlineStatus;
  } catch (error) {
    console.error('Failed to fetch online status:', error);
    return {};
  }
};

// Format last seen time
const formatLastSeen = (lastSeenDate) => {
  if (!lastSeenDate) return null;

  const lastSeen = new Date(lastSeenDate);
  const now = new Date();
  const diffMs = now - lastSeen;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return lastSeen.toLocaleDateString();
};

// Display in chat header
const ChatHeader = ({ userId, username }) => {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const loadStatus = async () => {
      const statuses = await fetchOnlineStatus([userId]);
      setStatus(statuses[userId]);
    };

    loadStatus();

    // Refresh every 30 seconds
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, [userId]);

  return (
    <div className="chat-header">
      <div className="user-info">
        <h3>{username}</h3>

        {/* Online indicator */}
        {status?.online ? (
          <span className="online-status">
            <span className="green-dot"></span> Online
          </span>
        ) : status?.lastSeen ? (
          <span className="last-seen">
            Last seen {formatLastSeen(status.lastSeen)}
          </span>
        ) : (
          <span className="last-seen">Last seen unavailable</span>
        )}
      </div>
    </div>
  );
};
```

#### 3. Listen for Real-Time Status Updates

```javascript
// Listen for user going offline
socket.on('user_offline', (data) => {
  console.log('User went offline:', data);
  // data: { userId, timestamp }

  // Update UI to show last seen
  updateUserStatus(data.userId, {
    online: false,
    lastSeen: data.timestamp
  });
});
```

---

## Feature 3: Message Status Indicators (Sent, Delivered, Seen)

### Backend Changes Summary
- Messages now track delivery status for each recipient
- Three states: sent (single tick), delivered (double tick), seen (blue tick)
- Real-time updates via Socket.IO

### Status Types

| Status | UI Indicator | Meaning |
|--------|-------------|---------|
| `sent` | Single grey tick ✓ | Message sent but not delivered to all recipients |
| `delivered` | Double grey tick ✓✓ | Message delivered to all recipients' devices |
| `seen` | Double blue tick ✓✓ (blue) | Message read by all recipients |

### Socket.IO Events

#### 1. Confirm Delivery (Client → Server)

When your app receives a message, emit this event:

```javascript
// When messages are received/loaded
socket.emit('confirm_delivery', {
  messageIds: ['msg1', 'msg2', 'msg3']
});
```

**When to emit:**
- When messages are fetched via API
- When new messages arrive via Socket.IO
- When app comes to foreground with undelivered messages

#### 2. Listen for Delivery Confirmations (Server → Client)

```javascript
socket.on('messages_delivered', (data) => {
  console.log('Messages delivered:', data);
  // data: {
  //   messageIds: ['msg1', 'msg2'],
  //   deliveredTo: { _id, username, fullName },
  //   deliveredAt: Date
  // }

  // Update message status in UI
  data.messageIds.forEach(messageId => {
    updateMessageStatus(messageId, 'delivered');
  });
});
```

#### 3. Listen for Read Confirmations (Server → Client)

```javascript
socket.on('messages_read', (data) => {
  console.log('Messages read:', data);
  // data: {
  //   chatId,
  //   readBy: { _id, username, fullName },
  //   messageIds: ['msg1', 'msg2']  // Optional
  // }

  // Update message status to seen
  if (data.messageIds) {
    data.messageIds.forEach(messageId => {
      updateMessageStatus(messageId, 'seen');
    });
  } else {
    // All messages in chat marked as read
    markAllChatMessagesAsSeen(data.chatId);
  }
});
```

### Frontend Implementation

#### 1. Display Message Status Ticks

```javascript
const MessageStatusIcon = ({ status }) => {
  if (!status) return null;

  switch (status) {
    case 'sent':
      return <span className="tick single-tick grey">✓</span>;

    case 'delivered':
      return <span className="tick double-tick grey">✓✓</span>;

    case 'seen':
      return <span className="tick double-tick blue">✓✓</span>;

    default:
      return null;
  }
};

// Usage in message component
const MessageBubble = ({ message, isSender }) => {
  return (
    <div className={`message ${isSender ? 'sent' : 'received'}`}>
      <p>{message.message}</p>

      {/* Show status only for sender's messages */}
      {isSender && (
        <div className="message-footer">
          <span className="timestamp">
            {formatTime(message.timestamp)}
          </span>
          <MessageStatusIcon status={message.status} />
        </div>
      )}
    </div>
  );
};
```

#### 2. CSS for Status Ticks

```css
.tick {
  font-size: 12px;
  margin-left: 4px;
}

.tick.grey {
  color: #667781;
}

.tick.blue {
  color: #53bdeb;
}

.single-tick::before {
  content: '✓';
}

.double-tick::before {
  content: '✓✓';
}
```

#### 3. Confirm Delivery on Message Receipt

```javascript
// When fetching messages via API
const fetchMessages = async (chatId) => {
  try {
    const response = await axios.get(`/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const messages = response.data.data.messages;

    // Extract message IDs that need delivery confirmation
    const undeliveredMessageIds = messages
      .filter(msg => msg.sender._id !== currentUserId) // Not sent by me
      .map(msg => msg._id);

    // Emit delivery confirmation
    if (undeliveredMessageIds.length > 0) {
      socket.emit('confirm_delivery', {
        messageIds: undeliveredMessageIds
      });
    }

    return messages;
  } catch (error) {
    console.error('Failed to fetch messages:', error);
  }
};

// When receiving new message via Socket.IO
socket.on('new_message', (data) => {
  const { chatId, message } = data;

  // Add message to UI
  addMessageToUI(chatId, message);

  // Confirm delivery if message is not from current user
  if (message.sender._id !== currentUserId) {
    socket.emit('confirm_delivery', {
      messageIds: [message._id]
    });
  }
});
```

#### 4. Update Message Status in State

```javascript
// Example with React state
const [messages, setMessages] = useState([]);

// Update message status
const updateMessageStatus = (messageId, newStatus) => {
  setMessages(prevMessages =>
    prevMessages.map(msg =>
      msg._id === messageId
        ? { ...msg, status: newStatus }
        : msg
    )
  );
};

// Listen for status updates
useEffect(() => {
  socket.on('messages_delivered', (data) => {
    data.messageIds.forEach(msgId => {
      updateMessageStatus(msgId, 'delivered');
    });
  });

  socket.on('messages_read', (data) => {
    if (data.messageIds) {
      data.messageIds.forEach(msgId => {
        updateMessageStatus(msgId, 'seen');
      });
    }
  });

  return () => {
    socket.off('messages_delivered');
    socket.off('messages_read');
  };
}, []);
```

---

## Complete Socket.IO Setup

### Initialize Socket Connection

```javascript
import io from 'socket.io-client';

const socket = io('https://your-backend-url.com', {
  auth: {
    token: localStorage.getItem('authToken')
  },
  transports: ['polling', 'websocket']
});

// Connection events
socket.on('connect', () => {
  console.log('✅ Socket connected:', socket.id);
});

socket.on('disconnect', (reason) => {
  console.log('❌ Socket disconnected:', reason);
});

socket.on('connect_error', (error) => {
  console.error('Socket connection error:', error);
});
```

### All Socket.IO Events Summary

#### Events to Listen For (Server → Client):
```javascript
// Deletion
socket.on('message_deleted_for_everyone', (data) => { /* ... */ });
socket.on('message_deleted_for_me', (data) => { /* ... */ });

// Status updates
socket.on('user_offline', (data) => { /* ... */ });
socket.on('messages_delivered', (data) => { /* ... */ });
socket.on('messages_read', (data) => { /* ... */ });

// New messages
socket.on('new_message', (data) => { /* ... */ });
```

#### Events to Emit (Client → Server):
```javascript
// Delivery confirmation
socket.emit('confirm_delivery', { messageIds: [...] });

// Mark as read
socket.emit('mark_read', { chatId, messageIds: [...] });

// Join/leave chat rooms
socket.emit('join_chat', chatId);
socket.emit('leave_chat', chatId);
```

---

## Testing Checklist

### Delete for Everyone
- [ ] Delete message within 24 hours → Shows "[Message deleted]" for all participants
- [ ] Delete message after 24 hours → Shows error "Cannot delete messages older than 24 hours"
- [ ] Delete for me → Message removed from own view only
- [ ] Receive `message_deleted_for_everyone` Socket event
- [ ] Receive `message_deleted_for_me` Socket event

### Online Status & Last Seen
- [ ] Update privacy settings to "everyone" → All users can see status
- [ ] Update privacy settings to "followers" → Only followers can see status
- [ ] Update privacy settings to "nobody" → No one can see status (and can't see others')
- [ ] Display online indicator when user is active
- [ ] Display last seen timestamp when user is offline
- [ ] Privacy reciprocity works (hide status = can't see others)

### Message Status Indicators
- [ ] Single tick (✓) shows immediately after sending
- [ ] Double tick (✓✓) shows when delivered to recipient
- [ ] Blue double tick (✓✓) shows when recipient reads message
- [ ] Emit `confirm_delivery` when receiving messages
- [ ] Listen for `messages_delivered` event
- [ ] Listen for `messages_read` event
- [ ] Status updates in real-time

### Group Chats
- [ ] Delete for everyone works in group chats
- [ ] Message status shows when ALL recipients have delivered/seen
- [ ] Online status shown for all group members

---

## API Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `DELETE` | `/chats/:chatId/messages/:messageId` | Delete message for everyone (24h limit) |
| `DELETE` | `/chats/:chatId/messages/:messageId/for-me` | Delete message for me only |
| `GET` | `/users/messaging/privacy` | Get messaging privacy settings |
| `PATCH` | `/users/messaging/privacy` | Update messaging privacy settings |
| `GET` | `/chats/users/online-status?userIds=...` | Get online status with privacy filtering |
| `GET` | `/chats/:chatId/messages` | Get messages (includes status field) |

---

## Common Issues & Solutions

### Issue 1: Messages not showing status
**Solution:** Ensure you're fetching messages with authentication and the sender is the current user (status only shown for own messages).

### Issue 2: Delivery confirmations not working
**Solution:** Make sure to emit `confirm_delivery` event when messages are received/loaded.

### Issue 3: Online status showing as false even when user is online
**Solution:** Check privacy settings - user might have hidden their status, or you might have hidden yours.

### Issue 4: Delete for everyone not working after 24 hours
**Solution:** This is expected behavior. After 24 hours, only "Delete for Me" is available.

### Issue 5: Last seen not updating
**Solution:** Last seen updates on Socket connect/disconnect. Ensure Socket connection is stable.

---

## Additional Notes

- All Socket.IO events use rooms for efficient message delivery
- Redis adapter handles cross-process Socket.IO synchronization (PM2 cluster mode)
- Privacy checks are performed on backend for security
- Message status is calculated based on ALL recipients in group chats
- Delivery status uses MongoDB arrayFilters for efficient updates

---

## Questions or Issues?

If you encounter any issues implementing these features:

1. Verify backend endpoints are accessible
2. Check Socket.IO connection is established
3. Ensure authentication token is valid
4. Check browser console for errors
5. Verify Socket.IO events are being emitted/received

Backend implementation is complete and tested. Happy coding! 🚀
