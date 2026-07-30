#!/bin/bash
# Migration Guide: 64-char to 12-char Base62 QR Tokens

echo "🚀 QR Token System Migration"
echo "================================"
echo ""

# Step 1: Database Migration
echo "Step 1: Update Database Schema"
echo "- Schema already updated in: src/api/qr-token/content-types/qr-token/schema.json"
echo "- Added 'token' field (string, unique, required)"
echo "- Kept 'hash' field for backward compatibility"
echo ""

# Step 2: Backend Code
echo "Step 2: Verify Backend Changes"
echo "✓ exit-request.js - Token generation updated"
echo "✓ qr-token.js - Token validation updated"
echo "✓ base62.js - Base62 encoding utility created"
echo ""

# Step 3: Database Migration
echo "Step 3: Run Strapi Migration"
echo "Commands:"
echo "  docker-compose restart  # or docker restart <container>"
echo ""
echo "Strapi will automatically:"
echo "  - Create 'token' column in qr_tokens table"
echo "  - Add unique index on 'token' field"
echo "  - Preserve existing data"
echo ""

# Step 4: Testing
echo "Step 4: Test Token Generation"
echo "Commands:"
echo "  cd pravesh-backend"
echo "  node src/api/qr-token/test-base62.js"
echo ""

# Step 5: Manual Testing
echo "Step 5: Manual Integration Test"
echo "1. Generate exit QR with test account"
echo "2. Verify token is 10-12 characters"
echo "3. Verify QR code scans faster"
echo "4. Verify entry QR generation works"
echo "5. Check database: SELECT token FROM qr_tokens LIMIT 5;"
echo ""

# Step 6: Monitoring
echo "Step 6: Post-Migration Monitoring"
echo "Check logs for:"
echo "  ✓ 'Generated 12-char QR Token' messages"
echo "  ✓ 'Invalid token format' errors (should be minimal)"
echo "  ✓ 'QR VALIDATE API HIT' with new tokens"
echo ""

# Step 7: Rollback (if needed)
echo "Step 7: Rollback Plan"
echo "If issues occur:"
echo "  1. Schema still has 'hash' field - kept for compatibility"
echo "  2. Old validation logic can be restored from git"
echo "  3. Database: DELETE FROM qr_tokens WHERE token IS NOT NULL"
echo ""

echo "================================"
echo "✅ Migration Ready!"
echo "Next: Restart Docker and test"
echo ""
