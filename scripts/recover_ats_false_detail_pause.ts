import { prisma } from '../src/lib/prisma';
import { recoverFalseHomerunDetailPause } from '../src/lib/atsFalseDetailPauseRecovery';

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Use recover_ats_false_detail_pause.ts [--apply]');
  console.log(JSON.stringify(await recoverFalseHomerunDetailPause(prisma, process.argv.includes('--apply')), null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
