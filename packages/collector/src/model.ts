import type { CreditedEffect, PendingEnvelope } from '@ictt-sentinel/invariant-core';
import type {
  MessageOutcomeEvent,
  TokensRoutedEvent,
  TokensSentEvent,
  TransferrerPayload,
} from '@ictt-sentinel/ictt-adapters';

/**
 * The economic model of one canonical ERC20 route, from decoded facts.
 *
 * Pure: no reads, no clock. The collector hands it what independent witnesses
 * agreed on at the two pins, and it answers which transfers are still in flight,
 * which executions credited value and from what source, and whether the two
 * pins form a causally closed cut.
 *
 * Every rule follows the pinned source (icm-services @ 8fef6ef7):
 *
 *   home -> remote   TokenHome._send            D += adjustedAmount, TokensSent
 *                    remote _receive SINGLE_HOP  S += payload.amount (mint)
 *   remote -> home   TokenRemote._processSend    S -= amount (burn), TokensSent
 *                    home _receive SINGLE_HOP    D -= payload.amount
 *
 *   =>  D(homePin) - S(remotePin) = P_h2r + P_r2h
 *
 * where a transfer is pending when its source fact is inside the cut and its
 * successful execution is not. The identity only holds if every execution
 * inside the cut has its source inside the cut too; otherwise the cut is open
 * and the evaluation is UNKNOWN, never a number.
 *
 * Multi-hop, routed and send-and-call traffic also moves D, but the engine does
 * not model it; any of it on a route marks that route unsupported.
 */

export interface LogCoordinate {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  /** Chain time of the block, not a wall clock. */
  readonly blockTimestamp: bigint;
}

export interface Fact<T> {
  readonly value: T;
  readonly at: LogCoordinate;
}

/** A Teleporter delivery, with the ICTT payload when it decoded. */
export interface Delivery {
  readonly messageId: string;
  readonly sourceBlockchainId: string;
  readonly originSenderAddress: string;
  readonly destinationAddress: string;
  readonly payload: TransferrerPayload;
}

export interface PinRef {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly timestamp: bigint;
}

/** Everything one side of a route contributed, already agreed across witnesses. */
export interface SideFacts {
  readonly blockchainId: string;
  readonly pin: PinRef;
  /** TokensSent from this side's transferrer. */
  readonly sent: readonly Fact<TokensSentEvent>[];
  /** Routed and send-and-call events from this side's transferrer. */
  readonly unsupportedSends: readonly Fact<TokensRoutedEvent>[];
  /** Deliveries from the other side's transferrer to this side's transferrer. */
  readonly delivered: readonly Fact<Delivery>[];
  /** Messenger outcomes for messages from the other side's chain. */
  readonly executed: readonly Fact<MessageOutcomeEvent>[];
  readonly failed: readonly Fact<MessageOutcomeEvent>[];
}

export interface Route {
  readonly homeBlockchainId: string;
  readonly tokenHomeAddress: string;
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
}

export type MessageDirection = 'home-to-remote' | 'remote-to-home';

/** A message's observed lifecycle, for the evidence record. */
export interface MessageTrace {
  readonly direction: MessageDirection;
  readonly messageId: string;
  readonly state: 'SOURCE_ACCOUNTED' | 'DELIVERED' | 'EXECUTED_FAILED' | 'EXECUTED_SUCCESS';
  readonly source: Fact<TokensSentEvent> | null;
  readonly delivery: Fact<Delivery> | null;
  readonly failures: readonly Fact<MessageOutcomeEvent>[];
  readonly executions: readonly Fact<MessageOutcomeEvent>[];
}

export interface OpenEdge {
  readonly direction: MessageDirection;
  readonly messageId: string;
}

export interface RouteAssessment {
  readonly pending: readonly PendingEnvelope[];
  readonly effects: readonly CreditedEffect[];
  readonly openEdges: readonly OpenEdge[];
  /** Why this route cannot be interpreted as canonical single-hop, if it cannot. */
  readonly unsupported: readonly string[];
  readonly messages: readonly MessageTrace[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const byMessage = <T extends { readonly messageId: string }>(
  facts: readonly Fact<T>[],
): Map<string, Fact<T>[]> => {
  const out = new Map<string, Fact<T>[]>();
  for (const f of facts) {
    const list = out.get(f.value.messageId);
    if (list) list.push(f);
    else out.set(f.value.messageId, [f]);
  }
  return out;
};

interface Direction {
  readonly direction: MessageDirection;
  /** Side where the transfer is accounted first. */
  readonly source: SideFacts;
  /** Side where it is executed. */
  readonly destination: SideFacts;
  /** Is a TokensSent on the source side one of this route's single-hop sends? */
  readonly isRouteSend: (e: TokensSentEvent) => boolean;
  /** Is a delivery on the destination side one of this route's messages? */
  readonly isRouteDelivery: (d: Delivery) => boolean;
}

const assessDirection = (
  d: Direction,
  route: Route,
  digestOf: (fact: Fact<unknown>, blockchainId: string) => string,
): RouteAssessment => {
  const unsupported: string[] = [];
  const sends = d.source.sent.filter((f) => d.isRouteSend(f.value));
  const sendsById = byMessage(sends);
  const deliveries = d.destination.delivered.filter((f) => d.isRouteDelivery(f.value));
  const deliveredById = byMessage(deliveries);
  const executedById = byMessage(d.destination.executed);
  const failedById = byMessage(d.destination.failed);

  for (const f of deliveries) {
    const type = f.value.payload.messageType;
    if (type !== 'SINGLE_HOP_SEND') unsupported.push(`${d.direction}:${type}`);
  }

  const pending: PendingEnvelope[] = [];
  const effects: CreditedEffect[] = [];
  const openEdges: OpenEdge[] = [];
  const messages: MessageTrace[] = [];

  // Every executed delivery of this route inside the destination cut.
  for (const [messageId, delivered] of deliveredById) {
    const executions = executedById.get(messageId) ?? [];
    const failures = failedById.get(messageId) ?? [];
    const source = sendsById.get(messageId) ?? [];
    const delivery = delivered[0] ?? null;
    if (executions.length === 0) continue;
    const amount = delivery?.value.payload.singleHopSend?.amount ?? null;
    const sourceFact = source.length === 1 ? (source[0] ?? null) : null;
    if (source.length === 0) {
      // Credited inside the cut, caused outside it (or never seen): the
      // identity cannot be evaluated with these pins. It is an open edge, not
      // an effect - an effect needs a source to be judged against, and without
      // one the only honest outcome is UNKNOWN.
      openEdges.push({ direction: d.direction, messageId });
    } else if (amount !== null) {
      effects.push({
        messageKey: messageId,
        remoteBlockchainId: route.remoteBlockchainId,
        remoteAddress: route.remoteAddress,
        amount,
        hasUniqueAuthorisedSource: source.length === 1,
        routeMatchesSource: sourceFact !== null && sourceFact.value.amount === amount,
        duplicateEffect: executions.length > 1 || delivered.length > 1,
        causalSourceFact: sourceFact === null ? null : digestOf(sourceFact, d.source.blockchainId),
      });
    }
    messages.push({
      direction: d.direction,
      messageId,
      state: 'EXECUTED_SUCCESS',
      source: sourceFact,
      delivery,
      failures,
      executions,
    });
  }

  // Every source send inside the source cut that has not executed inside the
  // destination cut is in flight.
  for (const [messageId, facts] of sendsById) {
    const fact = facts[0];
    if (fact === undefined) continue;
    if (facts.length > 1) unsupported.push(`${d.direction}:duplicate-send-${messageId}`);
    if ((executedById.get(messageId) ?? []).length > 0 && deliveredById.has(messageId)) continue;
    const delivery = deliveredById.get(messageId)?.[0] ?? null;
    const failures = failedById.get(messageId) ?? [];
    const age = d.source.pin.timestamp - fact.at.blockTimestamp;
    pending.push({
      messageKey: messageId,
      direction: d.direction,
      amount: fact.value.amount,
      // Seconds of chain time; a liveness signal only, never an economic one.
      ageSeconds: Number(age < 0n ? 0n : age),
      remoteBlockchainId: route.remoteBlockchainId,
      remoteAddress: route.remoteAddress,
    });
    messages.push({
      direction: d.direction,
      messageId,
      state:
        failures.length > 0
          ? 'EXECUTED_FAILED'
          : delivery !== null
            ? 'DELIVERED'
            : 'SOURCE_ACCOUNTED',
      source: fact,
      delivery,
      failures,
      executions: [],
    });
  }

  return { pending, effects, openEdges, unsupported, messages };
};

/**
 * Assess one approved route at its two pins.
 *
 * `home` holds TokenHome facts and home-messenger deliveries from this remote;
 * `remote` holds TokenRemote facts and remote-messenger deliveries from home.
 */
export const assessRoute = (
  route: Route,
  home: SideFacts,
  remote: SideFacts,
  digestOf: (fact: Fact<unknown>, blockchainId: string) => string,
): RouteAssessment => {
  const h2r = assessDirection(
    {
      direction: 'home-to-remote',
      source: home,
      destination: remote,
      isRouteSend: (e) =>
        same(e.destinationBlockchainId, route.remoteBlockchainId) &&
        same(e.destinationTokenTransferrerAddress, route.remoteAddress),
      isRouteDelivery: (m) =>
        same(m.sourceBlockchainId, route.homeBlockchainId) &&
        same(m.originSenderAddress, route.tokenHomeAddress) &&
        same(m.destinationAddress, route.remoteAddress),
    },
    route,
    digestOf,
  );
  const r2h = assessDirection(
    {
      direction: 'remote-to-home',
      source: remote,
      destination: home,
      // TokenRemote sends to home single-hop; any other destination is multi-hop.
      isRouteSend: (e) =>
        same(e.destinationBlockchainId, route.homeBlockchainId) &&
        same(e.destinationTokenTransferrerAddress, route.tokenHomeAddress),
      isRouteDelivery: (m) =>
        same(m.sourceBlockchainId, route.remoteBlockchainId) &&
        same(m.originSenderAddress, route.remoteAddress) &&
        same(m.destinationAddress, route.tokenHomeAddress),
    },
    route,
    digestOf,
  );

  const unsupported = [...h2r.unsupported, ...r2h.unsupported];
  // Home-side routed and send-and-call traffic touching this remote.
  for (const f of home.unsupportedSends) {
    if (
      same(f.value.destinationBlockchainId, route.remoteBlockchainId) &&
      same(f.value.destinationTokenTransferrerAddress, route.remoteAddress)
    )
      unsupported.push('home-to-remote:routed-or-send-and-call');
  }
  // Remote-side multi-hop sends and send-and-call.
  for (const f of remote.sent) {
    if (!same(f.value.destinationBlockchainId, route.homeBlockchainId))
      unsupported.push('remote-to-home:multi-hop');
  }
  if (remote.unsupportedSends.length > 0) unsupported.push('remote-to-home:send-and-call');

  return {
    pending: [...h2r.pending, ...r2h.pending],
    effects: [...h2r.effects, ...r2h.effects],
    openEdges: [...h2r.openEdges, ...r2h.openEdges],
    unsupported: [...new Set(unsupported)].sort(),
    messages: [...h2r.messages, ...r2h.messages],
  };
};
