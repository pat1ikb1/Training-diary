import { describe, it, expect } from 'vitest';
import { checkAndUpdatePBs } from '../public/pbs.js';

function makeState() {
    return { personalBests: { track: {}, gym: {} } };
}

describe('checkAndUpdatePBs', () => {
    it('creates a new track PB for a new running split distance', () => {
        const state = makeState();
        const sess = {
            type: 'running',
            date: '2026-04-17',
            running: { splits: [{ distance: 100, time: 12.34 }] },
            hasPB: false,
            pbDetails: []
        };
        checkAndUpdatePBs(sess, state);
        expect(state.personalBests.track['100m']).toBeTruthy();
        expect(state.personalBests.track['100m'].time).toBe(12.34);
        expect(sess.hasPB).toBe(true);
    });

    it('does not overwrite an existing track PB with a slower time', () => {
        const state = makeState();
        state.personalBests.track['100m'] = { time: 11.5, date: '2026-04-01', speed: 100 / 11.5 };
        const sess = {
            type: 'running',
            date: '2026-04-17',
            running: { splits: [{ distance: 100, time: 12.0 }] },
            hasPB: false,
            pbDetails: []
        };
        checkAndUpdatePBs(sess, state);
        expect(state.personalBests.track['100m'].time).toBe(11.5);
        expect(sess.hasPB).toBe(false);
    });

    it('updates gym PB when higher e1RM is achieved', () => {
        const state = makeState();
        state.personalBests.gym.Bench = { e1rm: 100, load: 90, reps: 3, date: '2026-04-01' };
        const sess = {
            type: 'weightlifting',
            date: '2026-04-17',
            lifting: {
                exercises: [{ name: 'Bench', sets: [{ load: 95, reps: 5, type: 'working' }] }]
            },
            hasPB: false,
            pbDetails: []
        };
        checkAndUpdatePBs(sess, state);
        expect(state.personalBests.gym.Bench.e1rm).toBeGreaterThan(100);
        expect(sess.hasPB).toBe(true);
    });

    it('sets hasPB true only when a PB is actually broken', () => {
        const state = makeState();
        state.personalBests.track['200m'] = { time: 24.5, date: '2026-04-01', speed: 200 / 24.5 };

        const slower = {
            type: 'running',
            date: '2026-04-17',
            running: { splits: [{ distance: 200, time: 25.2 }] },
            hasPB: true,
            pbDetails: ['old']
        };
        checkAndUpdatePBs(slower, state);
        expect(slower.hasPB).toBe(false);

        const faster = {
            type: 'running',
            date: '2026-04-18',
            running: { splits: [{ distance: 200, time: 24.1 }] },
            hasPB: false,
            pbDetails: []
        };
        checkAndUpdatePBs(faster, state);
        expect(faster.hasPB).toBe(true);
    });
});
