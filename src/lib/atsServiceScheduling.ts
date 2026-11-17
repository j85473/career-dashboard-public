import { randomUUID } from 'node:crypto';
import { prisma } from './prisma';
import { Prisma, type PrismaClient } from './prismaClient';

export const ATS_SERVICE_MAX_WAIT_MS = 15 * 60_000;
export type ServiceChoice = { key: string; weight?: number; priority?: number; readySince?: number };
type ServiceClass = {
  virtualMs: number; serviceMs: number; turns: number; lastEligibleAt: number;
  lastSelectedAt: number; lastToken?: string;
};
type PendingTurn = { key: string; startedAt: number; expiresAt: number; charge: number;
  weight: number; previousSelectedAt: number; previousToken?: string };
export type AtsServiceState = { classes: Record<string, ServiceClass>; pending: Record<string, PendingTurn>; eligible?: string[] };
export type AtsServiceTurn = { resource: string; token: string; key: string };
type Store = Pick<PrismaClient, '$transaction' | 'atsSchedulerState'>;

export function readServiceState(value: unknown): AtsServiceState {
  if (value == null || typeof value === 'object' && Object.keys(value).length === 0) return { classes: {}, pending: {} };
  if (typeof value !== 'object' || !('classes' in value) || !('pending' in value)) throw Error('Invalid ATS service accounting');
  // Only this module writes these bounded records. Do not reinterpret corrupt
  // accounting as fresh credit; fail closed so the worker can report it.
  const state = structuredClone(value) as AtsServiceState;
  if (!state.classes || !state.pending || Object.keys(state.classes).length > 16 || Object.keys(state.pending).length > 32)
    throw Error('Invalid ATS service accounting');
  for (const c of Object.values(state.classes))
    if (![c.virtualMs, c.serviceMs, c.turns, c.lastEligibleAt, c.lastSelectedAt].every(Number.isFinite))
      throw Error('Invalid ATS service accounting');
  for (const p of Object.values(state.pending))
    if (!state.classes[p.key] || ![p.startedAt, p.expiresAt, p.charge, p.weight, p.previousSelectedAt].every(Number.isFinite)
      || p.expiresAt <= p.startedAt || p.charge <= 0 || p.weight <= 0) throw Error('Invalid ATS service reservation');
  return state;
}

/** Elapsed service lends absent queues their share. API classes have equal
 * weight, so the active queue mix sets its own split; browser weights retain
 * their existing targets. Age bounds and priorities break competing ties. */
export function serviceChoiceOrder(state: AtsServiceState, choices: readonly ServiceChoice[],
  now: number): ServiceChoice[] {
  const wasEligible = (key: string) => state.eligible ? state.eligible.includes(key)
    : !!state.classes[key] && now - state.classes[key].lastEligibleAt < ATS_SERVICE_MAX_WAIT_MS;
  const recent = choices.filter(c => wasEligible(c.key)).map(c => state.classes[c.key]).filter(Boolean);
  const floor = recent.length ? Math.min(...recent.map(c => c.virtualMs)) : 0;
  const score = (choice: ServiceChoice) => {
    const c = state.classes[choice.key];
    return !c || !wasEligible(choice.key) ? Math.max(c?.virtualMs || 0, floor) : c.virtualMs;
  };
  const waitFrom = (choice: ServiceChoice) => Math.max(state.classes[choice.key]?.lastSelectedAt || 0,
    choice.readySince ?? (state.classes[choice.key]?.lastSelectedAt || now));
  return [...choices].sort((a, b) => {
    const aWait = now - waitFrom(a), bWait = now - waitFrom(b);
    if (aWait >= ATS_SERVICE_MAX_WAIT_MS || bWait >= ATS_SERVICE_MAX_WAIT_MS)
      return bWait - aWait || (a.priority || 0) - (b.priority || 0);
    return (score(a) - score(b))
      || waitFrom(a) - waitFrom(b) || (a.priority || 0) - (b.priority || 0);
  });
}

export async function readAtsServiceState(resource: string, client: Pick<Store, 'atsSchedulerState'> = prisma) {
  return readServiceState((await client.atsSchedulerState.findUnique({ where: { resource } }))?.state);
}

export async function reserveAtsServiceTurn(resource: string, choices: readonly ServiceChoice[], options: {
  now?: Date; quantumMs?: number; leaseMs?: number; client?: Store;
} = {}): Promise<AtsServiceTurn | null> {
  if (!choices.length) return null;
  const now = (options.now || new Date()).getTime();
  const client = options.client || prisma;
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-service:${resource}`}, 0))`;
    const state = readServiceState((await tx.atsSchedulerState.findUnique({ where: { resource } }))?.state);
    // An abandoned turn retains its bounded provisional charge. A restart
    // cannot refund work whose dispatch outcome is unknown or renew credit.
    for (const [token, pending] of Object.entries(state.pending))
      if (pending.expiresAt <= now) delete state.pending[token];
    if (Object.keys(state.pending).length >= 32) return null;
    const selected = serviceChoiceOrder(state, choices, now)[0];
    const wasEligible = (key: string) => state.eligible ? state.eligible.includes(key)
      : !!state.classes[key] && now - state.classes[key].lastEligibleAt < ATS_SERVICE_MAX_WAIT_MS;
    const recent = choices.filter(c => wasEligible(c.key)).map(c => state.classes[c.key]).filter(Boolean);
    const floor = recent.length ? Math.min(...recent.map(c => c.virtualMs)) : 0;
    for (const choice of choices) {
      const c = state.classes[choice.key] ||= { virtualMs: floor, serviceMs: 0, turns: 0, lastEligibleAt: now, lastSelectedAt: 0 };
      if (!wasEligible(choice.key)) c.virtualMs = Math.max(c.virtualMs, floor);
      c.lastEligibleAt = now;
    }
    state.eligible = choices.map(choice => choice.key);
    const token = randomUUID(), c = state.classes[selected.key];
    const weight = Math.max(0.01, selected.weight || 1);
    const charge = Math.max(1, Math.min(120_000, options.quantumMs || 45_000));
    state.pending[token] = { key: selected.key, startedAt: now, expiresAt: now + (options.leaseMs || 180_000),
      charge, weight, previousSelectedAt: c.lastSelectedAt, previousToken: c.lastToken };
    c.lastSelectedAt = now; c.lastToken = token; c.virtualMs += charge / weight;
    const data = state as unknown as Prisma.InputJsonValue;
    await tx.atsSchedulerState.upsert({ where: { resource }, create: { resource, state: data }, update: { state: data } });
    return { resource, token, key: selected.key };
  }, { timeout: 10_000 });
}

export async function finishAtsServiceTurn(turn: AtsServiceTurn, worked = true, now = new Date(), client: Store = prisma) {
  return client.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-service:${turn.resource}`}, 0))`;
    const row = await tx.atsSchedulerState.findUnique({ where: { resource: turn.resource } });
    const state = readServiceState(row?.state), pending = state.pending[turn.token];
    if (!pending || pending.key !== turn.key) return false;
    const c = state.classes[pending.key];
    const actual = worked ? Math.max(1, Math.min(pending.expiresAt - pending.startedAt, now.getTime() - pending.startedAt)) : 0;
    c.virtualMs += (actual - pending.charge) / pending.weight;
    c.serviceMs += actual; c.turns += worked ? 1 : 0;
    if (!worked && c.lastToken === turn.token) { c.lastSelectedAt = pending.previousSelectedAt; c.lastToken = pending.previousToken; }
    delete state.pending[turn.token];
    await tx.atsSchedulerState.update({ where: { resource: turn.resource }, data: { state: state as unknown as Prisma.InputJsonValue } });
    return true;
  }, { timeout: 10_000 });
}
