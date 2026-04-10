    // --- SUPABASE CLIENT ---
    // Runtime config expected from hosting shell (e.g. set in a small config script before app.js).
    const SUPABASE_URL = window.__SUPABASE_URL__ || 'https://lkbexgqclzodqllfemix.supabase.co';
    const SUPABASE_KEY = window.__SUPABASE_ANON_KEY__ || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxrYmV4Z3FjbHpvZHFsbGZlbWl4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NjE3NjEsImV4cCI6MjA5MTMzNzc2MX0.LikIfvtMf-XlU9SAb1j-uBpKxn93p724AIoqfnG9B-E';
    let sbClient = null;
    try {
        const { createClient } = window.supabase;
        if (SUPABASE_URL && SUPABASE_KEY) {
            sbClient = createClient(SUPABASE_URL, SUPABASE_KEY);
        } else {
            console.warn('Supabase config missing. Set window.__SUPABASE_URL__ and window.__SUPABASE_ANON_KEY__.');
        }
    } catch(e) {
        console.warn('Supabase init failed:', e);
    }
    // Provide a stub so calls don't crash if init failed
    if(!sbClient) {
        sbClient = {
            auth: {
                getSession: async () => ({ data: { session: null } }),
                signUp: async () => ({ error: { message: 'Supabase not available' } }),
                signInWithPassword: async () => ({ error: { message: 'Supabase not available' } }),
                signOut: async () => {}
            },
            from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: null }), single: async () => ({ data: null }) }) }), upsert: async () => ({}) })
        };
    }
    let currentUser = null;

    // --- STATE ---
    let appState = {
        measurements: JSON.parse(localStorage.getItem('omegahrv_measurements')) || [],
        settings: JSON.parse(localStorage.getItem('omegahrv_settings')) || { name: '', age: '', initDuration: '60', duration: '180', lightMode: false },
        onboarded: localStorage.getItem('omegahrv_onboarded') === 'true',
        sessions: JSON.parse(localStorage.getItem('omegahrv_sessions')) || [],
        personalBests: JSON.parse(localStorage.getItem('omegahrv_pbs')) || { track: {}, gym: {} }
    };

    const qs = (sel, ctx=document) => ctx.querySelector(sel);
    const qsa = (sel, ctx=document) => [...ctx.querySelectorAll(sel)];

    let toastTimer = null;
    function showToast(message, level = 'success') {
        const safeLevel = ['success', 'warning', 'danger'].includes(level) ? level : 'success';
        const safeMessage = String(message ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 240);
        let toast = document.getElementById('app-toast');
        if (!toast) return;
        toast.className = `banner toast-${safeLevel}`;
        toast.textContent = safeMessage;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function showConfirm(message, options = {}) {
        const title = String(options.title || 'Confirm action');
        const confirmText = String(options.confirmText || 'Confirm');
        const cancelText = String(options.cancelText || 'Cancel');
        const messageText = String(message || '');
        return new Promise((resolve) => {
            const modal = document.getElementById('modal-confirm');
            const titleEl = document.getElementById('confirm-title');
            const msgEl = document.getElementById('confirm-message');
            const okBtn = document.getElementById('confirm-ok-btn');
            const cancelBtn = document.getElementById('confirm-cancel-btn');
            if (!modal || !titleEl || !msgEl || !okBtn || !cancelBtn) return resolve(false);
            titleEl.textContent = title;
            msgEl.textContent = messageText;
            okBtn.textContent = confirmText;
            cancelBtn.textContent = cancelText;
            modal.classList.add('active');

            const close = (result) => {
                modal.classList.remove('active');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                resolve(result);
            };
            const onOk = () => close(true);
            const onCancel = () => close(false);
            okBtn.addEventListener('click', onOk, { once: true });
            cancelBtn.addEventListener('click', onCancel, { once: true });
        });
    }

    function destroyChartSafe(chartRefName) {
        if (chartRefName && typeof chartRefName.destroy === 'function') {
            try { chartRefName.destroy(); } catch (e) { console.warn('Chart destroy failed', e); }
        }
    }

    function stableHash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
        return Math.abs(hash >>> 0).toString(16);
    }

    function fallbackEntityId(item, prefix = 'legacy') {
        const raw = [
            item?.date || '',
            item?.time || '',
            item?.title || '',
            item?.type || '',
            item?.rmssd || '',
            item?.meanHR || '',
            item?.pnn50 || '',
            item?.rrCount || '',
            item?.updatedAt || item?.updated_at || ''
        ].join('|');
        return `${prefix}-${stableHash(raw)}`;
    }

    function fallbackMeasurementId(m) {
        return m.id || fallbackEntityId(m, 'measurement');
    }

    function sessionIdValue(s) {
        if (s.id) return s.id;
        if (s._stableId) return s._stableId;
        s._stableId = fallbackEntityId(s, 'session');
        return s._stableId;
    }
    
    function toggleSidebar() {
        document.getElementById('sidebar').classList.toggle('open');
    }

    let bleState = {
        device: null,
        characteristic: null,
        running: false,
        phase: 'stopped',
        timerInterval: null,
        timeLeft: 0,
        initialisationRR: [],
        rawRRs: [],
        currentHR: 0,
        lastResult: null
    };

    let chartSpark = null;
    let chartHistory = null;

    // --- SYNC STATUS UI ---
    function setSyncStatus(state, label) {
        let el = document.getElementById('sync-status');
        if(!el) return;
        el.style.display = 'flex';
        el.className = 'sync-indicator ' + state;
        document.getElementById('sync-label').textContent = label || state;
    }

    // --- AUTH LOGIC ---
    let authMode = 'signin'; // 'signin' or 'signup'

    function toggleAuthMode() {
        authMode = authMode === 'signin' ? 'signup' : 'signin';
        document.getElementById('auth-title').textContent = authMode === 'signin' ? 'Sign In' : 'Create Account';
        document.getElementById('auth-submit-btn').textContent = authMode === 'signin' ? 'Sign In' : 'Sign Up';
        document.getElementById('auth-toggle').innerHTML = authMode === 'signin'
            ? "Don't have an account? <span>Sign Up</span>"
            : "Already have an account? <span>Sign In</span>";
        document.getElementById('auth-error').textContent = '';
    }

    async function handleAuth() {
        let email = document.getElementById('auth-email').value.trim();
        let password = document.getElementById('auth-password').value;
        let errEl = document.getElementById('auth-error');
        errEl.textContent = '';

        if(!email || !password) { errEl.textContent = 'Please enter email and password.'; return; }
        if(password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

        document.getElementById('auth-submit-btn').disabled = true;
        document.getElementById('auth-submit-btn').textContent = 'Loading...';

        try {
            let result;
            if(authMode === 'signup') {
                result = await sbClient.auth.signUp({ email, password });
            } else {
                result = await sbClient.auth.signInWithPassword({ email, password });
            }

            if(result.error) throw result.error;

            if(authMode === 'signup' && result.data.user && !result.data.session) {
                errEl.style.color = 'var(--success)';
                errEl.textContent = 'Check your email to confirm your account.';
                document.getElementById('auth-submit-btn').disabled = false;
                document.getElementById('auth-submit-btn').textContent = authMode === 'signin' ? 'Sign In' : 'Sign Up';
                return;
            }

            currentUser = result.data.user;
            document.getElementById('modal-auth').classList.remove('active');
            await onAuthSuccess();
        } catch(e) {
            errEl.textContent = e.message || 'Authentication failed.';
        }
        document.getElementById('auth-submit-btn').disabled = false;
        document.getElementById('auth-submit-btn').textContent = authMode === 'signin' ? 'Sign In' : 'Sign Up';
    }

    async function logOut() {
        await sbClient.auth.signOut();
        currentUser = null;
        setSyncStatus('offline', 'Logged out');
        document.getElementById('modal-auth').classList.add('active');
    }

    async function requestLogOut() {
        const confirmed = await showConfirm('Log out now? You will need to sign in again to sync data.', { title: 'Log out', confirmText: 'Log out' });
        if (confirmed) await logOut();
    }

    async function onAuthSuccess() {
        setSyncStatus('syncing', 'Syncing...');
        try {
            await syncDown();
            setSyncStatus('synced', 'Synced');
        } catch(e) {
            console.error('Sync down failed:', e);
            setSyncStatus('error', 'Sync error');
        }

        if (!appState.onboarded) {
            document.getElementById('modal-onboard').classList.add('active');
        } else {
            initApp();
        }
        applySettingsToUI();
    }

    // --- CLOUD SYNC ---
    function tsValue(item) {
        const stamp = item?.updatedAt || item?.updated_at || item?.date || '';
        const val = new Date(stamp).getTime();
        return Number.isFinite(val) ? val : 0;
    }

    function mergeByLatest(localArr, cloudArr, prefix = 'legacy') {
        const merged = new Map();
        [...localArr, ...cloudArr].forEach((item) => {
            const id = item.id || fallbackEntityId(item, prefix);
            const current = merged.get(id);
            const normalized = { ...item, id };
            if (!current || tsValue(normalized) > tsValue(current)) merged.set(id, normalized);
        });
        return [...merged.values()];
    }

    async function syncDown() {
        if(!currentUser) return;

        // 1. Pull measurements
        let { data: meas } = await sbClient.from('measurements').select('*').eq('user_id', currentUser.id).order('date', { ascending: true });
        if(meas && meas.length > 0) {
            const cloudMeasurements = meas.map(m => ({
                id: m.id,
                date: m.date,
                readiness: Number(m.readiness),
                rmssd: Number(m.rmssd),
                sdnn: Number(m.sdnn),
                pnn50: Number(m.pnn50),
                meanHR: Number(m.mean_hr),
                stressIndex: Number(m.stress_index),
                rrCount: m.rr_count,
                updatedAt: m.updated_at || m.date
            }));
            appState.measurements = mergeByLatest(appState.measurements, cloudMeasurements, 'measurement').sort((a,b) => a.date.localeCompare(b.date));
            localStorage.setItem('omegahrv_measurements', JSON.stringify(appState.measurements));
        }

        // 2. Pull sessions
        let { data: sess } = await sbClient.from('sessions').select('*').eq('user_id', currentUser.id).order('date', { ascending: false });
        if(sess && sess.length > 0) {
            const cloudSessions = sess.map(s => ({
                id: s.id,
                date: s.date,
                time: s.time,
                title: s.title,
                type: s.type,
                rpe: s.rpe,
                notes: s.notes,
                readinessScore: s.readiness_score,
                hasPB: s.has_pb,
                pbDetails: s.pb_details || [],
                running: s.running_data,
                lifting: s.lifting_data,
                other: s.other_data,
                updatedAt: s.updated_at || `${s.date}T${s.time || '00:00'}:00Z`
            }));
            appState.sessions = mergeByLatest(appState.sessions, cloudSessions, 'session').sort((a,b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            localStorage.setItem('omegahrv_sessions', JSON.stringify(appState.sessions));
        }

        // 3. Pull profile (settings + PBs)
        let { data: prof } = await sbClient.from('profiles').select('*').eq('user_id', currentUser.id).single();
        if(prof) {
            if(prof.settings) {
                appState.settings = prof.settings;
                localStorage.setItem('omegahrv_settings', JSON.stringify(appState.settings));
                appState.onboarded = true;
                localStorage.setItem('omegahrv_onboarded', 'true');
            }
            if(prof.personal_bests) {
                appState.personalBests = prof.personal_bests;
                localStorage.setItem('omegahrv_pbs', JSON.stringify(appState.personalBests));
            }
        }
    }

    async function pushMeasurement(m) {
        if(!currentUser) return;
        setSyncStatus('syncing', 'Saving...');
        try {
            const measurementId = fallbackMeasurementId(m);
            await sbClient.from('measurements').upsert({
                id: measurementId,
                user_id: currentUser.id,
                date: m.date,
                readiness: m.readiness,
                rmssd: m.rmssd,
                sdnn: m.sdnn,
                pnn50: m.pnn50,
                mean_hr: m.meanHR,
                stress_index: m.stressIndex,
                rr_count: m.rrCount,
                updated_at: m.updatedAt || new Date().toISOString()
            });
            setSyncStatus('synced', 'Synced');
        } catch(e) { console.error(e); setSyncStatus('error', 'Sync error'); }
    }

    async function pushSession(s) {
        if(!currentUser) return;
        setSyncStatus('syncing', 'Saving...');
        try {
            await sbClient.from('sessions').upsert({
                id: s.id,
                user_id: currentUser.id,
                date: s.date,
                time: s.time,
                title: s.title,
                type: s.type,
                rpe: s.rpe,
                notes: s.notes,
                readiness_score: s.readinessScore,
                has_pb: s.hasPB,
                pb_details: s.pbDetails,
                running_data: s.running || null,
                lifting_data: s.lifting || null,
                other_data: s.other || null,
                updated_at: s.updatedAt || new Date().toISOString()
            });
            setSyncStatus('synced', 'Synced');
        } catch(e) { console.error(e); setSyncStatus('error', 'Sync error'); }
    }

    async function pushProfile() {
        if(!currentUser) return;
        setSyncStatus('syncing', 'Saving...');
        try {
            await sbClient.from('profiles').upsert({
                user_id: currentUser.id,
                settings: appState.settings,
                personal_bests: appState.personalBests,
                updated_at: new Date().toISOString()
            });
            setSyncStatus('synced', 'Synced');
        } catch(e) { console.error(e); setSyncStatus('error', 'Sync error'); }
    }

    async function forceCloudSync() {
        if(!currentUser) { showToast('Not logged in.', 'warning'); return; }
        setSyncStatus('syncing', 'Full sync...');
        try {
            // Push everything local to cloud
            await pushProfile();
            if (appState.measurements.length) {
                await sbClient.from('measurements').upsert(appState.measurements.map(m => ({
                    id: fallbackMeasurementId(m),
                    user_id: currentUser.id,
                    date: m.date,
                    readiness: m.readiness,
                    rmssd: m.rmssd,
                    sdnn: m.sdnn,
                    pnn50: m.pnn50,
                    mean_hr: m.meanHR,
                    stress_index: m.stressIndex,
                    rr_count: m.rrCount,
                    updated_at: m.updatedAt || new Date().toISOString()
                })));
            }
            if (appState.sessions.length) {
                await sbClient.from('sessions').upsert(appState.sessions.map(s => ({
                    id: sessionIdValue(s),
                    user_id: currentUser.id,
                    date: s.date,
                    time: s.time,
                    title: s.title,
                    type: s.type,
                    rpe: s.rpe,
                    notes: s.notes,
                    readiness_score: s.readinessScore,
                    has_pb: s.hasPB,
                    pb_details: s.pbDetails || [],
                    running_data: s.running || null,
                    lifting_data: s.lifting || null,
                    other_data: s.other || null,
                    updated_at: s.updatedAt || new Date().toISOString()
                })));
            }
            // Then pull to reconcile
            await syncDown();
            initApp();
            setSyncStatus('synced', 'Synced');
            showToast('Cloud sync complete.', 'success');
        } catch(e) {
            console.error(e);
            setSyncStatus('error', 'Sync error');
            showToast('Sync failed: ' + e.message, 'danger');
        }
    }

    // --- INITIALIZATION ---
    document.addEventListener("DOMContentLoaded", async () => {
        if (!navigator.bluetooth) {
            document.getElementById('ble-unsupported').style.display = 'block';
        }

        // Check existing Supabase session
        let hasSession = false;
        try {
            const { data, error } = await sbClient.auth.getSession();
            if(!error && data?.session?.user) {
                currentUser = data.session.user;
                hasSession = true;
                await onAuthSuccess();
            }
        } catch(e) {
            console.warn('Supabase session check failed:', e);
        }

        if(!hasSession) {
            document.getElementById('modal-auth').classList.add('active');
            if(appState.onboarded) initApp();
        }
        applySettingsToUI();

        const sessionList = document.getElementById('log-session-list');
        if (sessionList) {
            sessionList.addEventListener('click', (e) => {
                const btn = e.target.closest('.delete-session-btn');
                if (btn?.dataset.sessionId) deleteSession(btn.dataset.sessionId);
            });
        }

        const historyList = document.getElementById('history-list');
        if (historyList) {
            historyList.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-measurement-id]');
                if (btn?.dataset.measurementId) deleteMeasurement(btn.dataset.measurementId);
            });
        }
    });

    function applySettingsToUI() {
        document.getElementById('set-name').value = appState.settings.name || '';
        document.getElementById('set-age').value = appState.settings.age || '';
        document.getElementById('set-init-duration').value = appState.settings.initDuration || '60';
        document.getElementById('set-duration').value = appState.settings.duration || '180';
        document.getElementById('set-theme').checked = appState.settings.lightMode;
        if(appState.settings.lightMode) document.body.classList.add('light-mode');
    }

    function initApp() {
        renderDashboard();
        renderHistory();
        Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();
        Chart.defaults.font.family = 'Inter';
    }

    function completeOnboarding() {
        appState.settings.name = document.getElementById('onb-name').value || 'Athlete';
        appState.settings.age = document.getElementById('onb-age').value || '30';
        appState.settings.initDuration = '60';
        appState.settings.duration = '180';
        localStorage.setItem('omegahrv_settings', JSON.stringify(appState.settings));
        localStorage.setItem('omegahrv_onboarded', 'true');
        appState.onboarded = true;
        document.getElementById('modal-onboard').classList.remove('active');
        pushProfile(); // sync to cloud
        initApp();
    }

    // --- NAVIGATION & UI HELPERS ---
    function switchTab(tabId, el) {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        if(el) el.classList.add('active');

        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + tabId).classList.add('active');
        document.getElementById('sidebar').classList.remove('open'); // close on mobile

        if(tabId === 'dashboard') renderDashboard();
        if(tabId === 'history') renderHistory();
        if(tabId === 'log') { document.getElementById('log-date').value = new Date().toISOString().split('T')[0]; checkLogReadiness(); renderSessionList(); renderLogSparkline(); }
        if(tabId === 'prs') { renderPBsTrack(); renderPBsGym(); renderLogSparkline(); }
        if(tabId === 'calendar') renderCalendar(new Date().getFullYear(), new Date().getMonth());
    }

    function toggleLogType(type) {
        qsa('.log-form-section').forEach(el => el.style.display = 'none');
        document.getElementById('log-form-' + type).style.display = 'block';
    }

    function togglePRType(type) {
        qsa('.pr-section').forEach(el => el.style.display = 'none');
        document.getElementById('pr-view-' + type).style.display = 'block';
    }

    function toggleAccordion(id) {
        let el = document.getElementById(id);
        if (el.style.maxHeight && el.style.maxHeight !== '0px') {
            el.style.maxHeight = '0px';
        } else {
            el.style.maxHeight = el.scrollHeight + 'px';
        }
    }

    function toggleSplitKin(btn) {
        let kinBody = btn.closest('tr').nextElementSibling.querySelector('.split-kin-body');
        kinBody.classList.toggle('open');
        btn.textContent = kinBody.classList.contains('open') ? 'Kin ▴' : 'Kin ▾';
    }

    function toggleTheme(isLight) {
        if (isLight) document.body.classList.add('light-mode');
        else document.body.classList.remove('light-mode');
        
        Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();
        if(chartSpark) chartSpark.update();
        if(chartHistory) chartHistory.update();
    }

    function saveSettings() {
        appState.settings.name = document.getElementById('set-name').value;
        appState.settings.age = document.getElementById('set-age').value;
        appState.settings.initDuration = document.getElementById('set-init-duration').value;
        appState.settings.duration = document.getElementById('set-duration').value;
        appState.settings.lightMode = document.getElementById('set-theme').checked;
        localStorage.setItem('omegahrv_settings', JSON.stringify(appState.settings));
        pushProfile(); // sync to cloud
        showToast("Settings saved!", 'success');
    }

    // --- DASHBOARD RENDER ---
    function renderDashboard() {
        const todayStr = new Date().toDateString();
        const todayMeasurement = appState.measurements.find(m => new Date(m.date).toDateString() === todayStr);

        if (!todayMeasurement) {
            document.getElementById('dash-empty').style.display = 'flex';
            document.getElementById('dash-filled').style.display = 'none';
        } else {
            document.getElementById('dash-empty').style.display = 'none';
            document.getElementById('dash-filled').style.display = 'flex';

            document.getElementById('dash-score').innerText = todayMeasurement.readiness;
            document.getElementById('dash-rmssd').innerText = Math.round(todayMeasurement.rmssd) + ' ms';
            document.getElementById('dash-hr').innerText = Math.round(todayMeasurement.meanHR) + ' bpm';
            document.getElementById('dash-si').innerText = Math.round(todayMeasurement.stressIndex);

            // Ring logic
            let ring = document.getElementById('dash-ring');
            ring.className = 'readiness-ring';
            document.getElementById('dash-subtitle').innerText = '';
            
            if (todayMeasurement.readiness >= 70) {
                ring.classList.add('status-green');
                document.getElementById('dash-subtitle').innerText = 'Ready to train hard';
            } else if (todayMeasurement.readiness >= 40) {
                ring.classList.add('status-amber');
                document.getElementById('dash-subtitle').innerText = 'Train with caution';
            } else {
                ring.classList.add('status-red');
                document.getElementById('dash-subtitle').innerText = 'Rest today';
            }

            // RMSSD Badge
            let badge = document.getElementById('dash-rmssd-badge');
            badge.className = 'badge';
            if (todayMeasurement.rmssd >= 40) { badge.classList.add('bg-green'); badge.innerText = 'Good'; }
            else if (todayMeasurement.rmssd >= 20) { badge.classList.add('bg-amber'); badge.innerText = 'Moderate'; }
            else { badge.classList.add('bg-red'); badge.innerText = 'Low'; }

            renderSparkline();
        }
    }

    function renderSparkline() {
        const ctx = document.getElementById('sparklineChart').getContext('2d');
        const recent = appState.measurements.slice(-7);
        const labels = recent.map(m => new Date(m.date).toLocaleDateString(undefined, { weekday: 'short' }));
        const data = recent.map(m => m.rmssd);

        destroyChartSafe(chartSpark);
        chartSpark = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    borderColor: '#00c9b1',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { display: false },
                    y: { display: false }
                }
            }
        });
    }

    // --- HISTORY RENDER ---
    function renderHistory() {
        const listDiv = document.getElementById('history-list');
        listDiv.innerHTML = '';
        
        const recent30 = appState.measurements.slice(-30);
        
        if (recent30.length === 0) {
            listDiv.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 20px;">No measurements yet.</p>';
            return;
        }

        [...recent30].reverse().forEach(m => {
            const dateStr = new Date(m.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            let dotColor = m.rmssd >= 40 ? 'var(--success)' : m.rmssd >= 20 ? 'var(--warning)' : 'var(--danger)';
            let statusText = m.rmssd >= 40 ? 'Good' : m.rmssd >= 20 ? 'Moderate' : 'Low';
            const item = document.createElement('div');
            item.className = 'history-item';

            const left = document.createElement('div');
            left.className = 'metrics';
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = dotColor;
            dot.setAttribute('aria-hidden', 'true');
            const date = document.createElement('span');
            date.className = 'date';
            date.textContent = dateStr;
            const status = document.createElement('span');
            status.style.fontSize = '0.75rem';
            status.textContent = `(${statusText})`;
            left.appendChild(dot);
            left.appendChild(date);
            left.appendChild(status);

            const right = document.createElement('div');
            right.className = 'metrics';
            const rmssd = document.createElement('strong');
            rmssd.style.color = 'var(--text-main)';
            rmssd.textContent = `${Math.round(m.rmssd)} ms`;
            const score = document.createElement('span');
            score.textContent = `(Score: ${m.readiness})`;
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.dataset.measurementId = fallbackMeasurementId(m);
            deleteBtn.style.width = 'auto';
            deleteBtn.style.minHeight = 'unset';
            deleteBtn.style.padding = '4px 8px';
            deleteBtn.style.fontSize = '0.75rem';
            deleteBtn.style.color = 'var(--danger)';
            right.appendChild(rmssd);
            right.appendChild(score);
            right.appendChild(deleteBtn);

            item.appendChild(left);
            item.appendChild(right);
            listDiv.appendChild(item);
        });

        // 30-day Chart
        const ctx = document.getElementById('historyChart').getContext('2d');
        const labels = recent30.map(m => new Date(m.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
        const data = recent30.map(m => m.rmssd);

        destroyChartSafe(chartHistory);
        chartHistory = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'RMSSD (ms)',
                    data: data,
                    borderColor: '#00c9b1',
                    backgroundColor: 'rgba(0, 201, 177, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointBackgroundColor: '#00c9b1'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { maxTicksLimit: 7 } }
                }
            }
        });
    }

    // --- BLUETOOTH MEASUREMENT ---
    async function startMeasurement() {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        if (isIOS && 'speechSynthesis' in window) {
            const primer = new SpeechSynthesisUtterance('');
            window.speechSynthesis.speak(primer);
        }
        try {
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: ['heart_rate']
            });

            bleState.device = device;
            device.addEventListener('gattserverdisconnected', onDisconnected);

            document.getElementById('btn-connect').innerHTML = "Connecting...";

            const server = await device.gatt.connect();
            const service = await server.getPrimaryService('heart_rate');
            const characteristic = await service.getCharacteristic('heart_rate_measurement');

            bleState.characteristic = characteristic;
            characteristic.addEventListener('characteristicvaluechanged', handleHeartRateData);
            await characteristic.startNotifications();

            // Transition UI
            document.getElementById('measure-setup').style.display = 'none';
            document.getElementById('measure-active').style.display = 'flex';
            
            bleState.rawRRs = [];
            bleState.initialisationRR = [];
            bleState.running = true;

            let initSecs = parseInt(appState.settings.initDuration);
            if (isNaN(initSecs)) initSecs = 60;
            
            if (initSecs > 0) {
                bleState.phase = 'init';
                bleState.timeLeft = initSecs;
                
                const timerRing = document.getElementById('timer-ring');
                if(timerRing) timerRing.className = 'measure-ring ring-init';
                document.getElementById('live-status-val').innerText = 'Initialising...';
                document.getElementById('live-status-val').style.color = 'var(--text-muted)';
                updateTimerDisplay();
            } else {
                transitionToMeasure();
            }

            bleState.timerInterval = setInterval(() => {
                bleState.timeLeft--;
                updateTimerDisplay();
                if (bleState.timeLeft <= 0) {
                    if (bleState.phase === 'init') {
                        transitionToMeasure();
                    } else {
                        finishMeasurement();
                    }
                }
            }, 1000);

        } catch (error) {
            console.error(error);
            showToast("Bluetooth Error: " + error.message, 'danger');
            document.getElementById('btn-connect').innerHTML = "Connect Sensor";
        }
    }

    function transitionToMeasure() {
        bleState.phase = 'measure';
        bleState.timeLeft = parseInt(appState.settings.duration);
        
        let ring = document.getElementById('timer-ring');
        ring.className = 'measure-ring ring-flash';
        
        if ('speechSynthesis' in window) {
            const msg = new SpeechSynthesisUtterance('Starting measurement. Please stay still.');
            msg.lang = 'en-US'; 
            msg.rate = 0.95; 
            msg.pitch = 1;
            window.speechSynthesis.speak(msg);
        }
        
        setTimeout(() => {
            ring.className = 'measure-ring ring-measure';
            document.getElementById('live-status-val').innerText = 'Measuring...';
            document.getElementById('live-status-val').style.color = 'inherit';
        }, 200);
        
        updateTimerDisplay();
    }

    function onDisconnected() {
        if(bleState.running) {
            let banner = document.getElementById('disconn-banner');
            banner.classList.add('show');
            setTimeout(() => banner.classList.remove('show'), 4000);
            cancelMeasurement();
        }
    }

    function handleHeartRateData(event) {
        if (!bleState.running) return;

        let value = event.target.value;
        let flags = value.getUint8(0);
        let hr16 = (flags & 1) === 1;
        let hrValue = hr16 ? value.getUint16(1, true) : value.getUint8(1);
        
        document.getElementById('live-hr-val').innerText = hrValue;
        if (bleState.phase === 'measure') {
            document.getElementById('live-status-val').innerText = `Measuring... RR count: ${bleState.rawRRs.length} (Packet: ${value.byteLength}B)`;
        }

        let index = hr16 ? 3 : 2;
        let energyPresent = (flags & (1 << 3)) !== 0;
        if (energyPresent) index += 2;

        // Bypass the rrPresent flag check (some devices forget to set bit 4 but append RR anyway)
        while(index + 2 <= value.byteLength) {
            let rawRR = value.getUint16(index, true); 
            let rr_ms = (rawRR / 1024) * 1000;
            
            if (bleState.phase === 'measure') {
                bleState.rawRRs.push(rr_ms);
            } else if (bleState.phase === 'init') {
                bleState.initialisationRR.push(rr_ms);
            }
            index += 2;
        }
    }

    function updateTimerDisplay() {
        let m = Math.floor(bleState.timeLeft / 60).toString().padStart(2, '0');
        let s = (bleState.timeLeft % 60).toString().padStart(2, '0');
        document.getElementById('live-timer-val').innerText = `${m}:${s}`;
    }

    function cancelMeasurement() {
        stopBLE();
        document.getElementById('measure-setup').style.display = 'flex';
        document.getElementById('measure-active').style.display = 'none';
        document.getElementById('btn-connect').innerHTML = "Connect Sensor";
    }

    async function stopBLE() {
        bleState.running = false;
        clearInterval(bleState.timerInterval);
        if (bleState.characteristic) {
            try { await bleState.characteristic.stopNotifications(); } catch(e){}
        }
        if (bleState.device && bleState.device.gatt.connected) {
            bleState.device.gatt.disconnect();
        }
    }

    // --- HRV MATHEMATICS ---

    function filterRR(rawArr) {
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
                    if (diffPerc <= 0.20) { // Reject > 20% ectopic change
                        filtered.push(rr);
                        rejects = 0;
                    } else {
                        rejects++;
                        // If we reject 2 or more consecutive beats, our baseline is likely anomalous. Add the current beat and reset baseline.
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

    function computeHRV(rrArray) {
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

        // Baevsky Stress Index (50ms bins)
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
                modeBinIdx = parseInt(bin);
            }
        }

        let mo = (modeBinIdx + 25) / 1000; // mid of bin in secs
        let amo = (maxBinCount / n) * 100; // percentage
        let mxdmn = (maxRR - minRR) / 1000; // variation sweep in secs
        
        let si = 0;
        if (mxdmn > 0 && mo > 0) {
            si = amo / (2 * mo * mxdmn);
        }

        return { rmssd, sdnn, pnn50, meanHR, stressIndex: si, rrCount: n };
    }

    function calcReadiness(rmssd) {
        // Use a wider baseline (28 days) so score is less noisy day-to-day.
        let baselineWindow = appState.measurements.slice(-28);
        if (baselineWindow.length === 0) return 50;
        let baseline = baselineWindow.reduce((sum, m) => sum + m.rmssd, 0) / baselineWindow.length;
        if (!baseline || baseline <= 0) return 50;
        // Confidence ramps up during first week: start near neutral (50), then trust baseline more.
        let confidenceFactor = Math.min(1, baselineWindow.length / 7);
        // 70 anchors "equal to baseline" to an actionable-but-not-max readiness zone.
        let raw = (rmssd / baseline) * 70;
        let score = raw * confidenceFactor + (50 * (1 - confidenceFactor));
        return Math.max(0, Math.min(100, Math.round(score)));
    }

    function finishMeasurement() {
        stopBLE();
        document.getElementById('measure-active').style.display = 'none';

        let cleanRR = filterRR(bleState.rawRRs);
        if (cleanRR.length < 10) {
            showToast(`Not enough valid data (${cleanRR.length}/${bleState.rawRRs.length}). Ensure straps are moist and retry.`, 'warning');
            discardMeasurement();
            return;
        }

        let hrv = computeHRV(cleanRR);
        let readiness = calcReadiness(hrv.rmssd);

        bleState.lastResult = {
            date: new Date().toISOString(),
            readiness: readiness,
            rmssd: hrv.rmssd,
            sdnn: hrv.sdnn,
            pnn50: hrv.pnn50,
            meanHR: hrv.meanHR,
            stressIndex: hrv.stressIndex,
            rrCount: hrv.rrCount
        };

        // Render UI
        document.getElementById('measure-result').style.display = 'flex';
        document.getElementById('res-rmssd').innerText = Math.round(hrv.rmssd) + ' ms';
        document.getElementById('res-si').innerText = Math.round(hrv.stressIndex);
        document.getElementById('res-sdnn').innerText = Math.round(hrv.sdnn) + ' ms';
        document.getElementById('res-pnn50').innerText = hrv.pnn50.toFixed(1) + ' %';
        
        let desc = "Great reading.";
        if(hrv.rmssd < 20) desc = "Low parasympathetic tone. Consider active recovery.";
        document.getElementById('res-desc').innerText = desc;
    }

    function saveMeasurement() {
        if(!bleState.lastResult) return;
        bleState.lastResult.id = crypto.randomUUID();
        bleState.lastResult.updatedAt = new Date().toISOString();
        appState.measurements.push(bleState.lastResult);
        localStorage.setItem('omegahrv_measurements', JSON.stringify(appState.measurements));
        pushMeasurement(bleState.lastResult); // sync to cloud
        
        // Return to dashboard
        document.getElementById('measure-result').style.display = 'none';
        document.getElementById('measure-setup').style.display = 'flex';
        document.getElementById('btn-connect').innerHTML = "Connect Sensor";
        switchTab('dashboard', document.querySelector('.nav-item.active'));
    }

    function discardMeasurement() {
        bleState.lastResult = null;
        document.getElementById('measure-result').style.display = 'none';
        document.getElementById('measure-setup').style.display = 'flex';
        document.getElementById('btn-connect').innerHTML = "Connect Sensor";
    }

    // --- DATA EXPORT ---
    function exportCSV() {
        if (appState.measurements.length === 0) return showToast("No data to export.", 'warning');
        
        let headers = "Date,Readiness,RMSSD,SDNN,pNN50,MeanHR,StressIndex,RRCount\n";
        let rows = appState.measurements.map(m => {
            return `${m.date},${m.readiness},${m.rmssd.toFixed(2)},${m.sdnn.toFixed(2)},${m.pnn50.toFixed(2)},${m.meanHR.toFixed(2)},${m.stressIndex.toFixed(2)},${m.rrCount}`;
        }).join('\n');

        let blob = new Blob([headers + rows], { type: 'text/csv' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url;
        a.download = `OmegaHRV_Export_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async function confirmClear() {
        const confirmed = await showConfirm("Are you sure you want to delete all historical measurements? This cannot be undone.", { title: 'Clear data', confirmText: 'Delete all' });
        if(confirmed) {
            appState.measurements = [];
            localStorage.removeItem('omegahrv_measurements');
            initApp();
            showToast("Data cleared.", 'success');
        }
    }
    // --- TRAINING DIARY LOGIC ---
    function checkLogReadiness() {
        let date = document.getElementById('log-date').value;
        let badge = document.getElementById('log-readiness-badge');
        let exactMatch = appState.measurements.find(m => m.date.startsWith(date));
        if(exactMatch) {
            badge.style.display = 'block';
            badge.innerText = `Readiness: ${exactMatch.readiness}/100`;
            if(exactMatch.readiness >= 85) badge.className = 'badge bg-green';
            else if(exactMatch.readiness > 60) badge.className = 'badge bg-amber';
            else badge.className = 'badge bg-red';
        } else {
            badge.style.display = 'none';
        }
    }

    function addRunSplit() {
        let tbody = qs('#run-splits-table tbody');
        let splitNum = Math.floor(tbody.children.length / 2) + 1;
        let tr = document.createElement('tr');
        tr.className = 'split-data-row';
        tr.innerHTML = `
            <td><input type="text" placeholder="Split ${splitNum}" class="split-lbl"></td>
            <td><input type="number" step="any" placeholder="1000" class="split-dist"></td>
            <td><input type="text" placeholder="mm:ss" class="split-time"></td>
            <td><input type="text" placeholder="mm:ss" class="split-rest" style="max-width:70px;"></td>
            <td class="split-kmh">--</td><td class="split-ms">--</td>
            <td style="display:flex; gap:2px; align-items:center;">
                <button class="kin-toggle-btn" onclick="toggleSplitKin(this)">Kin ▾</button>
                <button style="padding:4px; min-height:unset; width:auto;" onclick="removeSplitRow(this)">✕</button>
            </td>
        `;
        let kinTr = document.createElement('tr');
        kinTr.className = 'split-kin-row';
        kinTr.innerHTML = `<td colspan="7"><div class="split-kin-body">
            <input type="number" class="kin-gct" placeholder="GCT (ms)">
            <input type="number" class="kin-ft" placeholder="Flight (ms)">
            <input type="number" class="kin-sl" placeholder="Stride L (m)" step="0.01">
            <input type="number" class="kin-sf" placeholder="Stride F (s/min)">
            <input type="number" class="kin-vo" placeholder="Vert Osc (cm)" step="0.1">
        </div></td>`;
        // input listener for auto-calc
        tr.querySelectorAll('input').forEach(inp => inp.addEventListener('blur', function() {
            let dist = parseFloat(tr.querySelector('.split-dist').value);
            let timeStr = tr.querySelector('.split-time').value;
            let secs = parseTime(timeStr);
            if(dist && secs) {
                let speedMs = dist / secs;
                let kmh = speedMs * 3.6;
                tr.querySelector('.split-ms').innerText = speedMs.toFixed(2);
                tr.querySelector('.split-kmh').innerText = kmh.toFixed(1);
            }
            recalcRunTotals();
        }));
        tbody.appendChild(tr);
        tbody.appendChild(kinTr);
    }

    function removeSplitRow(btn) {
        let dataRow = btn.closest('tr');
        let kinRow = dataRow.nextElementSibling;
        if(kinRow && kinRow.classList.contains('split-kin-row')) kinRow.remove();
        dataRow.remove();
        recalcRunTotals();
    }

    function recalcRunTotals() {
        let distAccum = 0;
        let timeAccum = 0;
        let restAccum = 0;
        qsa('#run-splits-table tbody tr.split-data-row').forEach(tr => {
            let d = parseFloat(tr.querySelector('.split-dist').value) || 0;
            let t = parseTime(tr.querySelector('.split-time').value) || 0;
            let r = parseTime(tr.querySelector('.split-rest').value) || 0;
            distAccum += d; timeAccum += t; restAccum += r;
        });
        document.getElementById('run-total-dist').innerText = distAccum > 0 ? (distAccum >= 1000 ? (distAccum/1000).toFixed(2) + ' km' : distAccum + ' m') : '0 m';
        let timeLabel = timeAccum > 0 ? formatTimeLength(timeAccum, true) : '00:00';
        if(restAccum > 0) timeLabel += ` (+ ${formatTimeLength(restAccum)} rest)`;
        document.getElementById('run-total-time').innerText = timeLabel;
        document.getElementById('run-total-dist').dataset.metres = distAccum;
        document.getElementById('run-total-time').dataset.secs = timeAccum;
        document.getElementById('run-total-time').dataset.restSecs = restAccum;
        updateRunCalcs();
    }

    // Keep old name as alias so the Sync Totals button still works
    function syncSplitsToTotal() { recalcRunTotals(); }

    function updateRunCalcs() {
        let distM = parseFloat(document.getElementById('run-total-dist').dataset.metres) || 0;
        let secs = parseFloat(document.getElementById('run-total-time').dataset.secs) || 0;
        if(!distM || !secs) {
            document.getElementById('run-calc-speed').innerText = 'Speed: --';
            document.getElementById('run-calc-pace').innerText = 'Pace: --';
            return;
        }

        let speedMs = distM / secs;
        let kmh = speedMs * 3.6;
        document.getElementById('run-calc-speed').innerText = `${speedMs.toFixed(2)} m/s`;
        document.getElementById('run-calc-pace').innerText = `${kmh.toFixed(1)} km/h`;
    }

    function addLiftExercise() {
        let container = document.getElementById('lift-exercises-container');
        let card = document.createElement('div');
        card.className = 'card lift-ex-card';
        card.style.position = 'relative';
        card.innerHTML = `
            <button style="position:absolute; top:8px; right:8px; padding:4px; width:auto; min-height:unset;" onclick="this.closest('.card').remove()">✕</button>
            <input class="ex-name" type="text" list="exercise-list" placeholder="Exercise Name..." style="margin-bottom:10px; width: 85%;">
            <table class="data-table">
                <thead><tr><th>Reps</th><th>Load</th><th>Type</th><th>Peak W</th><th></th></tr></thead>
                <tbody></tbody>
            </table>
            <button style="margin-top:8px; min-height:30px; font-size:0.8rem; padding: 4px;" onclick="addExSet(this)">+ Add Set</button>
        `;
        container.appendChild(card);
        // Add one default set
        addExSet(card.querySelector('button:last-child'));
    }

    function addExSet(btn) {
        let tbody = btn.previousElementSibling.querySelector('tbody');
        let tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="number" class="set-reps" placeholder="0"></td>
            <td><input type="number" step="any" class="set-load" placeholder="kg"></td>
            <td><select class="set-type"><option value="working">Work</option><option value="warmup">Warm</option></select></td>
            <td><input type="number" class="set-peak" placeholder="W"></td>
            <td><button style="padding:4px; min-height:unset;" onclick="this.closest('tr').remove()">✕</button></td>
        `;
        tbody.appendChild(tr);
    }

    function parseTime(str) {
        if(!str) return 0;
        let p = str.split(':');
        if(p.length === 2) return parseFloat(p[0])*60 + parseFloat(p[1]);
        if(p.length === 3) return parseFloat(p[0])*3600 + parseFloat(p[1])*60 + parseFloat(p[2]);
        return parseFloat(str) || 0;
    }
    
    function formatTimeLength(secs, showMs = false) {
        if(!secs || isNaN(secs) || secs === Infinity) return "00:00";
        let m = Math.floor(secs / 60);
        let s = secs % 60;
        if(showMs) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
        return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
    }

    function getSelectedRadio(name) {
        let el = document.querySelector(`input[name="${name}"]:checked`);
        return el ? el.value : null;
    }

    function saveSession() {
        let type = getSelectedRadio('log-type');
        let title = document.getElementById('log-title').value.trim() || 'Training Session';
        
        // Exact measure match
        let date = document.getElementById('log-date').value;
        let exactMatch = appState.measurements.find(m => m.date.startsWith(date));

        let sess = {
            id: crypto.randomUUID(),
            date: date,
            time: document.getElementById('log-time').value,
            title: title,
            type: type,
            rpe: parseInt(document.getElementById('log-rpe').value),
            notes: document.getElementById('log-notes').value,
            readinessScore: exactMatch ? exactMatch.readiness : null,
            hasPB: false,
            pbDetails: [],
            updatedAt: new Date().toISOString()
        };

        if(type === 'running') {
            let dataRows = qsa('#run-splits-table tbody tr.split-data-row');
            let splits = dataRows.map(tr => {
                let kinRow = tr.nextElementSibling;
                let kin = null;
                if(kinRow && kinRow.classList.contains('split-kin-row')) {
                    let gct = parseFloat(kinRow.querySelector('.kin-gct').value);
                    let ft = parseFloat(kinRow.querySelector('.kin-ft').value);
                    let sl = parseFloat(kinRow.querySelector('.kin-sl').value);
                    let sf = parseFloat(kinRow.querySelector('.kin-sf').value);
                    let vo = parseFloat(kinRow.querySelector('.kin-vo').value);
                    if(gct || ft || sl || sf || vo) kin = { gct, ft, sl, sf, vo };
                }
                return {
                    label: tr.querySelector('.split-lbl').value,
                    distance: parseFloat(tr.querySelector('.split-dist').value) || 0,
                    time: parseTime(tr.querySelector('.split-time').value),
                    rest: parseTime(tr.querySelector('.split-rest').value) || 0,
                    kinematics: kin
                };
            }).filter(s => s.distance > 0 && s.time > 0);

            let distM = parseFloat(document.getElementById('run-total-dist').dataset.metres) || 0;

            sess.running = {
                totalDistance: distM,
                totalTime: parseFloat(document.getElementById('run-total-time').dataset.secs) || 0,
                unit: 'm',
                splits: splits
            };
        } else if(type === 'weightlifting') {
            let mods = qsa('#lift-modalities .chip.active').map(c => c.innerText);
            let exs = qsa('.lift-ex-card').map(card => {
                let sRows = card.querySelectorAll('tbody tr');
                return {
                    name: card.querySelector('.ex-name').value.trim() || 'Unknown',
                    sets: [...sRows].map(r => ({
                        reps: parseInt(r.querySelector('.set-reps').value) || 0,
                        load: parseFloat(r.querySelector('.set-load').value) || 0,
                        type: r.querySelector('.set-type').value,
                        peakPower: parseFloat(r.querySelector('.set-peak').value) || null
                    }))
                };
            }).filter(e => e.name !== 'Unknown');
            
            sess.lifting = {
                duration: document.getElementById('lift-duration').value,
                modalities: mods,
                exercises: exs
            };
        } else {
            sess.other = { activity: document.getElementById('other-activity').value, duration: document.getElementById('other-duration').value };
        }

        checkAndUpdatePBs(sess);

        appState.sessions.unshift(sess);
        appState.sessions.sort((a,b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        
        localStorage.setItem('omegahrv_sessions', JSON.stringify(appState.sessions));
        pushSession(sess); // sync to cloud
        if(sess.hasPB) pushProfile(); // PBs updated, sync profile too
        
        if(sess.hasPB) {
            confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 }, zIndex: 1000 });
        }
        
        resetLogForm();
        renderSessionList();
        renderLogSparkline();
        showToast(sess.hasPB ? `Session saved! ${sess.pbDetails.join(', ')}` : "Session saved.", 'success');
    }

    function resetLogForm() {
        document.getElementById('log-title').value = '';
        document.getElementById('log-notes').value = '';
        document.getElementById('log-rpe').value = '5';
        document.getElementById('log-rpe-val').value = '5';
        document.getElementById('run-total-dist').innerText = '0 m';
        document.getElementById('run-total-time').innerText = '00:00';
        document.getElementById('run-total-dist').dataset.metres = 0;
        document.getElementById('run-total-time').dataset.secs = 0;
        document.getElementById('run-total-time').dataset.restSecs = 0;
        document.querySelector('#run-splits-table tbody').innerHTML = '';
        document.getElementById('lift-duration').value = '';
        qsa('#lift-modalities .chip').forEach(chip => chip.classList.remove('active'));
        document.getElementById('lift-exercises-container').innerHTML = '';
        document.getElementById('other-activity').value = '';
        document.getElementById('other-duration').value = '';
        updateRunCalcs();
    }

    function checkAndUpdatePBs(sess) {
        if(sess.type === 'running' && sess.running) {
            let checkDist = (distM, t) => {
                if(distM <= 0 || t <= 0) return;
                let k = null;
                // Auto map hardcoded rounds
                [10,20,30,40,50,60,80,100,150,200,300,400,600,800,1000,1500,3000,5000,10000].forEach(d => {
                    if(Math.abs(distM - d) < (d*0.02)) k = d + "m";
                });
                if(Math.abs(distM - 1609) < 30) k = "1 Mile";
                if(!k) k = Math.round(distM) + "m";
                
                let existing = appState.personalBests.track[k];
                if(!existing || t < existing.time) {
                    appState.personalBests.track[k] = { time: t, date: sess.date, speed: distM/t };
                    sess.hasPB = true;
                    sess.pbDetails.push(`${k} in ${formatTimeLength(t, true)}`);
                }
            };
            checkDist(sess.running.totalDistance, sess.running.totalTime);
            sess.running.splits.forEach(s => checkDist(s.distance, s.time));
        }

        if(sess.type === 'weightlifting' && sess.lifting) {
            sess.lifting.exercises.forEach(ex => {
                ex.sets.forEach(s => {
                    if(s.load > 0 && s.reps > 0 && s.type !== 'warmup') {
                        let e1rm = s.load * (1 + s.reps/30);
                        let k = ex.name;
                        let existing = appState.personalBests.gym[k];
                        if(!existing || Object.keys(existing).length === 0) {
                            appState.personalBests.gym[k] = { e1rm: e1rm, load: s.load, reps: s.reps, date: sess.date, peak: s.peakPower };
                            sess.hasPB = true;
                            sess.pbDetails.push(`${k} e1RM: ${Math.round(e1rm)}kg`);
                        } else {
                            if(e1rm > existing.e1rm) {
                                existing.e1rm = e1rm; sess.hasPB = true;
                                existing.date = sess.date; existing.load = s.load; existing.reps = s.reps;
                            }
                            if(s.load > existing.load) { existing.load = s.load; existing.reps = s.reps; }
                            if(s.peakPower && (!existing.peak || s.peakPower > existing.peak)) { existing.peak = s.peakPower; }
                        }
                    }
                });
            });
        }
        
        if(sess.hasPB) localStorage.setItem('omegahrv_pbs', JSON.stringify(appState.personalBests));
    }

    // --- RENDERING VIEWS ---
    function renderSessionList() {
        let c = document.getElementById('log-session-list');
        c.innerHTML = '';
        if(appState.sessions.length === 0) { c.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem;">No sessions logged yet.</p>'; return; }
        
        appState.sessions.forEach(s => {
            let el = document.createElement('div');
            el.className = 'log-item';
            let icon = (s.type === 'running') ? '🏃' : (s.type === 'weightlifting') ? '🏋️' : '○';

            const header = document.createElement('div');
            header.className = 'log-item-header';

            const title = document.createElement('strong');
            title.style.fontSize = '0.95rem';
            title.textContent = `${icon} ${s.title}`;
            if (s.hasPB) {
                const pb = document.createElement('span');
                pb.className = 'pb-star';
                pb.style.position = 'static';
                pb.style.marginLeft = '4px';
                pb.textContent = '★ PR';
                title.appendChild(document.createTextNode(' '));
                title.appendChild(pb);
            }

            const dt = document.createElement('span');
            dt.style.fontSize = '0.8rem';
            dt.style.color = 'var(--text-muted)';
            dt.textContent = `${s.date} ${s.time}`;

            header.appendChild(title);
            header.appendChild(dt);

            const meta = document.createElement('div');
            meta.style.fontSize = '0.85rem';
            meta.style.color = 'var(--text-muted)';
            meta.style.marginBottom = '8px';
            if (s.readinessScore != null) {
                const readiness = document.createElement('span');
                readiness.className = `badge ${s.readinessScore>=75?'bg-green':s.readinessScore>40?'bg-amber':'bg-red'}`;
                readiness.style.fontSize = '0.7rem';
                readiness.textContent = `CNS: ${s.readinessScore}`;
                meta.appendChild(readiness);
                meta.appendChild(document.createTextNode(' '));
            }
            meta.appendChild(document.createTextNode(`RPE: ${s.rpe}/10`));

            const delBtn = document.createElement('button');
            delBtn.style.border = 'none';
            delBtn.style.color = 'var(--danger)';
            delBtn.style.background = 'none';
            delBtn.style.textAlign = 'left';
            delBtn.style.fontSize = '0.8rem';
            delBtn.style.padding = '0';
            delBtn.style.minHeight = 'unset';
            delBtn.style.display = 'inline';
            delBtn.textContent = 'Delete';
            delBtn.dataset.sessionId = sessionIdValue(s);
            delBtn.className = 'delete-session-btn';

            el.appendChild(header);
            el.appendChild(meta);
            el.appendChild(delBtn);
            c.appendChild(el);
        });
    }

    window.deleteSession = async function(id) {
        const confirmed = await showConfirm("Delete this session forever?", { title: 'Delete session', confirmText: 'Delete' });
        if(confirmed) {
            appState.sessions = appState.sessions.filter(s => sessionIdValue(s) !== id);
            localStorage.setItem('omegahrv_sessions', JSON.stringify(appState.sessions));
            if (currentUser) {
                try {
                    const query = sbClient.from('sessions');
                    if (query.delete) await query.delete().eq('user_id', currentUser.id).eq('id', id);
                } catch(e) { console.warn('Cloud session delete failed', e); }
            }
            renderSessionList();
            renderPBsGym(); renderPBsTrack();
            showToast('Session deleted.', 'success');
        }
    };

    async function deleteMeasurement(id) {
        const confirmed = await showConfirm('Delete this measurement?', { title: 'Delete measurement', confirmText: 'Delete' });
        if (!confirmed) return;
        appState.measurements = appState.measurements.filter(m => fallbackMeasurementId(m) !== id);
        localStorage.setItem('omegahrv_measurements', JSON.stringify(appState.measurements));
        if (currentUser) {
            try {
                const query = sbClient.from('measurements');
                if (query.delete) await query.delete().eq('user_id', currentUser.id).eq('id', id);
            } catch(e) { console.warn('Cloud measurement delete failed', e); }
        }
        renderHistory();
        renderDashboard();
        showToast('Measurement deleted.', 'success');
    }

    function addCustomTrackPB() {
        let d = prompt("Enter custom distance (e.g., '55m' or 'Marathon'):");
        if(d) {
            if(!appState.personalBests.track[d]) {
                appState.personalBests.track[d] = null;
                renderPBsTrack();
            }
        }
    }

    function renderPBsTrack() {
        let t = document.getElementById('pr-track-tbody');
        t.innerHTML = '';
        let dKeys = ["10m","20m","30m","40m","50m","60m","80m","100m","150m","200m","300m","400m","600m","800m","1000m","1500m","1 Mile","3000m","5000m","10000m"];
        let allKeys = Object.keys(appState.personalBests.track);
        let merged = [...new Set([...dKeys, ...allKeys])];
        merged.sort((a,b) => parseInt(a) - parseInt(b));
        
        merged.forEach(k => {
            let pb = appState.personalBests.track[k];
            if(pb) {
                let row = document.createElement('tr');
                let st = formatTimeLength(pb.time, true);
                const td1 = document.createElement('td');
                const strong = document.createElement('strong');
                strong.textContent = k;
                td1.appendChild(strong);
                const td2 = document.createElement('td');
                td2.style.color = 'var(--accent)';
                td2.style.fontWeight = '600';
                td2.textContent = st;
                const td3 = document.createElement('td');
                td3.textContent = pb.date;
                row.append(td1, td2, td3);
                t.appendChild(row);
            }
        });
    }

    function renderPBsGym() {
        let t = document.getElementById('pr-gym-tbody');
        t.innerHTML = '';
        let keys = Object.keys(appState.personalBests.gym).sort();
        keys.forEach(k => {
            let row = document.createElement('tr');
            let pb = appState.personalBests.gym[k];
            const td1 = document.createElement('td');
            const strong = document.createElement('strong');
            strong.textContent = k;
            td1.appendChild(strong);
            const td2 = document.createElement('td');
            td2.style.color = 'var(--accent)';
            td2.style.fontWeight = '600';
            td2.textContent = `${Math.round(pb.e1rm)}kg`;
            const td3 = document.createElement('td');
            td3.textContent = `${pb.load}kg × ${pb.reps}`;
            const td4 = document.createElement('td');
            td4.style.fontSize = '0.75rem';
            td4.textContent = pb.date;
            row.append(td1, td2, td3, td4);
            t.appendChild(row);
        });
    }

    // --- CALENDAR RENDERING ---
    let currentCalYear = new Date().getFullYear();
    let currentCalMonth = new Date().getMonth();

    window.changeMonth = function(dir) {
        currentCalMonth += dir;
        if(currentCalMonth > 11) { currentCalMonth = 0; currentCalYear++; }
        if(currentCalMonth < 0) { currentCalMonth = 11; currentCalYear--; }
        renderCalendar(currentCalYear, currentCalMonth);
    };

    function renderCalendar(year, month) {
        currentCalYear = year; currentCalMonth = month;
        let c = document.getElementById('calendar-days');
        c.innerHTML = '';
        let detCT = document.getElementById('calendar-day-details');
        if(detCT) {
            detCT.innerHTML = '';
            detCT.style.display = 'none';
        }
        let monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        document.getElementById('calendar-header').innerText = `${monthNames[month]} ${year}`;
        
        let firstDay = new Date(year, month, 1).getDay();
        let monShift = firstDay === 0 ? 6 : firstDay - 1; // Make Monday 0
        let daysInMonth = new Date(year, month + 1, 0).getDate();
        
        for(let i=0; i<monShift; i++) {
            c.innerHTML += `<div class="cal-day empty"></div>`;
        }
        
        let todayStr = new Date().toISOString().split('T')[0];
        
        for(let d=1; d<=daysInMonth; d++) {
            let dateStr = `${year}-${(month+1).toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
            let el = document.createElement('div');
            el.className = 'cal-day' + (dateStr === todayStr ? ' today' : '');
            
            let om = appState.measurements.find(m => m.date.startsWith(dateStr));
            let sesss = appState.sessions.filter(s => s.date === dateStr);
            
            let indHTML = '';
            if(om) {
                let cl = om.readiness >= 75 ? 'var(--success)' : om.readiness > 40 ? 'var(--warning)' : 'var(--danger)';
                indHTML += `<div style="width:8px; height:8px; border-radius:50%; background:${cl};"></div>`;
            }
            if(sesss.length>0) {
                let hasPb = sesss.some(s => s.hasPB);
                if(hasPb) el.innerHTML += `<span class="pb-star">★</span>`;
                indHTML += `<div style="font-size:10px;">•</div>`.repeat(Math.min(sesss.length, 3));
            }
            
            el.innerHTML += `<span class="date-num">${d}</span><div class="cal-indicators">${indHTML}</div>`;
            if (om) {
                const readinessStatus = om.readiness >= 75 ? 'high readiness' : om.readiness > 40 ? 'moderate readiness' : 'low readiness';
                el.setAttribute('aria-label', `${dateStr}: ${readinessStatus}${sesss.length ? `, ${sesss.length} session(s)` : ''}`);
            } else if (sesss.length) {
                el.setAttribute('aria-label', `${dateStr}: ${sesss.length} session(s)`);
            } else {
                el.setAttribute('aria-label', `${dateStr}: no data`);
            }
            el.onclick = () => openDayModal(dateStr, om, sesss);
            c.appendChild(el);
        }
        
        let rem = 42 - (monShift + daysInMonth);
        for(let i=0; i<rem; i++) c.innerHTML += `<div class="cal-day empty"></div>`;
    }

    function openDayModal(date, om, sessions) {
        let container = document.getElementById('calendar-day-details');
        if (!container) return;
        container.innerHTML = '';
        container.style.display = 'flex';

        const card = document.createElement('div');
        card.className = 'card';

        const title = document.createElement('h2');
        title.style.fontSize = '1.1rem';
        title.style.borderBottom = '1px solid var(--border)';
        title.style.paddingBottom = '8px';
        title.style.marginBottom = '8px';
        title.textContent = "Details for " + date;
        card.appendChild(title);

        if (om) {
            const metricsCard = document.createElement('div');
            metricsCard.className = 'card';
            metricsCard.style.background = 'var(--bg)';
            metricsCard.style.fontSize = '0.85rem';
            const strong = document.createElement('strong');
            strong.style.fontSize = '1rem';
            strong.style.color = 'var(--accent)';
            strong.textContent = `Readiness: ${om.readiness}/100`;
            const details = document.createElement('div');
            details.textContent = `RMSSD ${Math.round(om.rmssd)}ms | HR ${Math.round(om.meanHR)}bpm | SDNN ${Math.round(om.sdnn)}`;
            metricsCard.appendChild(strong);
            metricsCard.appendChild(details);
            card.appendChild(metricsCard);
        } else {
            const p = document.createElement('p');
            p.style.fontSize = '0.85rem';
            p.style.color = 'var(--text-muted)';
            p.textContent = 'No readiness data.';
            card.appendChild(p);
        }

        if (sessions.length > 0) {
            const sh = document.createElement('h3');
            sh.style.fontSize = '1rem';
            sh.style.marginTop = '10px';
            sh.textContent = 'Sessions';
            card.appendChild(sh);
            sessions.forEach(s => {
                const row = document.createElement('div');
                row.style.borderLeft = '2px solid var(--accent)';
                row.style.paddingLeft = '10px';
                row.style.marginBottom = '10px';
                row.style.fontSize = '0.85rem';
                
                const st = document.createElement('strong');
                st.textContent = s.title || (s.type.charAt(0).toUpperCase() + s.type.slice(1) + ' Session');
                
                const span = document.createElement('div');
                span.style.color = 'var(--text-muted)';
                span.textContent = `RPE ${s.rpe}/10 | ${s.time}`;
                row.appendChild(st);
                row.appendChild(span);
                
                const det = document.createElement('div');
                det.style.marginTop = '4px';
                det.style.fontSize = '0.8rem';
                if(s.type === 'running' && s.running) {
                    det.textContent = `Dist: ${s.running.distance}m | Dur: ${s.running.time}${s.running.splits ? ` | ${s.running.splits.length} splits` : ''}`;
                } else if (s.type === 'weightlifting' && s.lifting) {
                    const lNames = s.lifting.map(l => `${l.name} (${l.sets.length} sets)`).join(', ');
                    det.textContent = lNames ? lNames : 'No exercises logged';
                } else if (s.other) {
                    det.textContent = `Activity: ${s.other.activity || 'Unknown'} | Dur: ${s.other.duration || '00:00'}`;
                }
                
                if (s.notes) {
                    const notesEl = document.createElement('div');
                    notesEl.style.fontStyle = 'italic';
                    notesEl.style.marginTop = '4px';
                    notesEl.style.color = 'var(--text-muted)';
                    notesEl.textContent = `"${s.notes}"`;
                    det.appendChild(notesEl);
                }
                
                row.appendChild(det);
                card.appendChild(row);
            });
        }
        container.appendChild(card);
        
        // Scroll to details on narrow screens smoothly
        container.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    let logSparkChartInst = null;
    function renderLogSparkline() {
        let ws = document.getElementById('log-spark-wrapper');
        ws.style.display = 'block';
        let ctx = document.getElementById('logSparkline');
        if(!ctx) return;
        destroyChartSafe(logSparkChartInst);
        
        let recent = appState.measurements.slice(-7);
        if(recent.length<2) { ws.style.display='none'; return; }
        
        let prim = getComputedStyle(document.body).getPropertyValue('--accent').trim();
        
        logSparkChartInst = new Chart(ctx, {
            type: 'line',
            data: {
                labels: recent.map(m => ''),
                datasets: [{
                    data: recent.map(m => m.readiness),
                    borderColor: prim,
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 0,
                    fill: { target: 'origin', above: 'rgba(0, 201, 177, 0.2)' }
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } }
            }
        });
    }
