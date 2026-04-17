function formatSecondsMetric(secs) {
    const n = Number(secs);
    if (!Number.isFinite(n) || n <= 0) return '0.00 s';
    return `${n.toFixed(2)} s`;
}

export function checkAndUpdatePBs(sess, appState) {
    if (!sess || !appState) return false;
    if (!appState.personalBests) appState.personalBests = { track: {}, gym: {} };
    if (!appState.personalBests.track) appState.personalBests.track = {};
    if (!appState.personalBests.gym) appState.personalBests.gym = {};

    sess.hasPB = false;
    if (!Array.isArray(sess.pbDetails)) sess.pbDetails = [];
    else sess.pbDetails = [];

    if (sess.type === 'running' && sess.running) {
        let checkDist = (distM, t) => {
            if (distM <= 0 || t <= 0) return;
            let k = null;
            [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000, 1500, 3000, 5000, 10000].forEach(d => {
                if (Math.abs(distM - d) < (d * 0.02)) k = `${d}m`;
            });
            if (Math.abs(distM - 1609) < 30) k = '1 Mile';
            if (!k) k = `${Math.round(distM)}m`;

            let existing = appState.personalBests.track[k];
            if (!existing || t < existing.time) {
                appState.personalBests.track[k] = { time: t, date: sess.date, speed: distM / t };
                sess.hasPB = true;
                sess.pbDetails.push(`${k} in ${formatSecondsMetric(t)}`);
            }
        };
        (sess.running.splits || []).forEach(s => checkDist(s.distance, s.time));
    }

    if (sess.type === 'weightlifting' && sess.lifting) {
        (sess.lifting.exercises || []).forEach(ex => {
            (ex.sets || []).forEach(s => {
                if (s.load > 0 && s.reps > 0 && s.type !== 'warmup') {
                    let e1rm = s.load * (1 + s.reps / 30);
                    let k = ex.name;
                    let existing = appState.personalBests.gym[k];
                    if (!existing || Object.keys(existing).length === 0) {
                        appState.personalBests.gym[k] = { e1rm, load: s.load, reps: s.reps, date: sess.date, peak: s.peakPower };
                        sess.hasPB = true;
                        sess.pbDetails.push(`${k} e1RM: ${Math.round(e1rm)}kg`);
                    } else {
                        if (e1rm > existing.e1rm) {
                            existing.e1rm = e1rm;
                            existing.date = sess.date;
                            existing.load = s.load;
                            existing.reps = s.reps;
                            sess.hasPB = true;
                        }
                        if (s.load > existing.load) {
                            existing.load = s.load;
                            existing.reps = s.reps;
                        }
                        if (s.peakPower && (!existing.peak || s.peakPower > existing.peak)) {
                            existing.peak = s.peakPower;
                        }
                    }
                }
            });
        });
    }

    return sess.hasPB === true;
}
