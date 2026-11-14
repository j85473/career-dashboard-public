// These production overrides predate component pins. Only the reviewed
// directives on their owning units are compatible with selective updates.
// Comments and blank lines carry no systemd behavior; every other line must
// match. In particular, a familiar filename is not proof of safe contents.
const normalize = (source) => source.split('\n').map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && !line.startsWith(';')).join('\n');

export function reviewedWorkerOverride(unit, filename, source) {
  let expected;
  if (filename === '50-automatic-maintenance.conf') {
    expected = '[Unit]\nConditionPathExists=!/var/lib/m70-auto-maintenance/hold-background';
  } else if (unit === 'career-dashboard-backup.service' && filename === '60-repository-backup.conf') {
    // Owned by install-m70-repository-backup.sh; the platform group always
    // uses coordinated activation when its backup implementation changes.
    expected = `[Unit]
StartLimitIntervalSec=8h
[Service]
ExecStart=
ExecStart=/usr/local/sbin/career-m70-repository-backup
TimeoutStartSec=3h
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6`;
  } else if (['career-dashboard-discovery.service', 'career-dashboard-discovery-audit.service'].includes(unit)) {
    // Preserve the explicit direct/local Common Crawl selection and its
    // credential fence. Both environment files are fingerprinted separately.
    if (filename === '90-direct-commoncrawl.conf') expected = `[Service]
EnvironmentFile=
EnvironmentFile=/etc/career-dashboard/runtime.env
EnvironmentFile=/etc/career-dashboard/acquisition-release.env
EnvironmentFile=/etc/career-dashboard/discovery-source.env`;
    if (filename === '95-local-commoncrawl.conf') expected = '[Service]\nEnvironmentFile=-/etc/career-dashboard/common-crawl-local.env';
  }
  return typeof source === 'string' && expected !== undefined && normalize(source) === normalize(expected);
}
