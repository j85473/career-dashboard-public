#!/bin/bash
# Sourced only after the activation owner has taken both locks, built the
# candidate, proven schema readiness and checked the pinned worker manifest.
activate_web_only() {
 local switched=0
 recover_web_only() {
  trap - ERR
  echo 'Web release failed; restoring prior web routing. Background workers were left running.' >&2
  if (( switched == 1 )); then
   systemctl stop career-dashboard.service
   ln -sfn "$OLD" "$APP.rollback"; mv -Tf "$APP.rollback" "$APP"
  fi
  systemctl start career-dashboard.service
  return 1
 }
 trap recover_web_only ERR
 echo 'Worker inputs and schema are unchanged; activating the web release without stopping background work.'
 systemctl stop career-dashboard.service
 ln -sfn "$STAGE" "$APP.next"; mv -Tf "$APP.next" "$APP"
 switched=1
 systemctl start career-dashboard.service
 local healthy=0
 for ((attempt=0;attempt<40;attempt++)); do
  if curl -fsS --max-time 10 http://100.107.116.123:3000/api/health > /dev/null; then healthy=1; break; fi
  sleep 3
 done
 (( healthy == 1 ))
 # Assert the same private control endpoint still belongs to the pinned
 # worker release. This check never starts, stops or reclaims pipeline work.
 runuser -u career-dashboard -- node --import tsx "$STAGE/scripts/deployment/check-pipeline-service.ts" "$WORKER_REV"
 trap - ERR
 touch "$STAGE/.m70-activation-complete"
 python3 "$STAGE/scripts/deployment/m70-storage.py" cleanup --apply --deploy-lock-held --protect-release "$OLD" \
  || echo 'Web release is healthy; obsolete-release cleanup needs attention.' >&2
 echo "Activated web $REV on M70; workers remain on $WORKER_REV."
}
