# Firebase Configuration for Push Notifications

## Setup Steps

### 1. Install Firebase Admin SDK
```bash
npm install firebase-admin
```

### 2. Get Firebase Service Account Credentials
1. Go to Firebase Console: https://console.firebase.google.com
2. Select your project
3. Settings (gear icon) → Service Accounts → Generate New Private Key
4. Save the JSON file securely
5. Copy the values to environment variables

### 3. Add Environment Variables to .env
```
# Firebase Configuration
FIREBASE_PROJECT_ID=<your-project-id>
FIREBASE_PRIVATE_KEY_ID=<your-private-key-id>
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=<your-client-email>
FIREBASE_CLIENT_ID=<your-client-id>
```

**Important:** For Docker, keep the newlines as `\n` (already handled by the notification-service.js)

### 4. Database Schema Update

Add FCM token fields to users table:

```sql
ALTER TABLE up_users ADD COLUMN fcm_token VARCHAR(255) NULL;
ALTER TABLE up_users ADD COLUMN fcm_token_updated_at TIMESTAMP NULL;
```

### 5. Create Notification History Table

```sql
CREATE TABLE IF NOT EXISTS notification_histories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  recipient INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body LONGTEXT NOT NULL,
  related_id VARCHAR(255),
  delivery_status VARCHAR(50) DEFAULT 'pending',
  delivery_method VARCHAR(50) DEFAULT 'socket',
  failure_reason LONGTEXT,
  retry_count INT DEFAULT 0,
  delivered_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at TIMESTAMP NULL,
  FOREIGN KEY (recipient) REFERENCES up_users(id) ON DELETE CASCADE
);

CREATE INDEX idx_recipient ON notification_histories(recipient);
CREATE INDEX idx_type ON notification_histories(type);
CREATE INDEX idx_created_at ON notification_histories(created_at);
```

### 6. Restart Docker

```bash
docker-compose restart
```

### 7. Test

Generate a visitor request and check:
- Backend logs for "✅ FCM token stored"
- Backend logs for "✅ Push notification sent"
- Database: `SELECT fcm_token FROM up_users;`
- Database: `SELECT * FROM notification_histories;`

## Troubleshooting

**Firebase not initialized?**
- Check .env variables are set correctly
- Check FIREBASE_PRIVATE_KEY format (must have `\n` newlines)
- Check Docker has access to environment variables

**No push notifications received?**
- Verify FCM token is stored: `SELECT fcm_token FROM up_users WHERE id = <user_id>;`
- Check app has notification permissions
- Check Firebase console for any errors

**Notification not reaching offline users?**
- This is expected for pure Socket.IO
- FCM will deliver when user comes online
- Check notification_histories table for delivery status

## Frontend Firebase Setup

The frontend (Flutter) already has:
- ✅ Firebase Cloud Messaging configured
- ✅ Socket.io FCM token transmission
- ✅ Local notification display
- ✅ Background message handler

No frontend changes needed!

## Security Notes

- Keep FIREBASE_PRIVATE_KEY secret (never commit to git)
- Use strong environment variable protection in Docker
- FCM tokens are device-specific and expire periodically (handled automatically)
- Consider rate-limiting notifications to prevent spam
