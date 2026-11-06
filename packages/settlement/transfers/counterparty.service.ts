/**
 * Counterparties (Step 2, slice 5): the receiving addresses an institution may settle to.
 *
 * An address is usable only when ACTIVE. In SANDBOX it is activated on registration (the custody
 * stub has no whitelist). In PRODUCTION it waits for an operator who attests that the address is
 * whitelisted at the custodian (Fireblocks Transaction Authorization Policy) — AxLink does not
 * automate the custodian's whitelist, by design: the policy that stops a wrong address lives at the
 * custodian and is changed by people with that authority, not by an API key.
 */
import { Prisma, type Counterparty } from '@prisma/client';
import { prisma } from '../../core/ledger/ledger.service';
import { NETWORKS, type NetworkId } from '../../core/assets/registry';
import { providers } from '../../providers/registry/provider-registry';
import { ApiError } from '../../shared/errors';
import { log } from '../../shared/logger';

export interface Scope { institutionId: string; environmentId: string }
const where = (s: Scope) => ({ institutionId: s.institutionId, environmentId: s.environmentId }); // strip extra keys (environmentKind) before Prisma

export interface RegisterCounterpartyInput { label: string; network?: NetworkId; address?: string; participant?: string; note?: string }

/**
 * NETWORK counterparty: another AxLink institution. The destination is that participant's settlement
 * wallet in the same environment, resolved when a settlement is approved — a move that never leaves
 * AxLink custody. It needs no custodian whitelisting, so it is ACTIVE at once in every environment;
 * the participant must itself be ACTIVE and hold an ACTIVE wallet in this environment kind.
 */
async function registerNetworkCounterparty(scope: Scope & { environmentKind: 'SANDBOX' | 'PRODUCTION' }, input: RegisterCounterpartyInput) {
  const slug = (input.participant ?? '').trim().toLowerCase();
  const participant = await prisma.institution.findUnique({ where: { slug }, select: { id: true, slug: true, status: true } });
  if (!participant || participant.status !== 'ACTIVE') throw new ApiError('PARTICIPANT_NOT_FOUND', `no active AxLink participant '${slug}'`, 404);
  if (participant.id === scope.institutionId) throw new ApiError('PARTICIPANT_IS_SELF', 'an institution cannot register itself as a counterparty', 400);
  const wallet = await settlementWalletFor(participant.id, scope.environmentKind);
  if (!wallet) throw new ApiError('PARTICIPANT_NOT_READY', `'${slug}' has no active ${scope.environmentKind} wallet yet`, 409);
  const address = `network:${participant.slug}`;
  try {
    const cp = await prisma.counterparty.create({ data: {
      institutionId: scope.institutionId, environmentId: scope.environmentId, label: input.label, network: wallet.network, kind: 'NETWORK', address, participantInstitutionId: participant.id,
      note: input.note ?? null, status: 'ACTIVE', approvedBy: 'network', approvedAt: new Date(), custodyWhitelisted: false,
    } });
    log.info('counterparty.registered', { institutionId: scope.institutionId, counterpartyId: cp.id, kind: 'NETWORK', participant: slug });
    return cp;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.counterparty.findFirst({ where: { environmentId: scope.environmentId, address } });
      throw new ApiError('COUNTERPARTY_EXISTS', `'${slug}' is already a counterparty in this environment`, 409, { counterpartyId: dup?.id });
    }
    throw e;
  }
}

/** The wallet that receives network settlements for an institution in one environment kind: its oldest ACTIVE wallet there. */
export async function settlementWalletFor(institutionId: string, environmentKind: 'SANDBOX' | 'PRODUCTION', db: Prisma.TransactionClient | typeof prisma = prisma, match: { network?: string; custodyProvider?: string } = {}) {
  // The participant itself must be ACTIVE (a suspended institution receives nothing), its environment too,
  // and the wallet must sit on the same network and custodian as the sender's so an internal move is possible.
  return db.wallet.findFirst({ where: { institutionId, status: 'ACTIVE', ...(match.network ? { network: match.network } : {}), ...(match.custodyProvider ? { custodyProvider: match.custodyProvider } : {}), environment: { kind: environmentKind, status: 'ACTIVE' }, institution: { status: 'ACTIVE' } }, orderBy: { createdAt: 'asc' } });
}

export async function registerCounterparty(scope: Scope & { environmentKind: 'SANDBOX' | 'PRODUCTION' }, input: RegisterCounterpartyInput) {
  if (input.participant) return registerNetworkCounterparty(scope, input);
  if (!input.address) throw new ApiError('VALIDATION_ERROR', 'address (external) or participant (network) is required', 400);
  const network = input.network ?? 'solana-mainnet';
  if (!NETWORKS[network]) throw new ApiError('UNSUPPORTED_NETWORK', `network ${network} is not supported`, 400);
  const address = input.address.trim();
  if (!providers.blockchain(network).isValidAddress(address)) throw new ApiError('INVALID_ADDRESS', `not a valid ${network} address`, 400);
  // An institution must not pay itself through the outbound path (it would pass the whitelist
  // screen while hiding a round-trip); its own wallets are reachable as deposits.
  const own = await prisma.wallet.findFirst({ where: { depositAddress: address }, select: { institutionId: true } });
  if (own) throw new ApiError('ADDRESS_IS_AXLINK_WALLET', 'this address is an AxLink custody wallet; settle to it with a deposit instruction on that institution, not an outbound transfer', 400);
  const sandbox = scope.environmentKind === 'SANDBOX';
  try {
    const cp = await prisma.counterparty.create({ data: {
      institutionId: scope.institutionId, environmentId: scope.environmentId, label: input.label, network, address, note: input.note ?? null,
      ...(sandbox ? { status: 'ACTIVE', approvedBy: 'sandbox-auto', approvedAt: new Date(), custodyWhitelisted: false } : {}),
    } });
    log.info('counterparty.registered', { institutionId: scope.institutionId, counterpartyId: cp.id, network, status: cp.status });
    return cp;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const dup = await prisma.counterparty.findFirst({ where: { environmentId: scope.environmentId, address } });
      throw new ApiError('COUNTERPARTY_EXISTS', 'this address is already registered in this environment', 409, { counterpartyId: dup?.id });
    }
    throw e;
  }
}

export function listCounterparties(scope: Scope) {
  return prisma.counterparty.findMany({ where: where(scope), orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function getCounterparty(id: string, scope: Scope) {
  const cp = await prisma.counterparty.findFirst({ where: { id, ...where(scope) } });
  if (!cp) throw new ApiError('NOT_FOUND', 'counterparty not found', 404);
  return cp;
}

/** Institution disables its own counterparty; it can never re-enable one (that is an operator approval). */
export async function disableCounterparty(id: string, scope: Scope) {
  const r = await prisma.counterparty.updateMany({ where: { id, ...where(scope), status: { not: 'DISABLED' } }, data: { status: 'DISABLED' } });
  if (r.count !== 1) { await getCounterparty(id, scope); throw new ApiError('ALREADY_DISABLED', 'counterparty is already disabled', 409); }
}

/** Operator approval (PRODUCTION). `custodyWhitelisted` is the operator's attestation; it is recorded, not verified here. */
export async function approveCounterparty(id: string, by: string, attest: { custodyWhitelisted: boolean; note?: string }) {
  const cp = await prisma.counterparty.findUnique({ where: { id } });
  if (!cp) throw new ApiError('NOT_FOUND', 'counterparty not found', 404);
  if (cp.status !== 'PENDING_APPROVAL') throw new ApiError('NOT_PENDING', `counterparty is ${cp.status}`, 409);
  if (!attest.custodyWhitelisted) throw new ApiError('NOT_WHITELISTED', 'approve only after the address is whitelisted at the custodian; pass custodyWhitelisted: true to attest', 400);
  const r = await prisma.counterparty.update({ where: { id }, data: { status: 'ACTIVE', approvedBy: by, approvedAt: new Date(), custodyWhitelisted: true, note: attest.note ?? cp.note } });
  log.info('counterparty.approved', { counterpartyId: id, by });
  return r;
}

export async function rejectCounterparty(id: string, by: string, reason: string) {
  const cp = await prisma.counterparty.findUnique({ where: { id } });
  if (!cp) throw new ApiError('NOT_FOUND', 'counterparty not found', 404);
  const r = await prisma.counterparty.update({ where: { id }, data: { status: 'DISABLED', approvedBy: by, note: `rejected: ${reason}`.slice(0, 500) } });
  log.info('counterparty.rejected', { counterpartyId: id, by });
  return r;
}

export function serializeCounterparty(c: Counterparty) {
  return { id: c.id, label: c.label, kind: c.kind, network: c.network, address: c.kind === 'NETWORK' ? null : c.address, participant: c.kind === 'NETWORK' ? c.address.replace(/^network:/, '') : null, status: c.status, approvedAt: c.approvedAt, custodyWhitelisted: c.custodyWhitelisted, note: c.note, createdAt: c.createdAt };
}
