// =============================================================================
// Omegawave OW-CB2 BLE Communication & Scoring Module
// =============================================================================
// Reverse-engineered BLE protocol for the Omegawave OW-CB2 fitness sensor.
// Handles connection, service discovery, real-time data streaming,
// ADC→mV conversion, DC zone classification, and curve shape analysis.
// =============================================================================

const OW_SERVICE_UUID        = '00001523-1212-efde-1523-785feabcd123';
const OW_ECG_CHAR_UUID       = '00001524-1212-efde-1523-785feabcd123';
const OW_DC_POTENTIAL_UUID   = '00001525-1212-efde-1523-785feabcd123';
const OW_DEVICE_NAME_PREFIX  = 'OW-CB2';

// --- Module state ---
const owState = {
    device: null,
    server: null,
    service: null,
    ecgChar: null,
    dcChar: null,
    connected: false,

    // Callbacks (set by consumer)
    onCNSData: null,       // (samples: number[]) => void — raw ADC values
    onECGData: null,       // (rawBytes: Uint8Array, seqHeader: number) => void
    onDisconnect: null,    // () => void
    onStatusChange: null,  // (status: string) => void

    // Internal tracking
    dcPacketCount: 0,
    ecgPacketCount: 0
};

// ==========================================================================
// PUBLIC API — BLE Connection
// ==========================================================================

/**
 * Connect to an Omegawave OW-CB2 device via Web Bluetooth.
 * Discovers the primary service and subscribes to both characteristics.
 * @returns {Promise<string>} Device name on success
 */
async function connectOmegawave() {
    if (!navigator.bluetooth) {
        throw new Error('Web Bluetooth is not supported. Use Bluefy on iOS or Chrome on desktop.');
    }

    _setStatus('requesting');

    const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: OW_DEVICE_NAME_PREFIX }],
        optionalServices: [OW_SERVICE_UUID]
    });

    owState.device = device;
    device.addEventListener('gattserverdisconnected', _handleDisconnect);

    _setStatus('connecting');
    const server = await device.gatt.connect();
    owState.server = server;

    _setStatus('discovering');
    const service = await server.getPrimaryService(OW_SERVICE_UUID);
    owState.service = service;

    // Subscribe to DC Potential (CNS) characteristic
    _setStatus('subscribing-cns');
    const dcChar = await service.getCharacteristic(OW_DC_POTENTIAL_UUID);
    owState.dcChar = dcChar;
    dcChar.addEventListener('characteristicvaluechanged', _handleDCPotentialData);
    await dcChar.startNotifications();

    // Subscribe to ECG characteristic
    _setStatus('subscribing-ecg');
    const ecgChar = await service.getCharacteristic(OW_ECG_CHAR_UUID);
    owState.ecgChar = ecgChar;
    ecgChar.addEventListener('characteristicvaluechanged', _handleECGData);
    await ecgChar.startNotifications();

    owState.connected = true;
    owState.dcPacketCount = 0;
    owState.ecgPacketCount = 0;
    _setStatus('streaming');

    return device.name || OW_DEVICE_NAME_PREFIX;
}

/**
 * Disconnect from the Omegawave device and clean up.
 */
async function disconnectOmegawave() {
    owState.connected = false;

    if (owState.dcChar) {
        try {
            owState.dcChar.removeEventListener('characteristicvaluechanged', _handleDCPotentialData);
            await owState.dcChar.stopNotifications();
        } catch (e) { /* ignore */ }
        owState.dcChar = null;
    }

    if (owState.ecgChar) {
        try {
            owState.ecgChar.removeEventListener('characteristicvaluechanged', _handleECGData);
            await owState.ecgChar.stopNotifications();
        } catch (e) { /* ignore */ }
        owState.ecgChar = null;
    }

    if (owState.device && owState.device.gatt && owState.device.gatt.connected) {
        owState.device.gatt.disconnect();
    }

    owState.device = null;
    owState.server = null;
    owState.service = null;

    _setStatus('disconnected');
}

/**
 * Check if currently connected to an OW-CB2 device.
 */
function isOmegawaveConnected() {
    return owState.connected && owState.device && owState.device.gatt.connected;
}

// ==========================================================================
// PACKET DECODERS
// ==========================================================================

/**
 * Decode a DC Potential (CNS) packet.
 * 20 bytes total:
 *   - Byte 0: sequence number
 *   - Byte 1: status byte (log, ignore)
 *   - Bytes 2–19: nine 16-bit big-endian integers (raw CNS voltage at 10Hz)
 *
 * @param {DataView} dataView
 * @returns {{ seq: number, status: number, samples: number[] }}
 */
function decodeDCPotentialPacket(dataView) {
    const seq = dataView.getUint8(0);
    const status = dataView.getUint8(1);
    const samples = [];

    // 9 samples × 2 bytes each = 18 bytes, starting at offset 2
    for (let i = 0; i < 9; i++) {
        const offset = 2 + (i * 2);
        if (offset + 1 < dataView.byteLength) {
            samples.push(dataView.getUint16(offset, false)); // big-endian
        }
    }

    return { seq, status, samples };
}

/**
 * Decode an ECG packet (PLACEHOLDER).
 * 20 bytes at 500Hz. Delta-encoding format not yet confirmed.
 *
 * @param {DataView} dataView
 * @returns {{ seqHeader: number, rawBytes: Uint8Array }}
 */
function decodeECGPacket(dataView) {
    const seqHeader = dataView.getUint16(0, false);
    const rawBytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

    if (owState.ecgPacketCount < 20) {
        const hexStr = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log(`[OW-ECG] Packet #${owState.ecgPacketCount} (seq=${seqHeader}): ${hexStr}`);
    }

    return { seqHeader, rawBytes: new Uint8Array(rawBytes) };
}

// ==========================================================================
// CONVERSION & SCORING FUNCTIONS
// ==========================================================================

/**
 * Convert raw ADC value to millivolts.
 * Approximate linear calibration — adjust later with real device data.
 */
function adcToMv(adc) {
    return (adc - 512) * 0.1;
}

/**
 * Compute the median of an array of numbers.
 */
function medianOfArray(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Standard deviation of an array.
 */
function stdDev(arr) {
    if (!arr || arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sqDiffs = arr.map(v => (v - mean) ** 2);
    return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (arr.length - 1));
}

/**
 * Convert 0–100 readiness score to 1–7 Stress Resilience scale.
 */
function toStressResilience(score0to100) {
    return Math.max(1, Math.min(7, Math.ceil(score0to100 / 100 * 7)));
}

/**
 * Get Stress Resilience label for 1–7 score.
 */
function stressResilienceLabel(sr) {
    if (sr >= 6) return 'Strong';
    if (sr >= 5) return 'Steady';
    if (sr >= 4) return 'Moderate';
    if (sr >= 3) return 'Developing';
    if (sr >= 2) return 'Reduced';
    return 'Low';
}

/**
 * Parasympathetic index: 0–1 derived from RMSSD and Stress Index.
 */
function calcParasympathetic(rmssd, stressIndex) {
    const denominator = rmssd + stressIndex * 10;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(1, rmssd / denominator));
}

/**
 * Sympathetic index: 0–1 derived from Stress Index.
 */
function calcSympathetic(stressIndex) {
    return Math.max(0, Math.min(1, stressIndex / 150));
}

/**
 * Cardiac stress: 1–7 where 7 = low stress (best).
 */
function calcCardiacStress(stressIndex) {
    return Math.max(1, Math.min(7, 7 - Math.round(stressIndex / 30)));
}

/**
 * Get parasympathetic label.
 */
function parasympatheticLabel(val) {
    if (val >= 0.5) return 'Optimal';
    if (val >= 0.25) return 'Reduced';
    return 'Low';
}

/**
 * Get sympathetic label.
 */
function sympatheticLabel(val) {
    if (val <= 0.4) return 'Optimal';
    if (val <= 0.7) return 'Elevated';
    return 'High';
}

/**
 * Get cardiac stress label (1–7).
 */
function cardiacStressLabel(val) {
    if (val >= 6) return 'Excellent';
    if (val >= 5) return 'Good';
    if (val >= 4) return 'Moderate';
    if (val >= 3) return 'Fair';
    return 'Poor';
}

/**
 * Heart Balance label based on cardiac stress score.
 */
function heartBalanceLabel(cardiacStress) {
    if (cardiacStress >= 5) return 'Balanced';
    if (cardiacStress >= 3) return 'Reduced';
    return 'Recovery Needed';
}

/**
 * Classify DC Potential zone from mV value (Omegawave scale).
 * Returns { grade: number(1-7), label: string }
 */
function classifyDCZone(dcMv) {
    if (dcMv < 0)       return { grade: 4, label: 'Below normal' };
    if (dcMv < 9)       return { grade: 5, label: 'Approaching normal' };
    if (dcMv < 20)      return { grade: 6, label: 'Good' };
    if (dcMv < 34)      return { grade: 7, label: 'Optimal' };
    if (dcMv < 44)      return { grade: 6, label: 'Good' };
    if (dcMv < 51)      return { grade: 5, label: 'Elevated' };
    if (dcMv < 56)      return { grade: 4, label: 'High tension' };
    return               { grade: 2, label: 'Emotional tension/stress' };
}

/**
 * Mind Balance label based on DC zone grade.
 */
function mindBalanceLabel(dcGrade) {
    if (dcGrade >= 6) return 'Balanced';
    if (dcGrade >= 4) return 'Reduced';
    return 'Recovery Needed';
}

/**
 * Classify the DC potential curve shape.
 * Expects an array of mV values sampled at 10Hz over 3 minutes.
 *
 * @param {number[]} mvSamples — array of mV values
 * @returns {{ shape: string, description: string }}
 */
function classifyCurve(mvSamples) {
    if (!mvSamples || mvSamples.length < 60) {
        return { shape: 'Insufficient Data', description: 'Not enough data to classify the curve shape.' };
    }

    const n = mvSamples.length;
    const firstQuarter = mvSamples.slice(0, Math.floor(n / 4));
    const lastMinute = mvSamples.slice(-600); // last 60s at 10Hz
    const lastMinuteActual = lastMinute.length > 0 ? lastMinute : mvSamples.slice(-Math.floor(n / 3));

    const initialMean = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
    const stabilizationMean = lastMinuteActual.reduce((a, b) => a + b, 0) / lastMinuteActual.length;
    const stabilizationStd = stdDev(lastMinuteActual);
    const overallRange = Math.max(...mvSamples) - Math.min(...mvSamples);
    const descends = initialMean > stabilizationMean + 2;

    // Flat: amplitude change < 3 mV across full curve
    if (overallRange < 3) {
        return {
            shape: 'Flat Stabilization',
            description: 'The DC potential remained nearly constant throughout the measurement. This may indicate a rigid autonomic response or sensor placement issues. Ensure proper electrode contact and hydration.'
        };
    }

    // Inverted: curve rises instead of falling
    if (stabilizationMean > initialMean + 3) {
        return {
            shape: 'Inverted Stabilization',
            description: 'The DC potential rose during the measurement instead of the expected descent. This pattern may indicate heightened CNS activation, emotional stress, or an inverted autonomic response. Consider rest and stress management.'
        };
    }

    // No stabilization: std dev > 5 mV in last 60s
    if (stabilizationStd > 5) {
        return {
            shape: 'No Stabilization',
            description: 'The DC potential did not stabilize during the measurement. High variability in the final phase suggests ongoing CNS instability. Possible causes include incomplete relaxation, external stimuli, or high nervous system load.'
        };
    }

    // High stabilization: stabilized above 44 mV
    if (stabilizationMean > 44) {
        return {
            shape: 'High Stabilization',
            description: 'The DC potential stabilized at an elevated level (above 44 mV). This indicates heightened CNS tension. While short-term elevation can reflect readiness, persistent high values suggest accumulated stress. Monitor for recovery.'
        };
    }

    // Low stabilization: stabilized below 9 mV
    if (stabilizationMean < 9) {
        return {
            shape: 'Low Stabilization',
            description: 'The DC potential stabilized at a low level (below 9 mV). This suggests reduced CNS activation, which can indicate fatigue, overtraining, or depleted nervous system resources. Prioritize recovery and sleep quality.'
        };
    }

    // Optimal: descends and stabilizes within normal range
    if (descends && stabilizationStd <= 5) {
        return {
            shape: 'Optimal Stabilization',
            description: 'The DC potential descended and stabilized within the optimal range. This is the ideal pattern, indicating healthy CNS regulation, good stress resilience, and readiness for training. Your nervous system is balanced and responsive.'
        };
    }

    // Default fallback
    return {
        shape: 'Moderate Stabilization',
        description: 'The DC potential showed partial stabilization. The pattern suggests adequate but not optimal CNS regulation. Continue monitoring and ensure adequate recovery between training sessions.'
    };
}

/**
 * Compute Windows of Trainability scores (1–4) for four physical qualities.
 * Based on composite of cardiac stress, parasympathetic index, and CNS grade.
 */
function calcTrainabilityWindows(cardiacStress, parasympathetic, dcGrade) {
    // Base readiness from 0–1 (average of normalized inputs)
    const cardNorm = (cardiacStress - 1) / 6;   // 1-7 → 0-1
    const paraNorm = parasympathetic;             // already 0-1
    const cnsNorm = (dcGrade - 1) / 6;           // 1-7 → 0-1
    const base = (cardNorm + paraNorm + cnsNorm) / 3;

    // Each quality gets base score with slight variation
    const clamp = v => Math.max(1, Math.min(4, Math.round(v)));
    return {
        endurance:    clamp(base * 4 + 0.5),
        speedPower:   clamp(base * 4 - 0.2),
        strength:     clamp(base * 4 - 0.1),
        coordination: clamp(base * 4 - 0.3)
    };
}

/**
 * Get time-of-day greeting.
 */
function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
}

// ==========================================================================
// INFO TEXT — plain-English metric explanations (from Omegawave app)
// ==========================================================================

const OW_INFO = {
    stressResilience: {
        title: 'Stress Resilience',
        text: 'Stress Resilience reflects your body\'s overall capacity to handle physical and mental stress. It combines cardiac autonomic balance and central nervous system readiness into a single 1–7 score. Higher scores indicate greater resilience and readiness to take on training loads.'
    },
    heartBalance: {
        title: 'Heart Balance',
        text: 'Heart Balance assesses cardiac autonomic regulation by analyzing the balance between your sympathetic (fight-or-flight) and parasympathetic (rest-and-recover) nervous systems. A balanced state indicates your heart is well-regulated and ready for training.'
    },
    mindBalance: {
        title: 'Mind Balance',
        text: 'Mind Balance evaluates your central nervous system (CNS) readiness by measuring the brain\'s DC potential. This biomarker reflects the energy state of your neural tissue and your capacity for focused, coordinated effort.'
    },
    parasympathetic: {
        title: 'Parasympathetic Activity',
        text: 'The parasympathetic index measures the activity of your rest-and-recover nervous system. Higher values indicate better recovery and relaxation capacity. Optimal levels suggest your body has recovered from previous stress and is ready for new challenges.'
    },
    sympathetic: {
        title: 'Sympathetic Activity',
        text: 'The sympathetic index measures the activity of your fight-or-flight nervous system. Lower values indicate a more relaxed state. Elevated levels may suggest ongoing stress, incomplete recovery, or heightened arousal that could impact training quality.'
    },
    cardiacStress: {
        title: 'Cardiac Stress',
        text: 'Cardiac Stress is derived from the Stress Index (Baevsky\'s SI), which measures the degree of centralization of heart rate regulation. A score of 7 indicates minimal cardiac stress, while lower scores suggest increasing sympathetic dominance and stress on the cardiovascular system.'
    },
    restingHR: {
        title: 'Resting Heart Rate',
        text: 'Your heart rate at rest, measured during the assessment. A lower resting heart rate generally indicates better cardiovascular fitness. Significant day-to-day elevations may signal fatigue, illness, or incomplete recovery.'
    },
    sdnn: {
        title: 'SDNN (Standard Deviation of NN Intervals)',
        text: 'SDNN represents the standard deviation of all normal RR intervals in the recording. It reflects overall heart rate variability and is influenced by both sympathetic and parasympathetic activity. Higher values generally indicate better cardiovascular health and recovery.'
    },
    rmssd: {
        title: 'RMSSD (Root Mean Square of Successive Differences)',
        text: 'RMSSD measures the root mean square of successive differences between heartbeats. It primarily reflects parasympathetic (vagal) activity and short-term HRV. Higher values indicate greater parasympathetic tone and better recovery status.'
    },
    sdsd: {
        title: 'SDSD (Standard Deviation of Successive Differences)',
        text: 'SDSD is the standard deviation of successive RR interval differences. For successive differences, SDSD and RMSSD are mathematically equivalent. This metric provides insight into beat-to-beat variability driven by vagal activity.'
    },
    lfPower: {
        title: 'LF Power (Low Frequency)',
        text: 'Low Frequency power (0.04–0.15 Hz) reflects both sympathetic and parasympathetic influences on heart rate, as well as baroreflex activity. It is often associated with blood pressure regulation and mixed autonomic control.'
    },
    hfPower: {
        title: 'HF Power (High Frequency)',
        text: 'High Frequency power (0.15–0.4 Hz) is primarily driven by parasympathetic (vagal) activity and respiratory sinus arrhythmia. Higher HF power indicates stronger vagal tone and better recovery capacity.'
    },
    lfHfRatio: {
        title: 'LF/HF Ratio',
        text: 'The ratio of Low Frequency to High Frequency power provides a rough estimate of sympathovagal balance. A higher ratio suggests relative sympathetic dominance, while a lower ratio suggests parasympathetic dominance.'
    },
    totalPower: {
        title: 'Total Power',
        text: 'Total Power represents the overall variance (energy) in the heart rate signal across all frequency bands. It reflects the total regulatory capacity of the autonomic nervous system. Higher total power generally indicates better overall autonomic function.'
    },
    dcPotential: {
        title: 'DC Potential',
        text: 'The DC (direct current) potential of the brain is a measure of the steady-state electrical potential across neural tissue. It reflects the metabolic and energetic state of the central nervous system. Values in the 20–34 mV range indicate optimal CNS readiness.'
    },
    curveShape: {
        title: 'Curve Shape Analysis',
        text: 'The shape of the DC potential curve during measurement reveals how your CNS responds to and stabilizes from the measurement stimulus. The ideal pattern shows an initial descent followed by stabilization within the optimal range, indicating healthy neurological regulation.'
    },
    trainability: {
        title: 'Windows of Trainability',
        text: 'Windows of Trainability identifies the optimal window to train each physical quality, based on your body\'s current functional state. Scores range from 1 (not recommended) to 4 (highly trainable). Use these to prioritize training focuses for maximum adaptation.'
    }
};

// ==========================================================================
// INTERNAL BLE HANDLERS
// ==========================================================================

function _handleDCPotentialData(event) {
    if (!owState.connected) return;
    const dataView = event.target.value;
    owState.dcPacketCount++;
    try {
        const { seq, status, samples } = decodeDCPotentialPacket(dataView);
        if (owState.onCNSData) owState.onCNSData(samples);
    } catch (e) {
        console.error('[OW-CNS] Decode error:', e);
    }
}

function _handleECGData(event) {
    if (!owState.connected) return;
    const dataView = event.target.value;
    owState.ecgPacketCount++;
    try {
        const { seqHeader, rawBytes } = decodeECGPacket(dataView);
        if (owState.onECGData) owState.onECGData(rawBytes, seqHeader);
    } catch (e) {
        console.error('[OW-ECG] Decode error:', e);
    }
}

function _handleDisconnect() {
    const wasConnected = owState.connected;
    owState.connected = false;
    owState.dcChar = null;
    owState.ecgChar = null;
    owState.service = null;
    owState.server = null;
    if (wasConnected) {
        _setStatus('disconnected');
        if (owState.onDisconnect) owState.onDisconnect();
    }
}

function _setStatus(status) {
    if (owState.onStatusChange) owState.onStatusChange(status);
}

// ==========================================================================
// EXPORT — global window.OW
// ==========================================================================

window.OW = {
    // BLE
    connectOmegawave,
    disconnectOmegawave,
    isOmegawaveConnected,
    state: owState,

    // Decoders
    decodeDCPotentialPacket,
    decodeECGPacket,

    // Conversions & Scoring
    adcToMv,
    medianOfArray,
    stdDev,
    toStressResilience,
    stressResilienceLabel,
    calcParasympathetic,
    calcSympathetic,
    calcCardiacStress,
    parasympatheticLabel,
    sympatheticLabel,
    cardiacStressLabel,
    heartBalanceLabel,
    classifyDCZone,
    mindBalanceLabel,
    classifyCurve,
    calcTrainabilityWindows,
    getGreeting,

    // Info text
    INFO: OW_INFO,

    // Constants
    SERVICE_UUID: OW_SERVICE_UUID,
    ECG_CHAR_UUID: OW_ECG_CHAR_UUID,
    DC_POTENTIAL_UUID: OW_DC_POTENTIAL_UUID,
    DEVICE_NAME_PREFIX: OW_DEVICE_NAME_PREFIX
};
