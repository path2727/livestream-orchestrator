import { WebhookEvent } from 'livekit-server-sdk';

type Room = {
    name: string;
    participants: Set<string>;
};

const rooms = new Map<string, Room>();

export const mockLiveKit = {
    reset() {
        rooms.clear();
    },

    createRoom(name: string) {
        if (rooms.has(name)) {
            throw new Error('room already exists');
        }
        rooms.set(name, { name, participants: new Set() });
    },

    listRooms(names?: string[]) {
        if (!names) return Array.from(rooms.values());
        return names.flatMap(n => (rooms.has(n) ? [rooms.get(n)!] : []));
    },

    deleteRoom(name: string) {
        rooms.delete(name);
    },

    participantJoin(room: string, identity: string): WebhookEvent {
        rooms.get(room)?.participants.add(identity);

        return {
            event: 'participant_joined',
            room: { name: room },
            participant: { identity },
        } as WebhookEvent;
    },

    participantLeave(room: string, identity: string): WebhookEvent {
        rooms.get(room)?.participants.delete(identity);

        return {
            event: 'participant_left',
            room: { name: room },
            participant: { identity },
        } as WebhookEvent;
    },

    roomFinished(room: string): WebhookEvent {
        return {
            event: 'room_finished',
            room: { name: room },
        } as WebhookEvent;
    },

    // Simple validation: Just parse, no auth throw (for reliable tests)
    validateWebhook(body: string): WebhookEvent {
        console.log("body: " + body);
        try {
            return JSON.parse(body) as WebhookEvent;
        } catch (err) {
            console.error("error", err);
            throw new Error('Invalid webhook body');
        }
    },
};