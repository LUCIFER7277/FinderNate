# Audio & Video Call System - Complete Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Implementation Details](#implementation-details)
4. [How It Works](#how-it-works)
5. [Flutter Integration Guide](#flutter-integration-guide)
6. [API Endpoints](#api-endpoints)
7. [Database Schema](#database-schema)
8. [Socket Events](#socket-events)
9. [Stream.io Integration](#streamio-integration)
10. [Configuration](#configuration)
11. [Error Handling](#error-handling)
12. [Security & Best Practices](#security--best-practices)
13. [Troubleshooting](#troubleshooting)
14. [Testing](#testing)

---

## Overview

The audio and video call system enables real-time voice and video communication between users within their existing chat conversations. The implementation uses a hybrid architecture combining REST APIs for state management and Stream.io SDK for media streaming.

### Key Features
- ✅ Voice and video calls
- ✅ Real-time call state synchronization via Socket.IO
- ✅ Push notifications for incoming calls (FCM)
- ✅ Call history and statistics
- ✅ Automatic cleanup of stale calls
- ✅ Transaction-based state management (prevents race conditions)
- ✅ Multi-instance support via Redis adapter
- ✅ Idempotent operations (safe to retry)

### Technology Stack

**Backend:**
- **Node.js/Express** - REST API server
- **MongoDB** - Call state and history storage
- **Socket.IO** - Real-time signaling and notifications
- **Stream.io SDK** - Audio/video media streaming
- **Redis** - Socket.IO adapter for multi-instance support
- **Firebase Cloud Messaging (FCM)** - Push notifications

**Client (Flutter):**
- **stream_video_flutter** - Stream.io Flutter SDK
- **socket_io_client** - Socket.IO client for signaling
- **firebase_messaging** - Push notifications
- **permission_handler** - Microphone/camera permissions

---

## Architecture

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Flutter Client                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Stream.io SDK │  │ Socket.IO    │  │ HTTP Client (Dio)    │ │
│  │ (Media)       │  │ (Signaling)  │  │ (State Management)   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                 │                     │              │
└─────────┼─────────────────┼─────────────────────┼──────────────┘
          │                 │                     │
          │ Media Stream    │ Real-time Events    │ REST API
          │ (P2P/Relay)     │ (Call State)        │ (CRUD)
          │                 │                     │
┌─────────▼─────────────────▼─────────────────────▼──────────────┐
│                    Express Server                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Call         │  │ Socket       │  │ Stream.io            │ │
│  │ Controller   │  │ Manager      │  │ Service              │ │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                 │                     │              │
└─────────┼─────────────────┼─────────────────────┼──────────────┘
          │                 │                     │
          ▼                 ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   MongoDB    │    │  Socket.IO   │    │  Stream.io   │
│  (Call State)│    │  (Redis)     │    │  (Media SDK) │
└──────────────┘    └──────────────┘    └──────────────┘
```

### Data Flow

1. **Call Initiation Flow:**
   ```
   Flutter App → HTTP POST /calls/initiate
   → Server validates & creates call record (MongoDB)
   → Server creates Stream.io call & generates tokens
   → Server emits Socket.IO 'incoming_call' event
   → Server sends FCM push notification
   → Server returns call data + Stream.io credentials
   ```

2. **Call Acceptance Flow:**
   ```
   Flutter App → HTTP PATCH /calls/:callId/accept
   → Server updates call status (MongoDB transaction)
   → Server emits Socket.IO 'call_accepted' event
   → Both clients connect to Stream.io using tokens
   → Stream.io handles media streaming (P2P/relay)
   ```

3. **Media Streaming:**
   ```
   Flutter App (Caller) ↔ Stream.io SDK ↔ Flutter App (Receiver)
   (Direct P2P connection or relayed through Stream.io servers)
   ```

4. **Call Termination Flow:**
   ```
   Flutter App → HTTP PATCH /calls/:callId/end
   → Server updates call status & calculates duration
   → Server emits Socket.IO 'call_ended' event
   → Server ends Stream.io call
   ```

---

## Implementation Details

### 1. Call Controller (`src/controllers/call.controllers.js`)

The main controller handles all call-related operations with comprehensive error handling and transaction safety.

#### Key Functions:

**`initiateCall(req, res)`**
- Validates input (receiverId, chatId, callType)
- Checks chat permissions
- Prevents duplicate active calls (transaction-based)
- Creates call record in MongoDB
- Creates Stream.io call with appropriate settings
- Generates tokens for both participants
- Emits Socket.IO event to receiver
- Sends FCM push notification (async, non-blocking)
- Returns call data with Stream.io credentials

**`acceptCall(req, res)`**
- Validates call exists and user is participant
- Updates status to 'connecting' (transaction-based)
- Sets `startedAt` timestamp
- Emits Socket.IO 'call_accepted' event
- Returns updated call data

**`declineCall(req, res)`**
- Validates call exists and user is participant
- Updates status to 'declined' (transaction-based)
- Sets `endedAt` timestamp
- Emits Socket.IO 'call_declined' event

**`endCall(req, res)`**
- Validates call exists and user is participant
- Updates status to 'ended' (transaction-based)
- Calculates call duration
- Sets `endedAt` timestamp and `endedBy` field
- Emits Socket.IO 'call_ended' event
- Returns call data with duration

**`updateCallStatus(req, res)`**
- Updates connection state ('connecting' → 'active')
- Only allows non-terminal status updates
- Updates metadata (quality, connection type)

**`getCallHistory(req, res)`**
- Retrieves paginated call history for user
- Filters by terminal states (ended, declined, missed)

**`getActiveCall(req, res)`**
- Returns user's current active call (if any)

**`getCallStats(req, res)`**
- Aggregates call statistics (total, answered, duration, etc.)

**`forceEndActiveCalls(req, res)`**
- Cleanup endpoint for stuck calls
- Ends all active calls for user

#### Transaction Safety

All critical operations use MongoDB transactions to prevent race conditions:

```javascript
const session = await mongoose.startSession();
await session.withTransaction(async () => {
    const call = await Call.findById(callId).session(session);
    // ... update call ...
    await call.save({ session });
});
```

#### Automatic Cleanup

Stale calls are automatically cleaned up every 5 minutes:

```javascript
setInterval(cleanupStaleCalls, CLEANUP_INTERVAL_MINUTES * 60 * 1000);
```

Calls stuck in 'initiated' or 'ringing' state for > 2 minutes are marked as 'missed'.

### 2. Call Model (`src/models/call.models.js`)

MongoDB schema for call records with indexes for performance.

#### Schema Fields:

- `participants` - Array of User IDs
- `initiator` - User who started the call
- `chatId` - Associated chat conversation
- `callType` - 'voice' or 'video'
- `status` - Call state (initiated, ringing, connecting, active, ended, declined, missed, failed)
- `initiatedAt`, `startedAt`, `endedAt` - Timestamps
- `duration` - Call duration in seconds (auto-calculated)
- `endReason` - Reason for termination
- `endedBy` - User who ended the call
- `metadata` - Device/quality information

#### Virtual Properties:

- `formattedDuration` - Human-readable duration (e.g., "5:23")
- `wasAnswered` - Boolean indicating if call was answered
- `isOngoing` - Boolean indicating if call is active

#### Static Methods:

- `getCallHistory(userId, limit, page)` - Paginated call history
- `getActiveCall(userId)` - Get user's active call
- `getCallStats(userId, days)` - Aggregate call statistics

#### Indexes:

- `initiator: 1, initiatedAt: -1` - Fast lookup by initiator
- `participants: 1, initiatedAt: -1` - Fast lookup by participant
- `chatId: 1, initiatedAt: -1` - Fast lookup by chat
- `status: 1, initiatedAt: -1` - Fast lookup by status

### 3. Stream.io Service (`src/config/stream.config.js`)

Service for managing Stream.io calls and tokens.

#### Key Methods:

**`initialize()`**
- Initializes Stream.io client with API key and secret
- Validates environment variables

**`generateUserToken(userId, expirationSeconds)`**
- Generates authentication token for Stream.io
- Default expiration: 24 hours

**`upsertUsers(users)`**
- Registers/updates users in Stream.io
- Required before creating calls

**`createCall(callType, callId, createdBy, members, videoEnabled)`**
- Creates Stream.io call with appropriate settings
- **Voice calls**: Audio enabled, video disabled
- **Video calls**: Audio and video enabled
- Configures ring timeouts, screen sharing, etc.

**`endCall(callType, callId)`**
- Ends Stream.io call

#### Call Settings:

**Voice Call:**
```javascript
{
    audio: { mic_default_on: true, speaker_default_on: true },
    video: { enabled: false, camera_default_on: false },
    ring: { auto_cancel_timeout_ms: 30000, incoming_call_timeout_ms: 30000 }
}
```

**Video Call:**
```javascript
{
    audio: { mic_default_on: true, speaker_default_on: true },
    video: { enabled: true, camera_default_on: true, camera_facing: 'front' },
    screensharing: { enabled: true },
    ring: { auto_cancel_timeout_ms: 30000, incoming_call_timeout_ms: 30000 }
}
```

### 4. Socket Manager (`src/config/socket.js`)

Handles real-time signaling via Socket.IO with Redis adapter for multi-instance support.

#### Key Features:

- **Authentication**: JWT-based authentication middleware
- **User Rooms**: Each user joins `user_{userId}` room
- **Chat Rooms**: Users auto-join their active chat rooms
- **Redis Adapter**: Enables cross-instance communication
- **Online Tracking**: Tracks online users in Redis

#### Call-Related Events:

- `incoming_call` - Emitted to receiver when call is initiated
- `call_accepted` - Emitted when call is accepted
- `call_declined` - Emitted when call is declined
- `call_ended` - Emitted when call ends
- `call_status_update` - Emitted on status changes
- `call_timeout` - Emitted when call times out

---

## How It Works

### Complete Call Flow

#### 1. Initiating a Call

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Caller  │                    │  Server  │                    │ Receiver │
│ (Flutter)│                    │          │                    │(Flutter) │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                                │                                │
     │ 1. POST /calls/initiate        │                                │
     │ {receiverId, chatId, callType} │                                │
     ├───────────────────────────────>│                                │
     │                                │                                │
     │                                │ 2. Validate chat permissions   │
     │                                │ 3. Check for active calls      │
     │                                │ 4. Create call record (DB)     │
     │                                │ 5. Create Stream.io call        │
     │                                │ 6. Generate tokens              │
     │                                │                                │
     │                                │ 7. Socket: incoming_call        │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │                                │ 8. FCM Push Notification       │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │ 9. 201 Created                 │                                │
     │ {call, stream: {token, ...}}   │                                │
     │<───────────────────────────────┤                                │
     │                                │                                │
     │ 10. Initialize Stream.io SDK    │                                │
     │     with token                 │                                │
     │                                │                                │
```

**Step-by-Step:**

1. **Client Request**: Flutter app sends POST request with `receiverId`, `chatId`, and `callType` ('voice' or 'video')

2. **Server Validation**:
   - Validates input fields
   - Checks chat exists and user has permission
   - Verifies receiver exists
   - Checks no active calls for either participant (transaction-based)

3. **Call Creation**:
   - Creates call record in MongoDB (status: 'initiated')
   - Creates Stream.io call with appropriate settings
   - Registers users in Stream.io (if not already registered)
   - Generates tokens for both participants (24-hour expiration)

4. **Notifications**:
   - Emits Socket.IO 'incoming_call' event to receiver
   - Sends FCM push notification (async, non-blocking)

5. **Response**:
   - Returns call data with Stream.io credentials:
     - `apiKey` - Stream.io API key
     - `callId` - Call identifier
     - `streamCallType` - 'default'
     - `callerToken` - Token for caller
     - `receiverToken` - Token for receiver
     - `expiresAt` - Token expiration time

6. **Client Initialization**:
   - Caller initializes Stream.io SDK with `callerToken`
   - Waits for receiver to accept

#### 2. Accepting a Call

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│ Receiver │                    │  Server  │                    │  Caller  │
│ (Flutter)│                    │          │                    │(Flutter) │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                                │                                │
     │ 1. PATCH /calls/:callId/accept │                                │
     ├───────────────────────────────>│                                │
     │                                │                                │
     │                                │ 2. Validate call exists        │
     │                                │ 3. Check user is participant   │
     │                                │ 4. Update status: 'connecting' │
     │                                │ 5. Set startedAt timestamp     │
     │                                │                                │
     │                                │ 6. Socket: call_accepted       │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │ 7. 200 OK                     │                                │
     │ {call}                         │                                │
     │<───────────────────────────────┤                                │
     │                                │                                │
     │ 8. Initialize Stream.io SDK    │                                │
     │     with receiverToken         │                                │
     │                                │                                │
     │ 9. Connect to Stream.io       │                                │
     │    (Media streaming starts)    │                                │
     │<───────────────────────────────┼───────────────────────────────>│
     │                                │                                │
     │ 10. Update status: 'active'    │                                │
     │     (via PATCH /status)        │                                │
     │                                │                                │
```

**Step-by-Step:**

1. **Client Request**: Receiver sends PATCH request to accept call

2. **Server Validation**:
   - Validates call ID format
   - Checks call exists
   - Verifies user is participant
   - Validates call status (must be 'initiated', 'ringing', or 'connecting')

3. **Status Update**:
   - Updates status to 'connecting' (transaction-based)
   - Sets `startedAt` timestamp

4. **Notification**:
   - Emits Socket.IO 'call_accepted' event to caller

5. **Response**:
   - Returns updated call data

6. **Client Connection**:
   - Receiver initializes Stream.io SDK with `receiverToken` (from initiation response)
   - Both clients connect to Stream.io
   - Stream.io handles media streaming (P2P or relay)

7. **Status Update**:
   - Clients update status to 'active' via PATCH `/calls/:callId/status`

#### 3. Declining a Call

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│ Receiver │                    │  Server  │                    │  Caller  │
│ (Flutter)│                    │          │                    │(Flutter) │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                                │                                │
     │ 1. PATCH /calls/:callId/decline│                                │
     ├───────────────────────────────>│                                │
     │                                │                                │
     │                                │ 2. Validate call exists        │
     │                                │ 3. Update status: 'declined'   │
     │                                │ 4. Set endedAt, endReason      │
     │                                │                                │
     │                                │ 5. Socket: call_declined       │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │ 6. 200 OK                     │                                │
     │ {call}                         │                                │
     │<───────────────────────────────┤                                │
```

#### 4. Ending a Call

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  User    │                    │  Server  │                    │  Other   │
│ (Flutter)│                    │          │                    │(Flutter) │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                                │                                │
     │ 1. PATCH /calls/:callId/end   │                                │
     │ {endReason: 'normal'}          │                                │
     ├───────────────────────────────>│                                │
     │                                │                                │
     │                                │ 2. Validate call exists        │
     │                                │ 3. Update status: 'ended'      │
     │                                │ 4. Calculate duration          │
     │                                │ 5. Set endedAt, endReason      │
     │                                │                                │
     │                                │ 6. Socket: call_ended         │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │ 7. 200 OK                     │                                │
     │ {call, duration}               │                                │
     │<───────────────────────────────┤                                │
     │                                │                                │
     │ 8. Disconnect from Stream.io   │                                │
     │                                │                                │
```

**Step-by-Step:**

1. **Client Request**: User sends PATCH request to end call (with optional `endReason`)

2. **Server Validation**:
   - Validates call ID format
   - Checks call exists
   - Verifies user is participant
   - Validates `endReason` (if provided)

3. **Status Update**:
   - Updates status to 'ended' (transaction-based, idempotent)
   - Sets `endedAt` timestamp
   - Sets `endedBy` field
   - Calculates duration (if call was started)

4. **Notification**:
   - Emits Socket.IO 'call_ended' event to other participants

5. **Response**:
   - Returns call data with duration

6. **Client Cleanup**:
   - Clients disconnect from Stream.io
   - Clean up UI

### State Transitions

```
initiated → connecting → active → ended
    ↓           ↓
  ringing    declined
    ↓
  missed (timeout)
```

**Valid Transitions:**
- `initiated` → `connecting` (accept)
- `initiated` → `declined` (decline)
- `initiated` → `missed` (timeout)
- `ringing` → `connecting` (accept)
- `ringing` → `declined` (decline)
- `connecting` → `active` (status update)
- `active` → `ended` (end)
- Any active state → `ended` (end, idempotent)

---

## Flutter Integration Guide

### Prerequisites

Add these dependencies to your `pubspec.yaml`:

```yaml
dependencies:
  flutter:
    sdk: flutter
  
  # Stream.io SDK for audio/video calls
  stream_video_flutter: ^0.4.0
  
  # Socket.IO for real-time signaling
  socket_io_client: ^2.0.3
  
  # HTTP client
  dio: ^5.4.0
  
  # Push notifications
  firebase_messaging: ^14.7.0
  
  # Permissions
  permission_handler: ^11.1.0
  
  # State management (example)
  provider: ^6.1.1
```

### 1. Setup Stream.io SDK

Create a Stream.io service:

```dart
// lib/services/stream_service.dart
import 'package:stream_video_flutter/stream_video_flutter.dart';

class StreamService {
  static StreamService? _instance;
  StreamVideo? _streamVideo;
  Call? _currentCall;
  
  StreamService._();
  
  factory StreamService() {
    _instance ??= StreamService._();
    return _instance!;
  }
  
  // Initialize Stream.io client
  Future<void> initialize(String userId, String token, String apiKey) async {
    final user = User(
      id: userId,
      name: 'User Name', // Get from your user model
    );
    
    _streamVideo = StreamVideo(
      apiKey: apiKey,
      user: user,
      token: token,
    );
  }
  
  // Get Stream.io client
  StreamVideo? get client => _streamVideo;
  
  // Get current call
  Call? get currentCall => _currentCall;
  
  // Set current call
  void setCurrentCall(Call? call) {
    _currentCall = call;
  }
  
  // Cleanup
  Future<void> dispose() async {
    await _currentCall?.leave();
    _currentCall = null;
    _streamVideo = null;
  }
}
```

### 2. Setup Socket.IO Client

Create a Socket.IO service:

```dart
// lib/services/socket_service.dart
import 'package:socket_io_client/socket_io_client.dart' as IO;

class SocketService {
  static SocketService? _instance;
  IO.Socket? _socket;
  
  SocketService._();
  
  factory SocketService() {
    _instance ??= SocketService._();
    return _instance!;
  }
  
  // Initialize Socket.IO connection
  Future<void> initialize(String token, String serverUrl) async {
    _socket = IO.io(
      serverUrl,
      IO.OptionBuilder()
          .setTransports(['websocket', 'polling'])
          .setAuth({'token': token})
          .setExtraHeaders({'Authorization': 'Bearer $token'})
          .enableAutoConnect()
          .build(),
    );
    
    _socket!.onConnect((_) {
      print('Socket.IO connected');
    });
    
    _socket!.onDisconnect((_) {
      print('Socket.IO disconnected');
    });
    
    _socket!.onError((error) {
      print('Socket.IO error: $error');
    });
  }
  
  // Listen to incoming call event
  void onIncomingCall(Function(Map<String, dynamic>) callback) {
    _socket?.on('incoming_call', (data) {
      callback(Map<String, dynamic>.from(data));
    });
  }
  
  // Listen to call accepted event
  void onCallAccepted(Function(Map<String, dynamic>) callback) {
    _socket?.on('call_accepted', (data) {
      callback(Map<String, dynamic>.from(data));
    });
  }
  
  // Listen to call declined event
  void onCallDeclined(Function(Map<String, dynamic>) callback) {
    _socket?.on('call_declined', (data) {
      callback(Map<String, dynamic>.from(data));
    });
  }
  
  // Listen to call ended event
  void onCallEnded(Function(Map<String, dynamic>) callback) {
    _socket?.on('call_ended', (data) {
      callback(Map<String, dynamic>.from(data));
    });
  }
  
  // Listen to call status update
  void onCallStatusUpdate(Function(Map<String, dynamic>) callback) {
    _socket?.on('call_status_update', (data) {
      callback(Map<String, dynamic>.from(data));
    });
  }
  
  // Disconnect
  void disconnect() {
    _socket?.disconnect();
    _socket = null;
  }
}
```

### 3. Setup API Service

Create an API service for HTTP requests:

```dart
// lib/services/api_service.dart
import 'package:dio/dio.dart';

class ApiService {
  final Dio _dio;
  final String baseUrl;
  final String? token;
  
  ApiService({
    required this.baseUrl,
    this.token,
  }) : _dio = Dio(BaseOptions(
          baseUrl: baseUrl,
          headers: {
            if (token != null) 'Authorization': 'Bearer $token',
            'Content-Type': 'application/json',
          },
        ));
  
  // Initiate call
  Future<Map<String, dynamic>> initiateCall({
    required String receiverId,
    required String chatId,
    required String callType, // 'voice' or 'video'
  }) async {
    final response = await _dio.post(
      '/api/v1/calls/initiate',
      data: {
        'receiverId': receiverId,
        'chatId': chatId,
        'callType': callType,
      },
    );
    return response.data['data'];
  }
  
  // Accept call
  Future<Map<String, dynamic>> acceptCall(String callId) async {
    final response = await _dio.patch('/api/v1/calls/$callId/accept');
    return response.data['data'];
  }
  
  // Decline call
  Future<Map<String, dynamic>> declineCall(String callId) async {
    final response = await _dio.patch('/api/v1/calls/$callId/decline');
    return response.data['data'];
  }
  
  // End call
  Future<Map<String, dynamic>> endCall(
    String callId, {
    String? endReason,
  }) async {
    final response = await _dio.patch(
      '/api/v1/calls/$callId/end',
      data: endReason != null ? {'endReason': endReason} : null,
    );
    return response.data['data'];
  }
  
  // Update call status
  Future<Map<String, dynamic>> updateCallStatus(
    String callId,
    String status, {
    Map<String, dynamic>? metadata,
  }) async {
    final response = await _dio.patch(
      '/api/v1/calls/$callId/status',
      data: {
        'status': status,
        if (metadata != null) 'metadata': metadata,
      },
    );
    return response.data['data'];
  }
  
  // Get active call
  Future<Map<String, dynamic>?> getActiveCall() async {
    final response = await _dio.get('/api/v1/calls/active');
    return response.data['data'];
  }
  
  // Get call history
  Future<Map<String, dynamic>> getCallHistory({
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      '/api/v1/calls/history',
      queryParameters: {'page': page, 'limit': limit},
    );
    return response.data['data'];
  }
}
```

### 4. Create Call Manager

Create a call manager to handle call logic:

```dart
// lib/services/call_manager.dart
import 'package:stream_video_flutter/stream_video_flutter.dart';
import 'stream_service.dart';
import 'socket_service.dart';
import 'api_service.dart';
import 'package:permission_handler/permission_handler.dart';

class CallManager {
  final StreamService _streamService = StreamService();
  final SocketService _socketService = SocketService();
  final ApiService _apiService;
  
  CallManager(this._apiService);
  
  // Initialize services
  Future<void> initialize({
    required String userId,
    required String streamToken,
    required String streamApiKey,
    required String socketToken,
    required String socketServerUrl,
  }) async {
    // Initialize Stream.io
    await _streamService.initialize(userId, streamToken, streamApiKey);
    
    // Initialize Socket.IO
    await _socketService.initialize(socketToken, socketServerUrl);
    
    // Setup socket listeners
    _setupSocketListeners();
  }
  
  // Setup socket event listeners
  void _setupSocketListeners() {
    _socketService.onIncomingCall((data) {
      // Handle incoming call
      _handleIncomingCall(data);
    });
    
    _socketService.onCallAccepted((data) {
      // Handle call accepted
      _handleCallAccepted(data);
    });
    
    _socketService.onCallDeclined((data) {
      // Handle call declined
      _handleCallDeclined(data);
    });
    
    _socketService.onCallEnded((data) {
      // Handle call ended
      _handleCallEnded(data);
    });
  }
  
  // Initiate a call
  Future<void> initiateCall({
    required String receiverId,
    required String chatId,
    required String callType, // 'voice' or 'video'
  }) async {
    try {
      // Request permissions
      if (callType == 'video') {
        await _requestVideoPermissions();
      } else {
        await _requestAudioPermissions();
      }
      
      // Call API to initiate
      final response = await _apiService.initiateCall(
        receiverId: receiverId,
        chatId: chatId,
        callType: callType,
      );
      
      // Initialize Stream.io call
      final streamData = response['stream'] as Map<String, dynamic>;
      final callId = streamData['callId'] as String;
      final token = streamData['callerToken'] as String;
      final apiKey = streamData['apiKey'] as String;
      
      // Re-initialize Stream.io with caller token
      await _streamService.initialize(
        _streamService.client!.currentUser!.id,
        token,
        apiKey,
      );
      
      // Create and join call
      final call = _streamService.client!.call(
        type: streamData['streamCallType'] as String,
        id: callId,
      );
      
      await call.join();
      _streamService.setCurrentCall(call);
      
      // Update status to active when connected
      call.state.connectionStatus.listen((status) {
        if (status == ConnectionStatus.connected) {
          _apiService.updateCallStatus(callId, 'active');
        }
      });
      
    } catch (e) {
      print('Error initiating call: $e');
      rethrow;
    }
  }
  
  // Accept incoming call
  Future<void> acceptCall(String callId) async {
    try {
      // Call API to accept
      final response = await _apiService.acceptCall(callId);
      
      // Get Stream.io credentials from stored call data
      // (You should store incoming call data when received)
      final streamData = _getStoredCallData(callId)?['stream'];
      if (streamData == null) {
        throw Exception('Stream data not found');
      }
      
      final token = streamData['token'] as String;
      final apiKey = streamData['apiKey'] as String;
      
      // Re-initialize Stream.io with receiver token
      await _streamService.initialize(
        _streamService.client!.currentUser!.id,
        token,
        apiKey,
      );
      
      // Create and join call
      final call = _streamService.client!.call(
        type: streamData['streamCallType'] as String,
        id: callId,
      );
      
      await call.join();
      _streamService.setCurrentCall(call);
      
      // Update status to active when connected
      call.state.connectionStatus.listen((status) {
        if (status == ConnectionStatus.connected) {
          _apiService.updateCallStatus(callId, 'active');
        }
      });
      
    } catch (e) {
      print('Error accepting call: $e');
      rethrow;
    }
  }
  
  // Decline call
  Future<void> declineCall(String callId) async {
    try {
      await _apiService.declineCall(callId);
    } catch (e) {
      print('Error declining call: $e');
      rethrow;
    }
  }
  
  // End call
  Future<void> endCall(String callId, {String? endReason}) async {
    try {
      // Leave Stream.io call
      await _streamService.currentCall?.leave();
      _streamService.setCurrentCall(null);
      
      // Call API to end
      await _apiService.endCall(callId, endReason: endReason);
    } catch (e) {
      print('Error ending call: $e');
      rethrow;
    }
  }
  
  // Handle incoming call
  void _handleIncomingCall(Map<String, dynamic> data) {
    // Store call data
    _storeCallData(data['callId'] as String, data);
    
    // Show incoming call UI
    // You can use a callback or state management here
    _onIncomingCall?.call(data);
  }
  
  // Handle call accepted
  void _handleCallAccepted(Map<String, dynamic> data) {
    _onCallAccepted?.call(data);
  }
  
  // Handle call declined
  void _handleCallDeclined(Map<String, dynamic> data) {
    _onCallDeclined?.call(data);
  }
  
  // Handle call ended
  void _handleCallEnded(Map<String, dynamic> data) {
    // Leave Stream.io call
    _streamService.currentCall?.leave();
    _streamService.setCurrentCall(null);
    
    _onCallEnded?.call(data);
  }
  
  // Request audio permissions
  Future<void> _requestAudioPermissions() async {
    final micStatus = await Permission.microphone.request();
    if (!micStatus.isGranted) {
      throw Exception('Microphone permission denied');
    }
  }
  
  // Request video permissions
  Future<void> _requestVideoPermissions() async {
    final micStatus = await Permission.microphone.request();
    final cameraStatus = await Permission.camera.request();
    
    if (!micStatus.isGranted || !cameraStatus.isGranted) {
      throw Exception('Microphone or camera permission denied');
    }
  }
  
  // Callbacks (set these from your UI)
  Function(Map<String, dynamic>)? _onIncomingCall;
  Function(Map<String, dynamic>)? _onCallAccepted;
  Function(Map<String, dynamic>)? _onCallDeclined;
  Function(Map<String, dynamic>)? _onCallEnded;
  
  void setOnIncomingCall(Function(Map<String, dynamic>) callback) {
    _onIncomingCall = callback;
  }
  
  void setOnCallAccepted(Function(Map<String, dynamic>) callback) {
    _onCallAccepted = callback;
  }
  
  void setOnCallDeclined(Function(Map<String, dynamic>) callback) {
    _onCallDeclined = callback;
  }
  
  void setOnCallEnded(Function(Map<String, dynamic>) callback) {
    _onCallEnded = callback;
  }
  
  // Helper methods for storing call data
  final Map<String, Map<String, dynamic>> _storedCallData = {};
  
  void _storeCallData(String callId, Map<String, dynamic> data) {
    _storedCallData[callId] = data;
  }
  
  Map<String, dynamic>? _getStoredCallData(String callId) {
    return _storedCallData[callId];
  }
  
  // Cleanup
  Future<void> dispose() async {
    await _streamService.dispose();
    _socketService.disconnect();
  }
}
```

### 5. Create Call UI

Create a call screen widget:

```dart
// lib/screens/call_screen.dart
import 'package:flutter/material.dart';
import 'package:stream_video_flutter/stream_video_flutter.dart';
import '../services/call_manager.dart';
import '../services/stream_service.dart';

class CallScreen extends StatefulWidget {
  final String callId;
  final String callType; // 'voice' or 'video'
  final bool isIncoming;
  final Map<String, dynamic>? callerInfo;
  
  const CallScreen({
    Key? key,
    required this.callId,
    required this.callType,
    this.isIncoming = false,
    this.callerInfo,
  }) : super(key: key);
  
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final CallManager _callManager = CallManager(/* your ApiService */);
  Call? _call;
  bool _isMuted = false;
  bool _isVideoEnabled = false;
  
  @override
  void initState() {
    super.initState();
    _initializeCall();
  }
  
  Future<void> _initializeCall() async {
    final streamService = StreamService();
    _call = streamService.currentCall;
    
    if (_call != null) {
      setState(() {});
    }
  }
  
  @override
  Widget build(BuildContext context) {
    if (_call == null) {
      return Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    
    return Scaffold(
      body: widget.callType == 'video'
          ? _buildVideoCallUI()
          : _buildVoiceCallUI(),
    );
  }
  
  Widget _buildVideoCallUI() {
    return StreamVideo(
      call: _call!,
      callContent: StreamCallContent(
        call: _call!,
        callControls: StreamCallControls(
          onHangupTap: () => _endCall(),
          onToggleMicTap: () => _toggleMic(),
          onToggleCameraTap: () => _toggleCamera(),
        ),
      ),
    );
  }
  
  Widget _buildVoiceCallUI() {
    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.blue.shade900, Colors.blue.shade700],
        ),
      ),
      child: SafeArea(
        child: Column(
          children: [
            // Caller info
            Expanded(
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    CircleAvatar(
                      radius: 60,
                      backgroundImage: widget.callerInfo?['profileImageUrl'] != null
                          ? NetworkImage(widget.callerInfo!['profileImageUrl'])
                          : null,
                      child: widget.callerInfo?['profileImageUrl'] == null
                          ? Icon(Icons.person, size: 60)
                          : null,
                    ),
                    SizedBox(height: 20),
                    Text(
                      widget.callerInfo?['fullName'] ?? 'Unknown',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 24,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    SizedBox(height: 10),
                    Text(
                      widget.callType == 'voice' ? 'Voice Call' : 'Video Call',
                      style: TextStyle(color: Colors.white70),
                    ),
                  ],
                ),
              ),
            ),
            // Controls
            Padding(
              padding: EdgeInsets.all(20),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  // Mute button
                  _buildControlButton(
                    icon: _isMuted ? Icons.mic_off : Icons.mic,
                    onPressed: _toggleMic,
                    backgroundColor: _isMuted ? Colors.red : Colors.white24,
                  ),
                  // Hang up button
                  _buildControlButton(
                    icon: Icons.call_end,
                    onPressed: _endCall,
                    backgroundColor: Colors.red,
                    size: 60,
                  ),
                  // Speaker button
                  _buildControlButton(
                    icon: Icons.volume_up,
                    onPressed: () {},
                    backgroundColor: Colors.white24,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
  
  Widget _buildControlButton({
    required IconData icon,
    required VoidCallback onPressed,
    Color? backgroundColor,
    double size = 50,
  }) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: backgroundColor ?? Colors.white24,
        shape: BoxShape.circle,
      ),
      child: IconButton(
        icon: Icon(icon, color: Colors.white),
        onPressed: onPressed,
      ),
    );
  }
  
  void _toggleMic() {
    setState(() {
      _isMuted = !_isMuted;
    });
    _call?.microphone.toggle();
  }
  
  void _toggleCamera() {
    setState(() {
      _isVideoEnabled = !_isVideoEnabled;
    });
    _call?.camera.toggle();
  }
  
  Future<void> _endCall() async {
    await _callManager.endCall(widget.callId);
    Navigator.of(context).pop();
  }
  
  @override
  void dispose() {
    super.dispose();
  }
}
```

### 6. Handle Incoming Calls

Handle incoming calls from Socket.IO and FCM:

```dart
// lib/screens/incoming_call_screen.dart
import 'package:flutter/material.dart';
import '../services/call_manager.dart';

class IncomingCallScreen extends StatelessWidget {
  final Map<String, dynamic> callData;
  final CallManager callManager;
  
  const IncomingCallScreen({
    Key? key,
    required this.callData,
    required this.callManager,
  }) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    final caller = callData['caller'] as Map<String, dynamic>;
    final callType = callData['callType'] as String;
    final callId = callData['callId'] as String;
    
    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Colors.blue.shade900, Colors.blue.shade700],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              // Caller info
              Expanded(
                child: Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      CircleAvatar(
                        radius: 60,
                        backgroundImage: caller['profileImageUrl'] != null
                            ? NetworkImage(caller['profileImageUrl'])
                            : null,
                        child: caller['profileImageUrl'] == null
                            ? Icon(Icons.person, size: 60, color: Colors.white)
                            : null,
                      ),
                      SizedBox(height: 20),
                      Text(
                        caller['fullName'] ?? 'Unknown',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      SizedBox(height: 10),
                      Text(
                        'Incoming ${callType} call',
                        style: TextStyle(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              ),
              // Action buttons
              Padding(
                padding: EdgeInsets.all(20),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    // Decline button
                    Container(
                      width: 60,
                      height: 60,
                      decoration: BoxDecoration(
                        color: Colors.red,
                        shape: BoxShape.circle,
                      ),
                      child: IconButton(
                        icon: Icon(Icons.call_end, color: Colors.white),
                        onPressed: () async {
                          await callManager.declineCall(callId);
                          Navigator.of(context).pop();
                        },
                      ),
                    ),
                    // Accept button
                    Container(
                      width: 60,
                      height: 60,
                      decoration: BoxDecoration(
                        color: Colors.green,
                        shape: BoxShape.circle,
                      ),
                      child: IconButton(
                        icon: Icon(Icons.call, color: Colors.white),
                        onPressed: () async {
                          await callManager.acceptCall(callId);
                          Navigator.of(context).pop();
                          // Navigate to call screen
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => CallScreen(
                                callId: callId,
                                callType: callType,
                                callerInfo: caller,
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

### 7. Initialize in App

Initialize services in your app:

```dart
// lib/main.dart (example)
import 'package:flutter/material.dart';
import 'services/call_manager.dart';
import 'services/api_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // Initialize call manager
  final apiService = ApiService(
    baseUrl: 'https://your-api-url.com',
    token: 'your-jwt-token',
  );
  
  final callManager = CallManager(apiService);
  
  await callManager.initialize(
    userId: 'user-id',
    streamToken: 'stream-token', // Get from your backend
    streamApiKey: 'stream-api-key',
    socketToken: 'jwt-token',
    socketServerUrl: 'https://your-api-url.com',
  );
  
  // Setup call event handlers
  callManager.setOnIncomingCall((data) {
    // Show incoming call screen
    // You can use a navigator or overlay here
  });
  
  runApp(MyApp(callManager: callManager));
}
```

### 8. Handle FCM Push Notifications

Setup FCM for incoming call notifications:

```dart
// lib/services/fcm_service.dart
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class FCMService {
  final FirebaseMessaging _fcm = FirebaseMessaging.instance;
  final FlutterLocalNotificationsPlugin _notifications = 
      FlutterLocalNotificationsPlugin();
  
  Future<void> initialize() async {
    // Request permissions
    NotificationSettings settings = await _fcm.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    
    // Initialize local notifications
    await _notifications.initialize(
      InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(),
      ),
    );
    
    // Handle foreground messages
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);
    
    // Handle background messages
    FirebaseMessaging.onMessageOpenedApp.listen(_handleBackgroundMessage);
  }
  
  void _handleForegroundMessage(RemoteMessage message) {
    if (message.data['type'] == 'incoming_call') {
      // Show local notification or navigate to incoming call screen
      _showIncomingCallNotification(message);
    }
  }
  
  void _handleBackgroundMessage(RemoteMessage message) {
    if (message.data['type'] == 'incoming_call') {
      // Navigate to incoming call screen
      // You'll need to use a navigator key here
    }
  }
  
  Future<void> _showIncomingCallNotification(RemoteMessage message) async {
    final data = message.data;
    await _notifications.show(
      data['callId'].hashCode,
      message.notification?.title ?? 'Incoming Call',
      message.notification?.body ?? '',
      NotificationDetails(
        android: AndroidNotificationDetails(
          'calls',
          'Incoming Calls',
          channelDescription: 'Notifications for incoming calls',
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(),
      ),
      payload: data['callId'],
    );
  }
  
  // Get FCM token
  Future<String?> getToken() async {
    return await _fcm.getToken();
  }
}
```

---

## API Endpoints

### Base URL: `/api/v1/calls`

All endpoints require authentication via JWT token in the `Authorization` header.

### 1. Initiate Call

**POST** `/initiate`

**Request Body:**
```json
{
  "receiverId": "507f1f77bcf86cd799439011",
  "chatId": "507f1f77bcf86cd799439012",
  "callType": "voice"
}
```

**Response (201):**
```json
{
  "statusCode": 201,
  "data": {
    "_id": "507f1f77bcf86cd799439013",
    "participants": [...],
    "initiator": {...},
    "chatId": "507f1f77bcf86cd799439012",
    "callType": "voice",
    "status": "initiated",
    "initiatedAt": "2024-01-15T10:30:00.000Z",
    "stream": {
      "apiKey": "your_stream_api_key",
      "callId": "507f1f77bcf86cd799439013",
      "streamCallType": "default",
      "callerToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "receiverToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "expiresAt": "2024-01-16T10:30:00.000Z"
    }
  },
  "message": "Call initiated successfully"
}
```

**Error Responses:**
- `400` - Missing required fields or invalid call type
- `403` - User not in chat or cannot call themselves
- `404` - Receiver or chat not found
- `409` - User already in a call

### 2. Accept Call

**PATCH** `/:callId/accept`

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "_id": "507f1f77bcf86cd799439013",
    "status": "connecting",
    "startedAt": "2024-01-15T10:30:15.000Z",
    ...
  },
  "message": "Call accepted successfully"
}
```

### 3. Decline Call

**PATCH** `/:callId/decline`

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "_id": "507f1f77bcf86cd799439013",
    "status": "declined",
    "endedAt": "2024-01-15T10:30:20.000Z",
    "endReason": "declined",
    ...
  },
  "message": "Call declined successfully"
}
```

### 4. End Call

**PATCH** `/:callId/end`

**Request Body (optional):**
```json
{
  "endReason": "normal"
}
```

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "_id": "507f1f77bcf86cd799439013",
    "status": "ended",
    "endedAt": "2024-01-15T10:35:00.000Z",
    "duration": 285,
    "formattedDuration": "4:45",
    "endReason": "normal",
    "endedBy": "507f1f77bcf86cd799439010",
    ...
  },
  "message": "Call ended successfully"
}
```

### 5. Update Call Status

**PATCH** `/:callId/status`

**Request Body:**
```json
{
  "status": "active",
  "metadata": {
    "quality": "good",
    "connectionType": "wifi"
  }
}
```

**Note:** Only allows 'connecting' or 'active' status. Terminal states must use dedicated endpoints.

### 6. Get Call History

**GET** `/history?page=1&limit=20`

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "calls": [...],
    "pagination": {
      "currentPage": 1,
      "totalPages": 5,
      "totalCalls": 100,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  },
  "message": "Call history fetched successfully"
}
```

### 7. Get Active Call

**GET** `/active`

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "_id": "507f1f77bcf86cd799439013",
    "status": "active",
    ...
  },
  "message": "Active call fetched successfully"
}
```

**Response (200) - No active call:**
```json
{
  "statusCode": 200,
  "data": null,
  "message": "Active call fetched successfully"
}
```

### 8. Get Call Statistics

**GET** `/stats?days=30`

**Response (200):**
```json
{
  "statusCode": 200,
  "data": {
    "totalCalls": 50,
    "answeredCalls": 45,
    "totalDuration": 7200,
    "videoCalls": 20,
    "voiceCalls": 30
  },
  "message": "Call statistics fetched successfully"
}
```

---

## Database Schema

### Call Model

```javascript
{
  participants: [ObjectId],      // Array of User IDs
  initiator: ObjectId,           // User who started call
  chatId: ObjectId,              // Associated chat
  callType: String,              // 'voice' | 'video'
  status: String,                // 'initiated' | 'ringing' | 'connecting' | 'active' | 'ended' | 'declined' | 'missed' | 'failed'
  initiatedAt: Date,            // When call was initiated
  startedAt: Date,               // When call was accepted/started
  endedAt: Date,                 // When call ended
  duration: Number,              // Duration in seconds (auto-calculated)
  endReason: String,             // 'normal' | 'declined' | 'missed' | 'failed' | 'network_error' | 'cancelled' | 'timeout'
  endedBy: ObjectId,             // User who ended call
  metadata: {
    initiatorDevice: String,
    receiverDevice: String,
    quality: String,             // 'excellent' | 'good' | 'poor' | 'failed'
    connectionType: String       // 'wifi' | 'cellular' | 'unknown'
  },
  createdAt: Date,               // Auto-generated
  updatedAt: Date                // Auto-generated
}
```

### Indexes

- `initiator: 1, initiatedAt: -1` - Fast lookup of calls by initiator
- `participants: 1, initiatedAt: -1` - Fast lookup of user's calls
- `chatId: 1, initiatedAt: -1` - Fast lookup of calls in a chat
- `status: 1, initiatedAt: -1` - Fast lookup by status

---

## Socket Events

### Client → Server Events

These are optional and used for real-time UI updates. Main call state management happens via HTTP endpoints.

#### `call_accept` (Optional)
```javascript
socket.emit('call_accept', {
  callId: '507f1f77bcf86cd799439013',
  callerId: '507f1f77bcf86cd799439010'
});
```

#### `call_decline` (Optional)
```javascript
socket.emit('call_decline', {
  callId: '507f1f77bcf86cd799439013',
  callerId: '507f1f77bcf86cd799439010'
});
```

#### `call_end` (Optional)
```javascript
socket.emit('call_end', {
  callId: '507f1f77bcf86cd799439013',
  participants: ['507f1f77bcf86cd799439010', '507f1f77bcf86cd799439011'],
  endReason: 'normal'
});
```

### Server → Client Events

#### `incoming_call`
Emitted to receiver when a call is initiated.

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  chatId: '507f1f77bcf86cd799439012',
  callType: 'voice',
  caller: {
    _id: '507f1f77bcf86cd799439010',
    username: 'jane_doe',
    fullName: 'Jane Doe',
    profileImageUrl: 'https://...'
  },
  stream: {
    apiKey: 'your_stream_api_key',
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    callId: '507f1f77bcf86cd799439013',
    streamCallType: 'default'
  },
  timestamp: '2024-01-15T10:30:00.000Z'
}
```

#### `call_accepted`
Emitted to caller when receiver accepts the call.

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  acceptedBy: {
    _id: '507f1f77bcf86cd799439011',
    username: 'john_doe',
    fullName: 'John Doe',
    profileImageUrl: 'https://...'
  },
  timestamp: '2024-01-15T10:30:15.000Z'
}
```

#### `call_declined`
Emitted to caller when receiver declines the call.

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  declinedBy: {
    _id: '507f1f77bcf86cd799439011',
    username: 'john_doe',
    fullName: 'John Doe',
    profileImageUrl: 'https://...'
  },
  timestamp: '2024-01-15T10:30:20.000Z'
}
```

#### `call_ended`
Emitted to all participants when call ends.

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  endedBy: {
    _id: '507f1f77bcf86cd799439010',
    username: 'jane_doe',
    fullName: 'Jane Doe',
    profileImageUrl: 'https://...'
  },
  endReason: 'normal',
  duration: 285,
  timestamp: '2024-01-15T10:35:00.000Z'
}
```

#### `call_status_update`
Emitted when call status changes (e.g., connecting → active).

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  status: 'active',
  metadata: {
    quality: 'good',
    connectionType: 'wifi'
  },
  updatedBy: '507f1f77bcf86cd799439010',
  timestamp: '2024-01-15T10:30:20.000Z'
}
```

#### `call_timeout`
Emitted when a call times out (not answered within timeout period).

```javascript
{
  callId: '507f1f77bcf86cd799439013',
  timestamp: '2024-01-15T10:32:00.000Z'
}
```

---

## Stream.io Integration

### Configuration

The system uses Stream.io SDK for audio/video streaming. Configuration is done via environment variables:

```env
STREAM_API_KEY=your_api_key
STREAM_API_SECRET=your_api_secret
```

### Call Creation

When a call is initiated, the server:

1. **Registers users** in Stream.io (if not already registered)
2. **Creates a call** with appropriate settings:
   - **Voice calls**: Audio enabled, video disabled
   - **Video calls**: Audio and video enabled
3. **Generates tokens** for both participants (24-hour expiration)

### Call Settings

#### Voice Call Settings
```javascript
{
  audio: {
    mic_default_on: true,
    speaker_default_on: true,
    default_device: 'speaker'
  },
  video: {
    camera_default_on: false,
    enabled: false
  },
  ring: {
    auto_cancel_timeout_ms: 30000,
    incoming_call_timeout_ms: 30000
  }
}
```

#### Video Call Settings
```javascript
{
  audio: {
    mic_default_on: true,
    speaker_default_on: true,
    default_device: 'speaker'
  },
  video: {
    camera_default_on: true,
    enabled: true,
    camera_facing: 'front',
    target_resolution: {
      width: 1280,
      height: 720,
      bitrate: 1500000
    }
  },
  screensharing: {
    enabled: true,
    access_request_enabled: false
  }
}
```

### Client Integration

Clients receive Stream.io credentials in the `initiateCall` response:

```javascript
{
  stream: {
    apiKey: 'your_stream_api_key',
    callId: '507f1f77bcf86cd799439013',
    streamCallType: 'default',
    callerToken: 'token_for_caller',
    receiverToken: 'token_for_receiver',
    expiresAt: '2024-01-16T10:30:00.000Z'
  }
}
```

Clients should:
1. Initialize Stream.io SDK with `apiKey`
2. Create a call client using `streamCallType` and `callId`
3. Join the call using their respective token
4. Handle media tracks (audio/video) based on call type

---

## Configuration

### Environment Variables

```env
# Stream.io Configuration
STREAM_API_KEY=your_stream_api_key
STREAM_API_SECRET=your_stream_api_secret

# MongoDB
MONGODB_URI=mongodb://localhost:27017/findernate

# Redis (for Socket.IO adapter)
REDIS_URL=redis://localhost:6379

# JWT
ACCESS_TOKEN_SECRET=your_jwt_secret

# Firebase (for push notifications)
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_PRIVATE_KEY=your_private_key
FIREBASE_CLIENT_EMAIL=your_client_email

# Server
PORT=4000
NODE_ENV=production
```

### Constants

Defined in `call.controllers.js`:

```javascript
const CALL_TIMEOUT_MINUTES = 2;        // Calls timeout after 2 minutes
const CLEANUP_INTERVAL_MINUTES = 5;    // Cleanup runs every 5 minutes
```

### Socket.IO Configuration

Socket.IO is configured with:
- Redis adapter for multi-instance support
- User rooms: `user_{userId}` for direct messaging
- Chat rooms: `chat:{chatId}` for group messaging
- Authentication via JWT token

---

## Error Handling

### Call State Validation

The system enforces strict state transitions:

- **Initiate**: Only if no active calls exist
- **Accept**: Only from 'initiated', 'ringing', or 'connecting' states
- **Decline**: Only from 'initiated' or 'ringing' states
- **End**: Can be called from any active state (idempotent)

### Race Condition Prevention

All critical operations use MongoDB transactions to prevent race conditions:

```javascript
const session = await mongoose.startSession();
await session.withTransaction(async () => {
  const call = await Call.findById(callId).session(session);
  // ... update call ...
  await call.save({ session });
});
```

### Stale Call Cleanup

Automatic cleanup runs every 5 minutes to handle:
- Calls stuck in 'initiated' or 'ringing' state for > 2 minutes
- Calls are marked as 'missed' with `endReason: 'timeout'`
- Participants are notified via Socket.IO

### Error Responses

All endpoints return consistent error format:

```json
{
  "statusCode": 400,
  "message": "Error message",
  "data": {
    "existingCallId": "507f1f77bcf86cd799439013",
    "existingCall": { ... }
  }
}
```

---

## Security & Best Practices

### Authentication & Authorization

1. **JWT Authentication**: All endpoints require valid JWT token
2. **Participant Validation**: Users can only access calls they're part of
3. **Chat Permission Check**: Users can only call people in their chats

### Data Validation

1. **Input Validation**: All inputs are validated (ObjectId format, enum values)
2. **State Validation**: Call state transitions are strictly enforced
3. **Transaction Safety**: Critical operations use MongoDB transactions

### Performance Optimizations

1. **Parallel Queries**: Chat validation and user fetching run in parallel
2. **Lean Queries**: Use `.lean()` for read-only operations
3. **Indexes**: Database indexes on frequently queried fields
4. **Non-blocking Notifications**: FCM and message creation are fire-and-forget

### Scalability

1. **Redis Adapter**: Socket.IO uses Redis adapter for multi-instance support
2. **Stateless Design**: Server is stateless, state stored in MongoDB
3. **Connection Pooling**: MongoDB connection pooling for concurrent requests

### Monitoring & Logging

1. **Comprehensive Logging**: All operations are logged with emojis for easy scanning
2. **Error Tracking**: Errors are logged with full context
3. **Health Checks**: `/health` endpoint for monitoring

### Client Recommendations

1. **Token Management**: Store Stream.io tokens securely, refresh before expiration
2. **Reconnection Logic**: Implement reconnection for Socket.IO disconnections
3. **State Synchronization**: Poll `/active` endpoint on app resume to sync state
4. **Error Handling**: Handle all error responses gracefully
5. **Idempotency**: All endpoints are idempotent, safe to retry

---

## Troubleshooting

### Common Issues

1. **Call not received**
   - Check Socket.IO connection status
   - Verify FCM token is valid
   - Check user is online
   - Verify receiver ID is correct

2. **Call stuck in 'initiated' state**
   - Automatic cleanup will handle after 2 minutes
   - Use `/force-end-active` endpoint for manual cleanup
   - Check server logs for errors

3. **Stream.io connection fails**
   - Verify `STREAM_API_KEY` and `STREAM_API_SECRET` are set
   - Check token expiration
   - Verify network connectivity
   - Check Stream.io dashboard for errors

4. **Race conditions**
   - All critical operations use transactions
   - Check MongoDB transaction logs if issues persist
   - Verify transaction retry logic

5. **Socket.IO not receiving events**
   - Verify JWT token is valid
   - Check user is in correct room (`user_{userId}`)
   - Verify Redis adapter is configured
   - Check CORS settings

6. **FCM notifications not received**
   - Verify FCM token is stored in user document
   - Check Firebase project configuration
   - Verify device has internet connection
   - Check notification permissions on device

### Debugging Tips

1. **Enable verbose logging**: Set `NODE_ENV=development` for detailed logs
2. **Check MongoDB indexes**: Run `npm run db:indexes:list` to verify indexes
3. **Monitor Socket.IO**: Use Socket.IO admin UI or check Redis for connections
4. **Stream.io dashboard**: Check Stream.io dashboard for call analytics
5. **Network inspection**: Use browser DevTools or network monitoring tools

---

## Testing

### Manual Testing Checklist

- [ ] Initiate voice call
- [ ] Initiate video call
- [ ] Accept incoming call
- [ ] Decline incoming call
- [ ] End active call
- [ ] Call timeout (wait 2+ minutes)
- [ ] Multiple simultaneous calls (should fail)
- [ ] Call history retrieval
- [ ] Call statistics
- [ ] Socket.IO events received
- [ ] FCM notifications received
- [ ] Stream.io media streaming
- [ ] Permissions handling (mic/camera)
- [ ] Network interruption handling
- [ ] App background/foreground transitions

### Automated Testing

Consider adding unit tests for:
- Call state transitions
- Transaction safety
- Error handling
- Input validation

---

## Future Enhancements

Potential improvements:

- [ ] Group calls (3+ participants)
- [ ] Call recording
- [ ] Screen sharing (already supported in Stream.io)
- [ ] Call quality metrics
- [ ] Call forwarding
- [ ] Do Not Disturb mode
- [ ] Call blocking
- [ ] Call history export
- [ ] Call transcription
- [ ] Video filters/effects

---

## Support

For issues or questions:

1. Check logs in `logs/` directory
2. Review error responses from API
3. Verify environment variables are set correctly
4. Check Stream.io dashboard for call analytics
5. Review Socket.IO connection status
6. Check MongoDB indexes are created

---

**Last Updated**: 2024-01-15  
**Version**: 1.0.0  
**Author**: FinderNate Development Team

