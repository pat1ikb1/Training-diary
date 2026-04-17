import { describe, it, expect } from 'vitest';
import { filterRR, computeHRV, calcReadiness } from '../public/hrv.js';

describe('filterRR', () => {
    it('returns empty array for empty input', () => {
        expect(filterRR([])).toEqual([]);
    });

    it('filters out values below 300ms and above 2000ms', () => {
        expect(filterRR([250, 700, 710, 2100, 720])).toEqual([700, 710, 720]);
    });

    it('rejects >20% changes but resets baseline after 2 consecutive rejects', () => {
        expect(filterRR([1000, 1300, 1400, 1380])).toEqual([1000, 1400, 1380]);
    });

    it('passes a clean physiological array unchanged', () => {
        const arr = [800, 810, 790, 805, 815];
        expect(filterRR(arr)).toEqual(arr);
    });
});

describe('computeHRV', () => {
    it('returns null for arrays with fewer than 2 values', () => {
        expect(computeHRV([])).toBeNull();
        expect(computeHRV([800])).toBeNull();
    });

    it('returns correct RMSSD for known array', () => {
        const result = computeHRV([800, 820, 790, 810]);
        const expected = Math.sqrt((400 + 900 + 400) / 3);
        expect(result.rmssd).toBeCloseTo(expected, 10);
    });

    it('returns correct meanHR (60000 / meanRR)', () => {
        const result = computeHRV([800, 820, 790, 810]);
        expect(result.meanHR).toBeCloseTo(60000 / 805, 10);
    });

    it('returns pnn50 of 0 when no consecutive differences exceed 50ms', () => {
        const result = computeHRV([800, 820, 790, 810]);
        expect(result.pnn50).toBe(0);
    });

    it('returns stressIndex > 0 for a valid array', () => {
        const result = computeHRV([800, 820, 790, 810, 805, 815, 800]);
        expect(result.stressIndex).toBeGreaterThan(0);
    });
});

describe('calcReadiness', () => {
    it('returns 50 when no baseline measurements exist', () => {
        expect(calcReadiness(40, [])).toBe(50);
    });

    it('returns a value between 0 and 100 for valid input', () => {
        const measurements = Array.from({ length: 30 }, (_, i) => ({ rmssd: i === 29 ? 999 : 50 }));
        const score = calcReadiness(65, measurements);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
    });

    it('excludes today (latest) measurement from baseline window', () => {
        const withTodayOutlier = Array.from({ length: 30 }, (_, i) => ({ rmssd: i === 29 ? 500 : 50 }));
        const withoutTodayOutlier = Array.from({ length: 30 }, () => ({ rmssd: 50 }));
        const scoreWithOutlierToday = calcReadiness(60, withTodayOutlier);
        const scoreWithoutOutlierToday = calcReadiness(60, withoutTodayOutlier);
        expect(scoreWithOutlierToday).toBe(scoreWithoutOutlierToday);
    });

    it('returns a higher score when rmssd is above baseline', () => {
        const measurements = Array.from({ length: 30 }, (_, i) => ({ rmssd: i === 29 ? 999 : 50 }));
        const low = calcReadiness(40, measurements);
        const high = calcReadiness(70, measurements);
        expect(high).toBeGreaterThan(low);
    });

    it('returns a lower score when rmssd is below baseline', () => {
        const measurements = Array.from({ length: 30 }, (_, i) => ({ rmssd: i === 29 ? 999 : 50 }));
        const high = calcReadiness(70, measurements);
        const low = calcReadiness(30, measurements);
        expect(low).toBeLessThan(high);
    });
});
