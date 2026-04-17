export function filterRR(rawArr) {
    let filtered = [];
    let rejects = 0;
    for (let i = 0; i < rawArr.length; i++) {
        let rr = rawArr[i];
        if (rr >= 300 && rr <= 2000) {
            if (filtered.length === 0) {
                filtered.push(rr);
            } else {
                let prev = filtered[filtered.length - 1];
                let diffPerc = Math.abs(rr - prev) / prev;
                if (diffPerc <= 0.20) {
                    filtered.push(rr);
                    rejects = 0;
                } else {
                    rejects++;
                    if (rejects >= 2) {
                        filtered.push(rr);
                        rejects = 0;
                    }
                }
            }
        }
    }
    return filtered;
}

export function computeHRV(rrArray) {
    const n = rrArray.length;
    if (n < 2) return null;

    let totalRR = 0, sumSqDiff = 0, pnn50Count = 0;
    for (let i = 0; i < n; i++) totalRR += rrArray[i];
    for (let i = 1; i < n; i++) {
        let diff = Math.abs(rrArray[i] - rrArray[i - 1]);
        sumSqDiff += diff * diff;
        if (diff > 50) pnn50Count++;
    }

    let meanRR = totalRR / n;
    let meanHR = 60000 / meanRR;
    let rmssd = Math.sqrt(sumSqDiff / (n - 1));
    let pnn50 = (pnn50Count / (n - 1)) * 100;

    let sumSqDrr = 0;
    for (let i = 0; i < n; i++) sumSqDrr += Math.pow(rrArray[i] - meanRR, 2);
    let sdnn = Math.sqrt(sumSqDrr / (n - 1));

    let bins = {};
    let maxRR = -Infinity;
    let minRR = Infinity;
    rrArray.forEach(rr => {
        let binIdx = Math.floor(rr / 50) * 50;
        bins[binIdx] = (bins[binIdx] || 0) + 1;
        if (rr > maxRR) maxRR = rr;
        if (rr < minRR) minRR = rr;
    });

    let maxBinCount = 0;
    let modeBinIdx = 0;
    for (let bin in bins) {
        if (bins[bin] > maxBinCount) {
            maxBinCount = bins[bin];
            modeBinIdx = parseInt(bin, 10);
        }
    }

    let mo = (modeBinIdx + 25) / 1000;
    let amo = (maxBinCount / n) * 100;
    let mxdmn = (maxRR - minRR) / 1000;
    let si = 0;
    if (mxdmn > 0 && mo > 0) si = amo / (2 * mo * mxdmn);

    return { rmssd, sdnn, pnn50, meanHR, stressIndex: si, rrCount: n };
}

export function calcReadiness(rmssd, measurements = []) {
    let baselineWindow = measurements.slice(-29, -1);
    if (baselineWindow.length === 0) return 50;
    let baseline = baselineWindow.reduce((sum, m) => sum + Number(m.rmssd || 0), 0) / baselineWindow.length;
    if (!baseline || baseline <= 0) return 50;
    let confidenceFactor = Math.min(1, baselineWindow.length / 7);
    let raw = (rmssd / baseline) * 70;
    let score = raw * confidenceFactor + (50 * (1 - confidenceFactor));
    return Math.max(0, Math.min(100, Math.round(score)));
}
