import { prisma } from '../src/lib/prisma';
import { PUBLIC_ATS_LAUNCH_BOARDS } from '../src/lib/publicAtsLaunchBoards';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
import { validateSlug } from '../src/scripts/discoverATS';
import { catalogueFirstCollectionCandidate, isFirstCollectionPlatform } from '../src/lib/atsFirstCollectionAdmission';

/** Default is live validation only. --apply adds verified NEW boards to normal rotation. */
async function main() {
  const apply = process.argv.includes('--apply');
  const selected = process.argv.filter(arg => arg.startsWith('--platform=')).map(arg => arg.slice(11));
  if (selected.some(platform => !PUBLIC_ATS_LAUNCH_BOARDS.some(board => board.platform === platform))) throw Error('Unknown seed platform');
  for (const board of PUBLIC_ATS_LAUNCH_BOARDS.filter(board => !selected.length || selected.includes(board.platform))) {
    if (isFirstCollectionPlatform(board.platform)) {
      if (apply) await catalogueFirstCollectionCandidate(prisma, board);
      console.log(JSON.stringify({ ...board, outcome: apply ? 'catalogued_waiting' : 'catalogue_preview' }));
      continue;
    }
    const validation = await validateSlug(board.platform, board.slug);
    if (!validation.success) throw new Error(`${board.platform} validation failed: ${validation.reason}`);
    const outcome = apply ? await prisma.$transaction(transaction => recordDiscoveredAtsBoard(transaction, board,
      new Date(), { jobsFound: validation.jobsFound, reactivateExisting: false })) : 'validated_only';
    console.log(JSON.stringify({ ...board, outcome, listingCount: validation.jobsFound }));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Public board validation failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
