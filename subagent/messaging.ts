/**
 * Subagent messaging system
 *
 * Allows subagents to send messages to each other and track delivery status.
 * Messages are persisted via pi.appendEntry().
 *
 * Delivery is NOT a read side effect: the persistence hook set by
 * `setMessagePersistHook` fires on every state change (send / mark delivered /
 * mark failed) so delivery status survives session restarts. The actual
 * delivery handshake ("read inbox, then markAsDelivered/markAsFailed") lives in
 * `runSingleAgent` in index.ts.
 */

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface SubagentMessage {
	id: string;
	from: string;
	to: string;
	content: string;
	timestamp: number;
	deliveryStatus: DeliveryStatus;
}

/** In-memory message store for current session */
let messageStore: SubagentMessage[] = [];

/**
 * Optional persistence hook invoked on every message state mutation.
 * Wired up by the extension (index.ts) to `pi.appendEntry("subagent-message", msg)`.
 * Fail-soft: the hook is allowed to throw; callers catch and ignore.
 */
let persistHook: ((msg: SubagentMessage) => void) | null = null;

/** Register (or clear, with null) the message-persistence hook. */
export function setMessagePersistHook(
	hook: ((msg: SubagentMessage) => void) | null,
): void {
	persistHook = hook;
}

/** Persist a message state change via the hook. Never throws. */
function persist(msg: SubagentMessage): void {
	if (!persistHook) return;
	try {
		persistHook(msg);
	} catch {
		/* ignore */
	}
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Send a message from one agent to another
 */
export function sendMessage(
	from: string,
	to: string,
	content: string,
): SubagentMessage {
	const message: SubagentMessage = {
		id: generateMessageId(),
		from,
		to,
		content,
		timestamp: Date.now(),
		deliveryStatus: "pending",
	};

	messageStore.push(message);
	persist(message);
	return message;
}

/**
 * Get messages for a specific agent (as sender or recipient).
 * Auto-marks received messages as delivered when filter is "received" or "all".
 */
export function getMessages(
	agentName: string,
	filter?: "sent" | "received" | "all",
): SubagentMessage[] {
	const filterType = filter ?? "all";

	const messages = messageStore.filter((msg) => {
		if (filterType === "sent") return msg.from === agentName;
		if (filterType === "received") return msg.to === agentName;
		return msg.from === agentName || msg.to === agentName;
	});

	return messages;
}

/**
 * Mark a message as delivered
 */
export function markAsDelivered(messageId: string): SubagentMessage | null {
	const msg = messageStore.find((m) => m.id === messageId);
	if (!msg) return null;

	msg.deliveryStatus = "delivered";
	persist(msg);
	return msg;
}

/**
 * Mark a message as failed
 */
export function markAsFailed(messageId: string): SubagentMessage | null {
	const msg = messageStore.find((m) => m.id === messageId);
	if (!msg) return null;

	msg.deliveryStatus = "failed";
	persist(msg);
	return msg;
}

/**
 * Get all messages in the store
 */
export function getAllMessages(): SubagentMessage[] {
	return [...messageStore];
}

/**
 * Clear all messages (used for testing or session reset)
 */
export function clearMessages(): void {
	messageStore = [];
}

/**
 * Initialize message store with persisted messages
 */
export function initializeMessageStore(messages: SubagentMessage[]): void {
	messageStore = [...messages];
}

/**
 * Get pending messages for a recipient
 */
export function getPendingMessages(recipient: string): SubagentMessage[] {
	return messageStore.filter(
		(msg) => msg.to === recipient && msg.deliveryStatus === "pending",
	);
}
