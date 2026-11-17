#!/bin/bash
set -euo pipefail
UNIT=${1:?Systemd unit required}
# The stored-catalogue pass alone can take more than ten minutes. Honor the
# canonical API unit's existing 50-minute service budget without interrupting
# its checkpointed work; other workers retain the ten-minute deployment limit.
attempt_limit=120
if [[ $UNIT == career-dashboard-canonical-api.service ]]; then attempt_limit=600; fi
# A Type=oneshot unit stays activating throughout ExecStart. is-active returns
# nonzero for that state even though the process can still write to PostgreSQL.
for ((attempt=0;attempt<attempt_limit;attempt++)); do
 state=$(systemctl show "$UNIT" --property=ActiveState --value)
 case "$state" in
  inactive|failed) exit 0 ;;
  active|activating|deactivating|reloading|refreshing)
   if (( attempt % 12 == 0 )); then
    echo "Waiting for $UNIT to become idle: $state ($((attempt * 5))/$((attempt_limit * 5)) seconds)."
   fi
   sleep 5 ;;
  *) echo "Could not establish whether $UNIT is idle: $state" >&2; exit 1 ;;
 esac
done
echo "$UNIT is still $state; refusing to continue the release." >&2
exit 1
