#!/bin/sh
# uptime-monitor.sh — external health check for paytrack on Fly.
# Pings the DEEP health endpoint (also probes Supabase) and SMS-alerts Mike from
# the internal/test number on sustained failure. Catches the failure classes that
# HA can't (Supabase outage, Fly platform/billing, app 503) faster than the daily
# app-auditor. Designed to run every ~5 min via launchd.
#
# Requires (from ~/.zshenv via sync-mac-env): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
# TWILIO_TEST1_PHONE_NUMBER (internal sender), ALERT_PHONE_NUMBER or hardcoded Mike.
set -u

URL="https://paytrack.lemedspa.app/api/health"
STATE_DIR="${HOME}/.paytrack-uptime"
FAIL_FILE="${STATE_DIR}/consecutive-failures"
ALERTED_FILE="${STATE_DIR}/alerted"
MIKE="${ALERT_PHONE_NUMBER:-+13106218356}"
FAIL_THRESHOLD=2   # require 2 consecutive failures before alerting (avoid blips)
mkdir -p "$STATE_DIR"

# Probe: healthy = HTTP 200 AND body status not "degraded".
code=$(curl -s -o /tmp/pt-health.json -w '%{http_code}' --max-time 20 "$URL" 2>/dev/null || echo 000)
body=$(cat /tmp/pt-health.json 2>/dev/null || echo '')
healthy=0
if [ "$code" = "200" ] && ! printf '%s' "$body" | grep -q '"status":"degraded"'; then
  healthy=1
fi

send_sms() {
  msg="$1"
  [ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ] || { echo "twilio unset, skip SMS"; return; }
  curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json" \
    --data-urlencode "From=${TWILIO_TEST1_PHONE_NUMBER:-$TWILIO_PHONE_NUMBER}" \
    --data-urlencode "To=$MIKE" \
    --data-urlencode "Body=$msg" \
    -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" >/dev/null 2>&1
}

if [ "$healthy" = "1" ]; then
  # Recovered? If we'd previously alerted, send an all-clear and reset.
  if [ -f "$ALERTED_FILE" ]; then
    send_sms "[paytrack] RECOVERED — health is OK again ($code)."
    rm -f "$ALERTED_FILE"
  fi
  rm -f "$FAIL_FILE"
  echo "ok ($code)"
  exit 0
fi

# Unhealthy — increment consecutive failure count.
fails=$(cat "$FAIL_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$FAIL_FILE"
echo "unhealthy ($code) — consecutive=$fails"

# Alert once when we cross the threshold (dedupe via ALERTED_FILE).
if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ ! -f "$ALERTED_FILE" ]; then
  reason=$(printf '%s' "$body" | grep -o '"supabase":"[a-z]*"' | head -1)
  send_sms "[paytrack] DOWN/degraded: HTTP $code ${reason}. $URL failing ${fails}x. Check Fly + Supabase."
  touch "$ALERTED_FILE"
fi
exit 1
