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

    function safeLocalGet(key, fallback) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
        catch(e) { return fallback; }
    }

    function safeLocalSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
    }

    function safeLocalGetRaw(key, fallback) {
        try { return localStorage.getItem(key) ?? fallback; } catch(e) { return fallback; }
    }

    function safeLocalSetRaw(key, value) {
        try { localStorage.setItem(key, value); } catch(e) {}
    }

    function safeLocalRemove(key) {
        try { localStorage.removeItem(key); } catch(e) {}
    }

    // --- STATE ---
    let appState = {
        measurements: safeLocalGet('omegahrv_measurements', []),
        settings: safeLocalGet('omegahrv_settings', { name: '', age: '', initDuration: '60', duration: '180', lightMode: false }),
        onboarded: safeLocalGetRaw('omegahrv_onboarded', 'false') === 'true',
        sessions: safeLocalGet('omegahrv_sessions', []),
        personalBests: safeLocalGet('omegahrv_pbs', { track: {}, gym: {} })
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
    let editingSessionId = null;
    const historyViewState = {
        pageSize: 30,
        renderedCount: 0,
        items: []
    };

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
            renderActiveView();
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

    function compareMeasurementDateAsc(a, b) {
        return (normalizeDate(a?.date) || '').localeCompare(normalizeDate(b?.date) || '');
    }

    function compareSessionDateTimeDesc(a, b) {
        const dateCmp = (normalizeDate(b?.date) || '').localeCompare(normalizeDate(a?.date) || '');
        if (dateCmp !== 0) return dateCmp;
        return String(b?.time || '').localeCompare(String(a?.time || ''));
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
            appState.measurements = mergeByLatest(appState.measurements, cloudMeasurements, 'measurement').sort(compareMeasurementDateAsc);
            safeLocalSet('omegahrv_measurements', appState.measurements);
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
                notes: s.notes,
                readinessScore: s.readiness_score,
                hasPB: s.has_pb,
                pbDetails: s.pb_details || [],
                running: s.running_data,
                lifting: s.lifting_data,
                other: s.other_data,
                updatedAt: s.updated_at || `${s.date}T${s.time || '00:00'}:00Z`
            }));
            appState.sessions = mergeByLatest(appState.sessions, cloudSessions, 'session').sort(compareSessionDateTimeDesc);
            safeLocalSet('omegahrv_sessions', appState.sessions);
        }

        // 3. Pull profile (settings + PBs)
        let { data: prof } = await sbClient.from('profiles').select('*').eq('user_id', currentUser.id).single();
        if(prof) {
            if(prof.settings) {
                appState.settings = prof.settings;
                safeLocalSet('omegahrv_settings', appState.settings);
                appState.onboarded = true;
                safeLocalSetRaw('omegahrv_onboarded', 'true');
            }
            if(prof.personal_bests) {
                appState.personalBests = prof.personal_bests;
                safeLocalSet('omegahrv_pbs', appState.personalBests);
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
            renderActiveView();
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
            const sessionResult = await Promise.race([
                sbClient.auth.getSession(),
                new Promise(resolve => setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 5000))
            ]);
            const { data, error } = sessionResult;
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

        const historySessionList = document.getElementById('history-session-list');
        if (historySessionList) {
            historySessionList.addEventListener('click', (e) => {
                const editBtn = e.target.closest('button[data-session-edit-id]');
                if (editBtn?.dataset.sessionEditId) startSessionEdit(editBtn.dataset.sessionEditId, 'history');
            });
        }

        const calendarDetails = document.getElementById('calendar-day-details');
        if (calendarDetails) {
            calendarDetails.addEventListener('click', (e) => {
                const editBtn = e.target.closest('button[data-session-edit-id]');
                const deleteBtn = e.target.closest('button[data-session-delete-id]');
                if (editBtn?.dataset.sessionEditId) startSessionEdit(editBtn.dataset.sessionEditId, 'calendar');
                if (deleteBtn?.dataset.sessionDeleteId) deleteSession(deleteBtn.dataset.sessionDeleteId);
            });
        }

        const logTitleInput = document.getElementById('log-title');
        if (logTitleInput) {
            logTitleInput.addEventListener('input', updateDefaultSplitSpikesForTitle);
        }
    });

    function applySettingsToUI() {
        document.getElementById('set-name').value = appState.settings.name || '';
        document.getElementById('set-age').value = appState.settings.age || '';
        document.getElementById('set-init-duration').value = appState.settings.initDuration || '60';
        document.getElementById('set-duration').value = appState.settings.duration || '180';
        document.getElementById('set-theme').checked = appState.settings.lightMode;
        if(appState.settings.lightMode) document.body.classList.add('light-mode');
        else document.body.classList.remove('light-mode');
    }

    function initApp() {
        renderDashboard();
        renderHistory();
        Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--text-muted').trim();
        Chart.defaults.font.family = 'Inter';
    }

    function renderActiveView() {
        const activeView = document.querySelector('.view.active');
        if (!activeView) return;
        const id = activeView.id;
        if (id === 'view-dashboard') renderDashboard();
        else if (id === 'view-history') renderHistory();
        else if (id === 'view-calendar') renderCalendar(currentCalYear, currentCalMonth);
        else if (id === 'view-analytics') renderAnalytics();
        else if (id === 'view-prs') { renderPBsTrack(); renderPBsGym(); }
        else if (id === 'view-log') { renderSessionList(); renderLogSparkline(); }
    }

    function completeOnboarding() {
        appState.settings.name = document.getElementById('onb-name').value || 'Athlete';
        appState.settings.age = document.getElementById('onb-age').value || '30';
        appState.settings.initDuration = '60';
        appState.settings.duration = '180';
        safeLocalSet('omegahrv_settings', appState.settings);
        safeLocalSetRaw('omegahrv_onboarded', 'true');
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
        if(tabId === 'log') { 
            let dEl = document.getElementById('log-date');
            if(!dEl.value) dEl.value = new Date().toISOString().split('T')[0];
            checkLogReadiness(); renderSessionList(); renderLogSparkline(); 
        }
        if(tabId === 'prs') { renderPBsTrack(); renderPBsGym(); renderLogSparkline(); }
        if(tabId === 'analytics') renderAnalytics();
        if(tabId === 'calendar') renderCalendar(new Date().getFullYear(), new Date().getMonth());
    }

    function toggleLogType(type) {
        const radio = document.querySelector(`input[name="log-type"][value="${type}"]`);
        if (radio) radio.checked = true;
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
        appState.settings.name = document.getElementById('set-name').value.trim() || 'Athlete';
        let ageVal = parseInt(document.getElementById('set-age').value, 10);
        appState.settings.age = (!isNaN(ageVal) && ageVal > 0) ? ageVal : 30;
        
        let initD = parseInt(document.getElementById('set-init-duration').value, 10);
        appState.settings.initDuration = (!isNaN(initD) && initD > 0) ? String(initD) : '60';
        
        let dur = parseInt(document.getElementById('set-duration').value, 10);
        appState.settings.duration = (!isNaN(dur) && dur >= 30) ? String(dur) : '180';
        
        appState.settings.lightMode = document.getElementById('set-theme').checked;
        safeLocalSet('omegahrv_settings', appState.settings);
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
    function buildHistoryMeasurementItem(m) {
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
        return item;
    }

    function appendMoreHistoryItems() {
        const listDiv = document.getElementById('history-list');
        if (!listDiv || historyViewState.renderedCount >= historyViewState.items.length) return;
        const nextCount = Math.min(historyViewState.items.length, historyViewState.renderedCount + historyViewState.pageSize);
        const frag = document.createDocumentFragment();
        for (let i = historyViewState.renderedCount; i < nextCount; i++) {
            frag.appendChild(buildHistoryMeasurementItem(historyViewState.items[i]));
        }
        historyViewState.renderedCount = nextCount;
        listDiv.appendChild(frag);
    }

    function renderHistorySessions() {
        const list = document.getElementById('history-session-list');
        if (!list) return;
        list.innerHTML = '';
        if (appState.sessions.length === 0) {
            list.innerHTML = '<p style="font-size:0.85rem; color:var(--text-muted);">No sessions logged yet.</p>';
            return;
        }
        appState.sessions.forEach((s) => {
            const item = document.createElement('div');
            item.className = 'history-session-item';

            const left = document.createElement('div');
            const title = document.createElement('strong');
            title.style.fontSize = '0.9rem';
            title.textContent = s.title || 'Training Session';
            const meta = document.createElement('div');
            meta.style.fontSize = '0.8rem';
            meta.style.color = 'var(--text-muted)';
            meta.textContent = `${s.date || '--'} ${s.time || '--:--'} • ${s.type || 'training'}`;
            left.appendChild(title);
            left.appendChild(meta);

            const editBtn = document.createElement('button');
            editBtn.style.width = 'auto';
            editBtn.style.minHeight = 'unset';
            editBtn.style.padding = '4px 10px';
            editBtn.style.fontSize = '0.8rem';
            editBtn.textContent = 'Edit';
            editBtn.dataset.sessionEditId = sessionIdValue(s);

            item.appendChild(left);
            item.appendChild(editBtn);
            list.appendChild(item);
        });
    }

    function renderHistory() {
        const listDiv = document.getElementById('history-list');
        if (!listDiv) return;
        listDiv.innerHTML = '';
        listDiv.onscroll = null;

        historyViewState.items = [...appState.measurements].reverse();
        historyViewState.renderedCount = 0;

        if (historyViewState.items.length === 0) {
            listDiv.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 20px;">No measurements yet.</p>';
            renderHistorySessions();
            return;
        }

        appendMoreHistoryItems();
        while (listDiv.scrollHeight <= listDiv.clientHeight && historyViewState.renderedCount < historyViewState.items.length) {
            appendMoreHistoryItems();
        }
        listDiv.onscroll = () => {
            if (listDiv.scrollTop + listDiv.clientHeight >= listDiv.scrollHeight - 80) appendMoreHistoryItems();
        };

        // Keep chart on most recent 30 values.
        const recent30 = appState.measurements.slice(-30);
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
        renderHistorySessions();
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
        safeLocalSet('omegahrv_measurements', appState.measurements);
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
            safeLocalRemove('omegahrv_measurements');
            initApp();
            showToast("Data cleared.", 'success');
        }
    }
    // --- TRAINING DIARY LOGIC ---
    function checkLogReadiness() {
        let dateInput = document.getElementById('log-date').value;
        let date = normalizeDate(dateInput);
        let badge = document.getElementById('log-readiness-badge');
        if(!date) {
            badge.style.display = 'none';
            return;
        }
        let exactMatch = appState.measurements.find(m => normalizeDate(m.date) === date);
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

    function addRunSplit(presetSplit = null) {
        let tbody = qs('#run-splits-table tbody');
        const spikesDefault = getDefaultSpikesForCurrentSession();
        let tr = document.createElement('tr');
        tr.className = 'split-data-row';
        tr.innerHTML = `
            <td>
                <select class="split-spikes">
                    <option value="yes"${spikesDefault === 'yes' ? ' selected' : ''}>Yes</option>
                    <option value="no"${spikesDefault === 'no' ? ' selected' : ''}>No</option>
                </select>
            </td>
            <td><input type="number" step="any" placeholder="1000" class="split-dist"></td>
            <td><input type="number" step="0.01" placeholder="7.56" class="split-time"></td>
            <td><input type="text" placeholder="min or mm:ss" class="split-rest" style="max-width:90px;"></td>
            <td class="split-kmh">--</td><td class="split-ms">--</td>
            <td style="display:flex; gap:2px; align-items:center;">
                <button class="kin-toggle-btn" onclick="toggleSplitKin(this)">Kin ▾</button>
                <button style="padding:4px; min-height:unset; width:auto;" onclick="duplicateRunSplitRow(this)" title="Duplicate split">⎘</button>
                <button style="padding:4px; min-height:unset; width:auto;" onclick="removeSplitRow(this)">✕</button>
            </td>
        `;
        let kinTr = document.createElement('tr');
        kinTr.className = 'split-kin-row';
        kinTr.innerHTML = `<td colspan="7"><div class="split-kin-body">
            <input type="number" class="kin-gct" placeholder="GCT (ms)">
            <input type="number" class="kin-ft" placeholder="Flight (ms)">
            <input type="number" class="kin-sl" placeholder="Stride L (m)" step="0.01">
            <input type="number" class="kin-sf" placeholder="Stride F (steps/s)">
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
        if (presetSplit) populateRunSplitRow(tr, kinTr, presetSplit);
    }

    function removeSplitRow(btn) {
        let dataRow = btn.closest('tr');
        let kinRow = dataRow.nextElementSibling;
        if(kinRow && kinRow.classList.contains('split-kin-row')) kinRow.remove();
        dataRow.remove();
        recalcRunTotals();
    }

    function populateRunSplitRow(tr, kinTr, split) {
        if (!tr || !split) return;
        tr.querySelector('.split-spikes').value = getSplitSpikesValue(split);
        tr.querySelector('.split-dist').value = split.distance || '';
        tr.querySelector('.split-time').value = formatSplitInputSeconds(split.time);
        tr.querySelector('.split-rest').value = formatRestInput(split.rest);
        const dist = parseFloat(tr.querySelector('.split-dist').value);
        const secs = parseTime(tr.querySelector('.split-time').value);
        if (dist && secs) {
            const speedMs = dist / secs;
            tr.querySelector('.split-ms').innerText = speedMs.toFixed(2);
            tr.querySelector('.split-kmh').innerText = (speedMs * 3.6).toFixed(1);
        }
        if (kinTr && kinTr.classList.contains('split-kin-row') && split.kinematics) {
            kinTr.querySelector('.kin-gct').value = split.kinematics.gct || '';
            kinTr.querySelector('.kin-ft').value = split.kinematics.ft || '';
            kinTr.querySelector('.kin-sl').value = split.kinematics.sl || '';
            kinTr.querySelector('.kin-sf').value = split.kinematics.sf || '';
            kinTr.querySelector('.kin-vo').value = split.kinematics.vo || '';
        }
    }

    function duplicateRunSplitRow(btn) {
        const tr = btn.closest('tr');
        const kinTr = tr?.nextElementSibling;
        if (!tr) return;
        const spikesValue = tr.querySelector('.split-spikes')?.value;
        const cloneData = {
            spikes: spikesValue === 'yes' ? 'yes' : spikesValue === 'no' ? 'no' : getDefaultSpikesForCurrentSession(),
            distance: parseFloat(tr.querySelector('.split-dist')?.value) || 0,
            time: parseTime(tr.querySelector('.split-time')?.value),
            rest: parseRestSeconds(tr.querySelector('.split-rest')?.value) || 0,
            kinematics: kinTr && kinTr.classList.contains('split-kin-row') ? {
                gct: parseFloat(kinTr.querySelector('.kin-gct')?.value) || null,
                ft: parseFloat(kinTr.querySelector('.kin-ft')?.value) || null,
                sl: parseFloat(kinTr.querySelector('.kin-sl')?.value) || null,
                sf: parseFloat(kinTr.querySelector('.kin-sf')?.value) || null,
                vo: parseFloat(kinTr.querySelector('.kin-vo')?.value) || null
            } : null
        };
        if (cloneData.kinematics && !Object.values(cloneData.kinematics).some((v) => Number.isFinite(v))) {
            cloneData.kinematics = null;
        }
        addRunSplit(cloneData);
        recalcRunTotals();
    }

    function getSetBarSpeedValue(set) {
        // Keep compatibility with older saved sessions that stored bar speed under `rfd`.
        return set?.barSpeed || set?.rfd || '';
    }

    function recalcRunTotals() {
        let distAccum = 0;
        let timeAccum = 0;
        let restAccum = 0;
        qsa('#run-splits-table tbody tr.split-data-row').forEach(tr => {
            let d = parseFloat(tr.querySelector('.split-dist').value) || 0;
            let t = parseTime(tr.querySelector('.split-time').value) || 0;
            let r = parseRestSeconds(tr.querySelector('.split-rest').value) || 0;
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
                <thead><tr><th>Reps</th><th>Load</th><th>Type</th><th></th><th></th><th></th></tr></thead>
                <tbody></tbody>
            </table>
            <button class="add-lift-set-btn" style="margin-top:8px; min-height:30px; font-size:0.8rem; padding: 4px;" onclick="addExSet(this)">+ Add Set</button>
        `;
        container.appendChild(card);
        // Add one default set
        addExSet(card.querySelector('.add-lift-set-btn'));
    }

    function addExSet(btn, presetSet = null) {
        let tbody = btn.previousElementSibling.querySelector('tbody');
        let tr = document.createElement('tr');
        const columnCount = btn.closest('table')?.querySelectorAll('thead th').length || 6;
        tr.className = 'set-data-row';
        tr.innerHTML = `
            <td><input type="number" class="set-reps" placeholder="0"></td>
            <td><input type="number" step="any" class="set-load" placeholder="kg"></td>
            <td><select class="set-type"><option value="working">Work</option><option value="warmup">Warm</option></select></td>
            <td><button class="kin-toggle-btn" onclick="toggleLiftSetMetrics(this)">Set Metrics ▾</button></td>
            <td><button style="padding:4px; min-height:unset;" onclick="duplicateLiftSetRow(this)" title="Duplicate set">⎘</button></td>
            <td><button style="padding:4px; min-height:unset;" onclick="removeLiftSetRow(this)">✕</button></td>
        `;
        const metricsTr = document.createElement('tr');
        metricsTr.className = 'split-kin-row';
        metricsTr.innerHTML = `<td colspan="${columnCount}"><div class="split-kin-body">
            <input type="number" step="any" class="set-peak" placeholder="Peak Watt (W)">
            <input type="number" step="any" class="set-mpv" placeholder="MPV (W)">
            <input type="number" step="any" class="set-rom-cm" placeholder="ROM (cm)">
            <input type="number" step="any" class="set-bar-speed" placeholder="Bar speed (m/s)">
        </div></td>`;
        tbody.appendChild(tr);
        tbody.appendChild(metricsTr);
        if (presetSet) {
            tr.querySelector('.set-reps').value = presetSet.reps || '';
            tr.querySelector('.set-load').value = presetSet.load || '';
            tr.querySelector('.set-type').value = presetSet.type || 'working';
            metricsTr.querySelector('.set-peak').value = presetSet.peakPower || '';
            metricsTr.querySelector('.set-mpv').value = presetSet.mpv || '';
            metricsTr.querySelector('.set-rom-cm').value = presetSet.romCm || '';
            metricsTr.querySelector('.set-bar-speed').value = presetSet.barSpeed || '';
        }
    }

    function duplicateLiftSetRow(btn) {
        const row = btn.closest('tr');
        const metricsRow = row?.nextElementSibling;
        const card = row?.closest('.lift-ex-card');
        const addBtn = card?.querySelector('.add-lift-set-btn');
        if (!row || !addBtn) return;
        const preset = {
            reps: parseInt(row.querySelector('.set-reps')?.value) || 0,
            load: parseFloat(row.querySelector('.set-load')?.value) || 0,
            type: row.querySelector('.set-type')?.value || 'working',
            peakPower: parseFloat(metricsRow?.querySelector('.set-peak')?.value) || null,
            mpv: parseFloat(metricsRow?.querySelector('.set-mpv')?.value) || null,
            romCm: parseFloat(metricsRow?.querySelector('.set-rom-cm')?.value) || null,
            barSpeed: parseFloat(metricsRow?.querySelector('.set-bar-speed')?.value) || null
        };
        addExSet(addBtn, preset);
    }

    function toggleLiftSetMetrics(btn) {
        const kinBody = btn.closest('tr')?.nextElementSibling?.querySelector('.split-kin-body');
        if (!kinBody) return;
        const open = kinBody.classList.toggle('open');
        btn.innerText = open ? 'Set Metrics ▴' : 'Set Metrics ▾';
    }

    function removeLiftSetRow(btn) {
        const dataRow = btn.closest('tr');
        const metricsRow = dataRow?.nextElementSibling;
        if (metricsRow && metricsRow.classList.contains('split-kin-row')) metricsRow.remove();
        if (dataRow) dataRow.remove();
    }

    function parseTime(str) {
        if(!str) return 0;
        let p = str.split(':');
        if(p.length === 2) return parseFloat(p[0])*60 + parseFloat(p[1]);
        if(p.length === 3) return parseFloat(p[0])*3600 + parseFloat(p[1])*60 + parseFloat(p[2]);
        return parseFloat(str) || 0;
    }

    function parseRestSeconds(str) {
        if (str == null) return 0;
        const raw = String(str).trim();
        if (!raw) return 0;
        if (raw.includes(':')) return parseTime(raw);
        const mins = parseFloat(raw);
        return Number.isFinite(mins) ? mins * 60 : 0;
    }

    function getSplitSpikesValue(split) {
        const spikes = String(split?.spikes ?? '').toLowerCase();
        if (spikes === 'no') return 'no';
        if (spikes === 'yes') return 'yes';
        // Backward compatibility for older saved splits that used `label` before the spikes selector.
        return String(split?.label || '').toLowerCase() === 'no' ? 'no' : 'yes';
    }

    function getDefaultSpikesForCurrentSession() {
        const title = (document.getElementById('log-title')?.value || '').trim().toLowerCase();
        return title.includes('aerob') ? 'no' : 'yes';
    }

    function formatSplitInputSeconds(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '';
        return n.toFixed(2);
    }

    function updateDefaultSplitSpikesForTitle() {
        const defaultSpikes = getDefaultSpikesForCurrentSession();
        qsa('#run-splits-table tbody tr.split-data-row').forEach((tr) => {
            const spikesEl = tr.querySelector('.split-spikes');
            const distVal = parseFloat(tr.querySelector('.split-dist')?.value);
            const timeVal = parseFloat(tr.querySelector('.split-time')?.value);
            if (!spikesEl) return;
            if (!Number.isFinite(distVal) && !Number.isFinite(timeVal)) {
                spikesEl.value = defaultSpikes;
            }
        });
    }

    function formatRestInput(restSecs) {
        const secs = parseFloat(restSecs) || 0;
        if (secs <= 0) return '';
        if (secs % 60 === 0) return String(secs / 60);
        return formatTimeLength(secs);
    }
    
    function formatTimeLength(secs, showMs = false) {
        if(!secs || isNaN(secs) || secs === Infinity) return "00:00";
        let m = Math.floor(secs / 60);
        let s = secs % 60;
        if(showMs) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
        return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
    }

    function formatSecondsMetric(secs) {
        const n = Number(secs);
        if (!Number.isFinite(n) || n <= 0) return '0.00 s';
        return `${n.toFixed(2)} s`;
    }

    function getSelectedRadio(name) {
        let el = document.querySelector(`input[name="${name}"]:checked`);
        return el ? el.value : null;
    }

    function setSessionEditState(session) {
        const stateRow = document.getElementById('log-edit-state');
        const stateText = document.getElementById('log-edit-state-text');
        const saveBtn = document.getElementById('save-session-btn');
        if (!stateRow || !stateText || !saveBtn) return;
        if (session) {
            editingSessionId = sessionIdValue(session);
            stateText.textContent = `Editing: ${session.title || 'Training Session'} (${session.date || '--'})`;
            stateRow.style.display = 'flex';
            saveBtn.textContent = 'Update Session';
        } else {
            editingSessionId = null;
            stateRow.style.display = 'none';
            saveBtn.textContent = 'Save Session';
        }
    }

    function recomputePersonalBestsFromSessions() {
        const preservedTrack = {};
        const existingTrack = appState.personalBests?.track || {};
        Object.keys(existingTrack).forEach((k) => {
            if (!existingTrack[k]) preservedTrack[k] = null;
        });

        appState.personalBests = { track: preservedTrack, gym: {} };
        appState.sessions.forEach((s) => {
            s.hasPB = false;
            s.pbDetails = [];
        });

        const ordered = [...appState.sessions].sort((a, b) => {
            const dCmp = (a.date || '').localeCompare(b.date || '');
            if (dCmp !== 0) return dCmp;
            return (a.time || '').localeCompare(b.time || '');
        });
        ordered.forEach((s) => checkAndUpdatePBs(s));
        safeLocalSet('omegahrv_pbs', appState.personalBests);
        safeLocalSet('omegahrv_sessions', appState.sessions);
    }

    function switchToLogTab() {
        const logNav = qsa('.nav-item').find((n) => (n.getAttribute('onclick') || '').includes("switchTab('log'"));
        switchTab('log', logNav || document.querySelector('.nav-item.active'));
    }

    function startSessionEdit(sessionId) {
        const target = appState.sessions.find((s) => sessionIdValue(s) === sessionId);
        if (!target) {
            showToast('Session not found.', 'warning');
            return;
        }
        switchToLogTab();
        resetLogForm();

        document.getElementById('log-date').value = target.date || '';
        document.getElementById('log-time').value = target.time || '12:00';
        document.getElementById('log-title').value = target.title || '';

        const type = target.type || 'other';
        const typeRadio = document.querySelector(`input[name="log-type"][value="${type}"]`);
        if (typeRadio) typeRadio.checked = true;
        toggleLogType(type);

        if (type === 'running') {
            const tbody = qs('#run-splits-table tbody');
            tbody.innerHTML = '';
            const splits = Array.isArray(target.running?.splits) ? target.running.splits : [];
            splits.forEach((split) => addRunSplit(split));
            recalcRunTotals();
        } else if (type === 'weightlifting') {
            document.getElementById('lift-duration').value = target.lifting?.duration || '';
            const container = document.getElementById('lift-exercises-container');
            container.innerHTML = '';
            const exercises = Array.isArray(target.lifting?.exercises) ? target.lifting.exercises : [];
            exercises.forEach((ex) => {
                addLiftExercise();
                const cards = qsa('.lift-ex-card');
                const card = cards[cards.length - 1];
                if (!card) return;
                card.querySelector('.ex-name').value = ex.name || '';
                const rows = card.querySelectorAll('tbody tr.set-data-row');
                if (Array.isArray(ex.sets) && ex.sets.length > 0) {
                    if (rows[0]) {
                        const metricsRow = rows[0].nextElementSibling;
                        rows[0].querySelector('.set-reps').value = ex.sets[0].reps || '';
                        rows[0].querySelector('.set-load').value = ex.sets[0].load || '';
                        rows[0].querySelector('.set-type').value = ex.sets[0].type || 'working';
                        if (metricsRow && metricsRow.classList.contains('split-kin-row')) {
                            metricsRow.querySelector('.set-peak').value = ex.sets[0].peakPower || '';
                            metricsRow.querySelector('.set-mpv').value = ex.sets[0].mpv || '';
                            metricsRow.querySelector('.set-rom-cm').value = ex.sets[0].romCm || '';
                            metricsRow.querySelector('.set-bar-speed').value = getSetBarSpeedValue(ex.sets[0]);
                        }
                    }
                    for (let i = 1; i < ex.sets.length; i++) {
                        addExSet(card.querySelector('.add-lift-set-btn'));
                        const lastRows = card.querySelectorAll('tbody tr.set-data-row');
                        const row = lastRows[lastRows.length - 1];
                        const metricsRow = row?.nextElementSibling;
                        if (!row) continue;
                        row.querySelector('.set-reps').value = ex.sets[i].reps || '';
                        row.querySelector('.set-load').value = ex.sets[i].load || '';
                        row.querySelector('.set-type').value = ex.sets[i].type || 'working';
                        if (metricsRow && metricsRow.classList.contains('split-kin-row')) {
                            metricsRow.querySelector('.set-peak').value = ex.sets[i].peakPower || '';
                            metricsRow.querySelector('.set-mpv').value = ex.sets[i].mpv || '';
                            metricsRow.querySelector('.set-rom-cm').value = ex.sets[i].romCm || '';
                            metricsRow.querySelector('.set-bar-speed').value = getSetBarSpeedValue(ex.sets[i]);
                        }
                    }
                }
            });
        } else {
            document.getElementById('other-activity').value = target.other?.activity || '';
            document.getElementById('other-duration').value = target.other?.duration || '';
        }

        checkLogReadiness();
        setSessionEditState(target);
    }

    window.cancelSessionEdit = function() {
        setSessionEditState(null);
        resetLogForm();
        checkLogReadiness();
    };

    function saveSession() {
        let type = getSelectedRadio('log-type');
        let title = document.getElementById('log-title').value.trim() || 'Training Session';
        
        // Exact measure match
        let date = document.getElementById('log-date').value;
        let exactMatch = appState.measurements.find(m => m.date.startsWith(date));

        let sess = {
            id: editingSessionId || crypto.randomUUID(),
            date: date,
            time: document.getElementById('log-time').value,
            title: title,
            type: type,
            readinessScore: exactMatch ? exactMatch.readiness : null,
            hasPB: false,
            pbDetails: [],
            updatedAt: new Date().toISOString()
        };

        if(type === 'running') {
            if (typeof recalcRunTotals === 'function') recalcRunTotals();
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
                    spikes: tr.querySelector('.split-spikes').value === 'no' ? 'no' : 'yes',
                    distance: parseFloat(tr.querySelector('.split-dist').value) || 0,
                    time: parseTime(tr.querySelector('.split-time').value),
                    rest: parseRestSeconds(tr.querySelector('.split-rest').value) || 0,
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
            let exs = qsa('.lift-ex-card').map(card => {
                let sRows = card.querySelectorAll('tbody tr.set-data-row');
                return {
                    name: card.querySelector('.ex-name').value.trim() || 'Unknown',
                    sets: [...sRows].map(r => {
                        const metricsRow = r.nextElementSibling;
                        const peakPower = parseFloat(metricsRow?.querySelector('.set-peak')?.value);
                        const mpv = parseFloat(metricsRow?.querySelector('.set-mpv')?.value);
                        const romCm = parseFloat(metricsRow?.querySelector('.set-rom-cm')?.value);
                        const barSpeed = parseFloat(metricsRow?.querySelector('.set-bar-speed')?.value);
                        return {
                            reps: parseInt(r.querySelector('.set-reps').value) || 0,
                            load: parseFloat(r.querySelector('.set-load').value) || 0,
                            type: r.querySelector('.set-type').value,
                            peakPower: Number.isFinite(peakPower) ? peakPower : null,
                            mpv: Number.isFinite(mpv) ? mpv : null,
                            romCm: Number.isFinite(romCm) ? romCm : null,
                            barSpeed: Number.isFinite(barSpeed) ? barSpeed : null
                        };
                    })
                };
            }).filter(e => e.name !== 'Unknown');
            
            sess.lifting = {
                duration: document.getElementById('lift-duration').value,
                exercises: exs
            };
        } else {
            sess.other = { activity: document.getElementById('other-activity').value, duration: document.getElementById('other-duration').value };
        }

        if (editingSessionId) {
            const idx = appState.sessions.findIndex((s) => sessionIdValue(s) === editingSessionId);
            if (idx >= 0) appState.sessions[idx] = sess;
            else appState.sessions.unshift(sess);
        } else {
            appState.sessions.unshift(sess);
        }
        appState.sessions.sort(compareSessionDateTimeDesc);

        recomputePersonalBestsFromSessions();
        pushSession(sess); // sync to cloud
        pushProfile();
        
        if(sess.hasPB) {
            confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 }, zIndex: 1000 });
        }
        
        const wasEditing = !!editingSessionId;
        setSessionEditState(null);
        resetLogForm();
        renderSessionList();
        renderLogSparkline();
        renderPBsGym();
        renderPBsTrack();
        renderHistory();
        if(typeof currentCalYear !== 'undefined') renderCalendar(currentCalYear, currentCalMonth);
        showToast(
            sess.hasPB
                ? `${wasEditing ? 'Session updated!' : 'Session saved!'} ${sess.pbDetails.join(', ')}`
                : (wasEditing ? 'Session updated.' : 'Session saved.'),
            'success'
        );
    }

    function resetLogForm() {
        document.getElementById('log-title').value = '';
        document.getElementById('run-total-dist').innerText = '0 m';
        document.getElementById('run-total-time').innerText = '00:00';
        document.getElementById('run-total-dist').dataset.metres = 0;
        document.getElementById('run-total-time').dataset.secs = 0;
        document.getElementById('run-total-time').dataset.restSecs = 0;
        document.querySelector('#run-splits-table tbody').innerHTML = '';
        document.getElementById('lift-duration').value = '';
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
                    sess.pbDetails.push(`${k} in ${formatSecondsMetric(t)}`);
                }
            };
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
        
        if(sess.hasPB) safeLocalSet('omegahrv_pbs', appState.personalBests);
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
            dt.textContent = `${s.date || 'Unknown Date'} ${s.time || ''}`.trim();

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
            }
            const typeText = `Type: ${s.type || 'training'}`;
            meta.appendChild(document.createTextNode(s.readinessScore != null ? ` • ${typeText}` : typeText));

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
            recomputePersonalBestsFromSessions();
            if (currentUser) {
                try {
                    const query = sbClient.from('sessions');
                    if (query.delete) await query.delete().eq('user_id', currentUser.id).eq('id', id);
                } catch(e) { console.warn('Cloud session delete failed', e); }
            }
            if (editingSessionId === id) setSessionEditState(null);
            renderSessionList();
            renderPBsGym(); renderPBsTrack();
            renderHistory();
            if(typeof currentCalYear !== 'undefined') renderCalendar(currentCalYear, currentCalMonth);
            pushProfile();
            showToast('Session deleted.', 'success');
        }
    };

    async function deleteMeasurement(id) {
        const confirmed = await showConfirm('Delete this measurement?', { title: 'Delete measurement', confirmText: 'Delete' });
        if (!confirmed) return;
        appState.measurements = appState.measurements.filter(m => fallbackMeasurementId(m) !== id);
        safeLocalSet('omegahrv_measurements', appState.measurements);
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

    function editTrackPB(distanceKey) {
        const current = appState.personalBests.track?.[distanceKey];
        if (!current) return;
        const nextTime = parseFloat(prompt(`Edit best time for ${distanceKey} (seconds)`, String(current.time ?? '')));
        if (!Number.isFinite(nextTime) || nextTime <= 0) return;
        const nextDate = (prompt(`Edit date for ${distanceKey} (YYYY-MM-DD)`, current.date || '') || '').trim();
        const parsedDist = parseFloat(distanceKey);
        appState.personalBests.track[distanceKey] = {
            ...current,
            time: nextTime,
            date: nextDate || current.date || '',
            speed: Number.isFinite(parsedDist) && parsedDist > 0 ? parsedDist / nextTime : (current.speed || null)
        };
        safeLocalSet('omegahrv_pbs', appState.personalBests);
        renderPBsTrack();
        pushProfile();
        showToast('Track PR updated.', 'success');
    }

    function editGymPB(exerciseKey) {
        const current = appState.personalBests.gym?.[exerciseKey];
        if (!current) return;
        const e1rm = parseFloat(prompt(`Edit best e1RM for ${exerciseKey} (kg)`, String(current.e1rm ?? '')));
        if (!Number.isFinite(e1rm) || e1rm <= 0) return;
        const load = parseFloat(prompt(`Edit best load for ${exerciseKey} (kg)`, String(current.load ?? '')));
        if (!Number.isFinite(load) || load <= 0) return;
        const reps = parseInt(prompt(`Edit reps for ${exerciseKey}`, String(current.reps ?? '')), 10);
        if (!Number.isFinite(reps) || reps <= 0) return;
        const nextDate = (prompt(`Edit date for ${exerciseKey} (YYYY-MM-DD)`, current.date || '') || '').trim();
        appState.personalBests.gym[exerciseKey] = {
            ...current,
            e1rm,
            load,
            reps,
            date: nextDate || current.date || ''
        };
        safeLocalSet('omegahrv_pbs', appState.personalBests);
        renderPBsGym();
        pushProfile();
        showToast('Gym PR updated.', 'success');
    }

    async function deleteTrackPB(distanceKey) {
        const current = appState.personalBests.track?.[distanceKey];
        if (!current) return;
        const confirmed = await showConfirm(`Remove PR for ${distanceKey}?`, { title: 'Remove track PR', confirmText: 'Remove' });
        if (!confirmed) return;
        delete appState.personalBests.track[distanceKey];
        safeLocalSet('omegahrv_pbs', appState.personalBests);
        renderPBsTrack();
        pushProfile();
        showToast('Track PR removed.', 'success');
    }

    async function deleteGymPB(exerciseKey) {
        const current = appState.personalBests.gym?.[exerciseKey];
        if (!current) return;
        const confirmed = await showConfirm(`Remove PR for ${exerciseKey}?`, { title: 'Remove gym PR', confirmText: 'Remove' });
        if (!confirmed) return;
        delete appState.personalBests.gym[exerciseKey];
        safeLocalSet('omegahrv_pbs', appState.personalBests);
        renderPBsGym();
        pushProfile();
        showToast('Gym PR removed.', 'success');
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
                let st = formatSecondsMetric(pb.time);
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
                const td4 = document.createElement('td');
                const editBtn = document.createElement('button');
                editBtn.style.width = 'auto';
                editBtn.style.minHeight = 'unset';
                editBtn.style.padding = '4px 8px';
                editBtn.style.fontSize = '0.75rem';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', () => editTrackPB(k));
                const removeBtn = document.createElement('button');
                removeBtn.style.width = 'auto';
                removeBtn.style.minHeight = 'unset';
                removeBtn.style.padding = '4px 8px';
                removeBtn.style.fontSize = '0.75rem';
                removeBtn.style.marginLeft = '6px';
                removeBtn.style.borderColor = 'var(--danger)';
                removeBtn.style.color = 'var(--danger)';
                removeBtn.textContent = 'Remove';
                removeBtn.addEventListener('click', () => deleteTrackPB(k));
                td4.appendChild(editBtn);
                td4.appendChild(removeBtn);
                row.append(td1, td2, td3, td4);
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
            const td5 = document.createElement('td');
            const editBtn = document.createElement('button');
            editBtn.style.width = 'auto';
            editBtn.style.minHeight = 'unset';
            editBtn.style.padding = '4px 8px';
            editBtn.style.fontSize = '0.75rem';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => editGymPB(k));
            const removeBtn = document.createElement('button');
            removeBtn.style.width = 'auto';
            removeBtn.style.minHeight = 'unset';
            removeBtn.style.padding = '4px 8px';
            removeBtn.style.fontSize = '0.75rem';
            removeBtn.style.marginLeft = '6px';
            removeBtn.style.borderColor = 'var(--danger)';
            removeBtn.style.color = 'var(--danger)';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => deleteGymPB(k));
            td5.appendChild(editBtn);
            td5.appendChild(removeBtn);
            row.append(td1, td2, td3, td4, td5);
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
        if (!currentUser) return;
        currentCalYear = year; currentCalMonth = month;
        let c = document.getElementById('calendar-days');
        c.innerHTML = '';
        const hint = document.getElementById('cal-hint');
        if (hint) hint.style.display = '';
        const detailPanel = document.getElementById('calendar-day-details');
        if (detailPanel) {
            detailPanel.classList.remove('visible');
            detailPanel.innerHTML = '';
        }
        let monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        document.getElementById('calendar-header').innerText = `${monthNames[month]} ${year}`;
        
        let firstDay = new Date(year, month, 1).getDay();
        let monShift = firstDay === 0 ? 6 : firstDay - 1; // Make Monday 0
        let daysInMonth = new Date(year, month + 1, 0).getDate();
        
        for(let i=0; i<monShift; i++) {
            let emptyEl = document.createElement('div');
            emptyEl.className = 'cal-day empty';
            c.appendChild(emptyEl);
        }
        
        let todayStr = new Date().toISOString().split('T')[0];
        
        for(let d=1; d<=daysInMonth; d++) {
            let dateStr = `${year}-${(month+1).toString().padStart(2,'0')}-${d.toString().padStart(2,'0')}`;
            let el = document.createElement('div');
            el.className = 'cal-day' + (dateStr === todayStr ? ' today' : '');
            
            let om = appState.measurements.find(m => normalizeDate(m.date) === dateStr);
            let sesss = appState.sessions.filter(s => normalizeDate(s.date) === dateStr);
            
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
            
            el.setAttribute('data-date', dateStr);
            el.setAttribute('role', 'button');
            el.setAttribute('tabindex', '0');
            el.addEventListener('click', handleDayInteraction);
            el.addEventListener('keydown', (e) => {
                if(e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleDayInteraction.call(el);
                }
            });
            c.appendChild(el);
        }
        
        let rem = 42 - (monShift + daysInMonth);
        for(let i=0; i<rem; i++) {
            let emptyEl = document.createElement('div');
            emptyEl.className = 'cal-day empty';
            c.appendChild(emptyEl);
        }
    }
    window.renderCalendar = renderCalendar;

    function normalizeDate(dateVal) {
        if (!dateVal) return null;
        if (typeof dateVal === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) return dateVal;
            const parsed = new Date(dateVal);
            if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
            return null;
        }
        if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
             return dateVal.toISOString().split('T')[0];
        }
        return null;
    }

    function handleDayInteraction() {
        const dateStr = this.getAttribute('data-date');
        if (!dateStr) return;
        const liveMeas = appState.measurements.find(m => normalizeDate(m.date) === dateStr);
        const liveSess = appState.sessions.filter(s => normalizeDate(s.date) === dateStr);
        openDayModal(dateStr, liveMeas, liveSess);
    }

    function openDayModal(date, om, sessions) {
        let container = document.getElementById('calendar-day-details');
        if (!container) {
            container = document.createElement('div');
            container.id = 'calendar-day-details';
            const tv = document.getElementById('view-calendar');
            if(tv) tv.appendChild(container);
            else return;
        }
        
        const hint = document.getElementById('cal-hint');
        if (hint) hint.style.display = 'none';

        container.innerHTML = '';
        container.classList.add('visible');

        const card = document.createElement('div');
        card.className = 'card';

        const title = document.createElement('h2');
        title.style.fontSize = '1.1rem';
        title.style.borderBottom = '1px solid var(--border)';
        title.style.paddingBottom = '8px';
        title.style.marginBottom = '8px';
        title.textContent = "Details for " + date;
        card.appendChild(title);

        if (!om && sessions.length === 0) {
            const emptyP = document.createElement('p');
            emptyP.style.fontSize = '0.85rem';
            emptyP.style.color = 'var(--text-muted)';
            emptyP.textContent = 'No sessions or measurements recorded on this day.';
            card.appendChild(emptyP);
        } else {
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
                const renderIfPresent = (container, labelText, val, suffix = '') => {
                    if (val !== null && val !== undefined && val !== '' && !Number.isNaN(val)) {
                        const line = document.createElement('div');
                        line.style.marginTop = '2px';
                        line.innerHTML = `<strong>${labelText}:</strong> ${val}${suffix}`;
                        container.appendChild(line);
                    }
                };

                sessions.forEach(s => {
                    try {
                        const row = document.createElement('div');
                        row.style.borderLeft = '2px solid var(--accent)';
                        row.style.paddingLeft = '10px';
                        row.style.marginBottom = '15px';
                        row.style.fontSize = '0.85rem';
                        
                        let typeStr = (typeof s.type === 'string' && s.type.length > 0) ? s.type : 'Training';
                        const st = document.createElement('strong');
                        st.textContent = s.title || (typeStr.charAt(0).toUpperCase() + typeStr.slice(1) + ' Session');
                        
                        const span = document.createElement('div');
                        span.style.color = 'var(--text-muted)';
                        span.textContent = `Date: ${s.date || 'Unknown'} ${s.time || ''}`.trim();
                        row.appendChild(st);
                        row.appendChild(span);

                        const actions = document.createElement('div');
                        actions.style.marginTop = '6px';
                        actions.style.display = 'flex';
                        actions.style.gap = '6px';
                        const editBtn = document.createElement('button');
                        editBtn.style.width = 'auto';
                        editBtn.style.minHeight = 'unset';
                        editBtn.style.padding = '4px 10px';
                        editBtn.style.fontSize = '0.75rem';
                        editBtn.textContent = 'Edit session';
                        editBtn.dataset.sessionEditId = sessionIdValue(s);
                        const delBtn = document.createElement('button');
                        delBtn.style.width = 'auto';
                        delBtn.style.minHeight = 'unset';
                        delBtn.style.padding = '4px 10px';
                        delBtn.style.fontSize = '0.75rem';
                        delBtn.style.color = 'var(--danger)';
                        delBtn.textContent = 'Delete session';
                        delBtn.dataset.sessionDeleteId = sessionIdValue(s);
                        actions.appendChild(editBtn);
                        actions.appendChild(delBtn);
                        row.appendChild(actions);
                        
                        const det = document.createElement('div');
                        det.style.marginTop = '6px';
                        det.style.fontSize = '0.8rem';
                        
                        if(s.type === 'running' && typeof s.running === 'object' && s.running !== null) {
                            const distDisplay = s.running.totalDistance >= 1000
                                ? (s.running.totalDistance / 1000).toFixed(2) + ' km'
                                : (s.running.totalDistance || 0) + ' m';
                            const splitRestSecs = Array.isArray(s.running.splits)
                                ? s.running.splits.reduce((sum, split) => sum + (Number(split?.rest) || 0), 0)
                                : 0;
                            const durDisplay = formatTimeLength((s.running.totalTime || 0) + splitRestSecs);
                            
                            let runBlock = document.createElement('div');
                            renderIfPresent(runBlock, 'Total Distance', distDisplay);
                            renderIfPresent(runBlock, 'Total Time', durDisplay);
                            
                            if (Array.isArray(s.running.splits) && s.running.splits.length > 0) {
                                let splitsTitle = document.createElement('div');
                                splitsTitle.style.marginTop = '6px';
                                splitsTitle.style.fontWeight = 'bold';
                                splitsTitle.textContent = `Splits (${s.running.splits.length})`;
                                runBlock.appendChild(splitsTitle);
                                
                                s.running.splits.forEach((split, idx) => {
                                    let sRow = document.createElement('div');
                                    sRow.style.marginLeft = '8px';
                                    sRow.style.paddingLeft = '6px';
                                    sRow.style.borderLeft = '1px solid var(--border)';
                                    sRow.style.marginTop = '4px';
                                    
                                    let summary = document.createElement('div');
                                    const spikesLabel = getSplitSpikesValue(split) === 'no' ? 'No' : 'Yes';
                                    summary.innerHTML = `<em>Spikes: ${spikesLabel}</em> — ${split.distance||0}m in ${split.time||0}s`;
                                    if (split.rest) summary.innerHTML += ` (Rest: ${split.rest}s)`;
                                    sRow.appendChild(summary);
                                    
                                    if (split.kinematics) {
                                        let kinText = [];
                                        if(split.kinematics.gct) kinText.push(`GCT: ${split.kinematics.gct}ms`);
                                        if(split.kinematics.ft) kinText.push(`Flight: ${split.kinematics.ft}ms`);
                                        if(split.kinematics.sl) kinText.push(`Stride: ${split.kinematics.sl}m`);
                                        if(split.kinematics.sf) kinText.push(`Freq: ${split.kinematics.sf} steps/s`);
                                        if(split.kinematics.vo) kinText.push(`Vert: ${split.kinematics.vo}cm`);
                                        if(kinText.length > 0) {
                                            let kDiv = document.createElement('div');
                                            kDiv.style.color = 'var(--text-muted)';
                                            kDiv.style.fontSize = '0.75rem';
                                            kDiv.textContent = '└ ' + kinText.join(' | ');
                                            sRow.appendChild(kDiv);
                                        }
                                    }
                                    runBlock.appendChild(sRow);
                                });
                            }
                            det.appendChild(runBlock);
                            
                        } else if (s.type === 'weightlifting' && s.lifting) {
                            let liftBlock = document.createElement('div');
                            renderIfPresent(liftBlock, 'Duration', s.lifting.duration);
                            
                            if (Array.isArray(s.lifting.exercises) && s.lifting.exercises.length > 0) {
                                let exTitle = document.createElement('div');
                                exTitle.style.marginTop = '6px';
                                exTitle.style.fontWeight = 'bold';
                                exTitle.textContent = `Exercises (${s.lifting.exercises.length})`;
                                liftBlock.appendChild(exTitle);
                                
                                s.lifting.exercises.forEach(ex => {
                                    let exRow = document.createElement('div');
                                    exRow.style.marginLeft = '8px';
                                    exRow.style.marginTop = '4px';
                                    let nameRow = document.createElement('div');
                                    nameRow.innerHTML = `<strong>${ex.name || 'Unknown'}</strong>`;
                                    exRow.appendChild(nameRow);
                                    
                                    if (Array.isArray(ex.sets)) {
                                        let sList = document.createElement('ul');
                                        sList.style.margin = '2px 0 0 16px';
                                        sList.style.padding = '0';
                                        sList.style.color = 'var(--text-muted)';
                                        ex.sets.forEach((set, sIdx) => {
                                            let li = document.createElement('li');
                                            li.style.listStyleType = 'circle';
                                            let setStr = `Set ${sIdx+1}: ${set.load||0}kg x ${set.reps||0} (${set.type||'working'})`;
                                            const metrics = [];
                                            if (set.peakPower) metrics.push(`Peak: ${set.peakPower}W`);
                                            if (set.mpv) metrics.push(`MPV: ${set.mpv}W`);
                                            if (set.romCm) metrics.push(`ROM: ${set.romCm}cm`);
                                            const barSpeed = getSetBarSpeedValue(set);
                                            if (barSpeed) metrics.push(`Bar speed: ${barSpeed}m/s`);
                                            if (metrics.length) setStr += ` [${metrics.join(' | ')}]`;
                                            li.textContent = setStr;
                                            sList.appendChild(li);
                                        });
                                        exRow.appendChild(sList);
                                    }
                                    liftBlock.appendChild(exRow);
                                });
                            } else {
                                let noEx = document.createElement('div');
                                noEx.textContent = 'No exercises logged';
                                noEx.style.color = 'var(--text-muted)';
                                liftBlock.appendChild(noEx);
                            }
                            det.appendChild(liftBlock);
                            
                        } else if (s.other && typeof s.other === 'object') {
                            let otherBlock = document.createElement('div');
                            renderIfPresent(otherBlock, 'Activity', s.other.activity || 'Unknown');
                            renderIfPresent(otherBlock, 'Duration', s.other.duration || '00:00');
                            det.appendChild(otherBlock);
                        }
                        
                        if (s.hasPB && Array.isArray(s.pbDetails) && s.pbDetails.length > 0) {
                            const pbWrap = document.createElement('div');
                            pbWrap.style.marginTop = '6px';
                            s.pbDetails.forEach((pbTxt) => {
                                const pill = document.createElement('span');
                                pill.className = 'pb-pill';
                                pill.textContent = typeof pbTxt === 'string'
                                    ? pbTxt
                                    : (pbTxt?.metric || pbTxt?.label || 'PB');
                                pbWrap.appendChild(pill);
                            });
                            det.appendChild(pbWrap);
                        }
                        
                        row.appendChild(det);
                        card.appendChild(row);
                    } catch (err) {
                        console.error('Failed to parse session layout details for a record:', s, err);
                    }
                });
            }
        }
        container.appendChild(card);
        
        setTimeout(() => {
            const detailPanel = document.getElementById('calendar-day-details');
            if (detailPanel) {
                detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }, 300);
    }
    window.openDayModal = openDayModal;

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

    const analyticsCharts = {};
    const analyticsState = {
        dailyDate: '',
        weekOffset: 0,
        monthOffset: 0
    };

    function analyticsCss(name) {
        return getComputedStyle(document.body).getPropertyValue(name).trim();
    }

    function analyticsIconForType(type) {
        if (type === 'running') return '🏃';
        if (type === 'weightlifting') return '🏋️';
        return '○';
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function formatMMSS(totalSeconds) {
        const secs = Number(totalSeconds) || 0;
        const m = Math.floor(Math.max(0, secs) / 60);
        const s = Math.round(Math.max(0, secs) % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatDistanceHuman(meters) {
        const m = Number(meters) || 0;
        if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
        return `${Math.round(m)} m`;
    }

    function formatKmh(kmh) {
        return `${(Number(kmh) || 0).toFixed(1)} km/h`;
    }

    function formatKg(v) {
        return `${(Number(v) || 0).toFixed(1)}kg`;
    }

    function formatDateKey(d) {
        if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
        return d.toISOString().split('T')[0];
    }

    function addDays(date, delta) {
        const d = new Date(date);
        d.setDate(d.getDate() + delta);
        return d;
    }

    function startOfISOWeek(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + diff);
        return d;
    }

    function getISOWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    function getSessionDurationMinutes(session) {
        if (!session) return 0;
        if (session.type === 'running') return (Number(session.running?.totalTime) || 0) / 60;
        if (session.type === 'weightlifting') return (parseTime(session.lifting?.duration) || 0) / 60;
        return (parseTime(session.other?.duration) || 0) / 60;
    }

    function getSessionLoadUnits(session) {
        const rpe = Number(session?.rpe) || 0;
        return rpe * getSessionDurationMinutes(session);
    }

    function getLatestAnalyticsDate() {
        const dates = [
            ...(appState.sessions || []).map((s) => normalizeDate(s?.date)).filter(Boolean),
            ...(appState.measurements || []).map((m) => normalizeDate(m?.date)).filter(Boolean)
        ];
        if (!dates.length) return formatDateKey(new Date());
        return dates.sort().slice(-1)[0];
    }

    function getDayData(dateKey) {
        const sessions = (appState.sessions || []).filter((s) => normalizeDate(s?.date) === dateKey);
        const measurement = (appState.measurements || []).find((m) => normalizeDate(m?.date) === dateKey) || null;
        return { sessions, measurement };
    }

    function runningSessionForDay(sessions) {
        return (sessions || []).find((s) => s?.type === 'running' && (s?.running?.splits || []).length > 0) || null;
    }

    function liftingSessionForDay(sessions) {
        return (sessions || []).find((s) => s?.type === 'weightlifting' && (s?.lifting?.exercises || []).length > 0) || null;
    }

    function sectionTitle(text) {
        return `<h3 style="font-size:1rem; margin-bottom:10px; color:var(--text-main);">${escapeHtml(text)}</h3>`;
    }

    function chartCanvasBlock(id) {
        return `<div class="chart-container" style="position:relative; height:220px;"><canvas id="${id}"></canvas></div>`;
    }

    function analyticsEmptyState(neededLabel) {
        return `<div class="card analytics-empty-state"><span>📊</span><span>Not enough data yet — ${neededLabel} sessions needed</span></div>`;
    }

    function destroyAnalyticsChart(key) {
        destroyChartSafe(analyticsCharts[key]);
        analyticsCharts[key] = null;
    }

    function destroyAllAnalyticsCharts() {
        Object.keys(analyticsCharts).forEach((k) => destroyAnalyticsChart(k));
    }

    function refLinePlugin() {
        return {
            id: 'analyticsRefLines',
            afterDraw(chart, args, opts) {
                const lines = opts?.lines || [];
                const ctx = chart.ctx;
                const area = chart.chartArea;
                if (!ctx || !area) return;
                lines.forEach((line) => {
                    const scale = chart.scales[line.axis || 'x'];
                    if (!scale) return;
                    const value = line.value;
                    const px = scale.getPixelForValue(value);
                    ctx.save();
                    ctx.strokeStyle = line.color || analyticsCss('--text-muted');
                    ctx.lineWidth = line.width || 1;
                    ctx.setLineDash(line.dash || [6, 4]);
                    ctx.beginPath();
                    if ((line.axis || 'x') === 'x') {
                        ctx.moveTo(px, area.top);
                        ctx.lineTo(px, area.bottom);
                    } else {
                        ctx.moveTo(area.left, px);
                        ctx.lineTo(area.right, px);
                    }
                    ctx.stroke();
                    ctx.restore();
                });
            }
        };
    }

    function splitAvgMarkerPlugin(avgTimes) {
        return {
            id: 'splitAvgMarker',
            afterDatasetsDraw(chart) {
                const meta = chart.getDatasetMeta(0);
                if (!meta) return;
                const ctx = chart.ctx;
                const xScale = chart.scales.x;
                ctx.save();
                ctx.strokeStyle = analyticsCss('--text-muted');
                ctx.setLineDash([5, 3]);
                (meta.data || []).forEach((bar, idx) => {
                    const t = avgTimes[idx];
                    if (!Number.isFinite(t)) return;
                    const x = xScale.getPixelForValue(t);
                    const y = bar.y;
                    const half = Math.max(6, (bar.height || 14) / 2);
                    ctx.beginPath();
                    ctx.moveTo(x, y - half);
                    ctx.lineTo(x, y + half);
                    ctx.stroke();
                });
                ctx.restore();
            }
        };
    }

    function quadrantLabelPlugin() {
        return {
            id: 'quadrantLabels',
            afterDraw(chart) {
                const { ctx, chartArea } = chart;
                if (!chartArea) return;
                ctx.save();
                ctx.fillStyle = analyticsCss('--text-muted');
                ctx.font = '11px Inter';
                ctx.fillText('Overreach ⚠️', chartArea.left + 6, chartArea.top + 14);
                ctx.fillText('Hard + Ready ✓', chartArea.right - 95, chartArea.top + 14);
                ctx.fillText('Recovery ✓', chartArea.left + 6, chartArea.bottom - 8);
                ctx.fillText('Undertrained', chartArea.right - 80, chartArea.bottom - 8);
                ctx.restore();
            }
        };
    }

    function donutCenterPlugin(labelText) {
        return {
            id: 'donutCenter',
            afterDraw(chart) {
                const meta = chart.getDatasetMeta(0);
                if (!meta?.data?.length) return;
                const arc = meta.data[0];
                const { x, y } = arc;
                const ctx = chart.ctx;
                ctx.save();
                ctx.fillStyle = analyticsCss('--text-main');
                ctx.font = '600 16px Inter';
                ctx.textAlign = 'center';
                ctx.fillText(String(labelText), x, y + 5);
                ctx.restore();
            }
        };
    }

    function ensureAccordionState() {
        const daily = document.getElementById('analytics-daily-body');
        const weekly = document.getElementById('analytics-weekly-body');
        const monthly = document.getElementById('analytics-monthly-body');
        if (daily && !daily.style.maxHeight) daily.style.maxHeight = daily.scrollHeight + 'px';
        if (weekly && !weekly.style.maxHeight) weekly.style.maxHeight = '0px';
        if (monthly && !monthly.style.maxHeight) monthly.style.maxHeight = '0px';
    }

    function openDailyAccordion() {
        const daily = document.getElementById('analytics-daily-body');
        if (daily) daily.style.maxHeight = daily.scrollHeight + 'px';
    }

    function renderDailyView() {
        const wrap = document.getElementById('analytics-daily-content');
        if (!wrap) return;
        const selectedDate = analyticsState.dailyDate || getLatestAnalyticsDate();
        analyticsState.dailyDate = selectedDate;
        const day = getDayData(selectedDate);
        const running = runningSessionForDay(day.sessions);
        const lifting = liftingSessionForDay(day.sessions);
        const cardList = [];

        cardList.push(`
            <div class="card">
                <div class="analytics-controls">
                    <h3 style="font-size:1rem; margin:0; color:var(--text-main);">Daily Analytics</h3>
                    <input type="date" id="analytics-daily-date" value="${escapeHtml(selectedDate)}" style="max-width:220px; min-height:36px; padding:8px 10px;">
                </div>
            </div>
        `);

        if (running && (running.running?.splits || []).length >= 1) {
            cardList.push(`<div class="card">${sectionTitle(`Split Breakdown — ${running.title || 'Running Session'}`)}${chartCanvasBlock('analytics-split-waterfall')}</div>`);
        } else {
            cardList.push(analyticsEmptyState('1 running'));
        }

        if (running && (running.running?.splits || []).length >= 2) {
            cardList.push(`<div class="card">${sectionTitle('Running: Speed Curve')}${chartCanvasBlock('analytics-speed-curve')}</div>`);
        } else {
            cardList.push(analyticsEmptyState('2 running'));
        }

        const todayKinCount = (running?.running?.splits || []).filter((s) => s?.kinematics).length;
        if (todayKinCount >= 1) {
            cardList.push(`<div class="card">${sectionTitle('Running: Kinematics Radar')}${chartCanvasBlock('analytics-kin-radar')}</div>`);
        } else {
            cardList.push(analyticsEmptyState('1 running with kinematics'));
        }

        if (lifting) {
            cardList.push(`<div class="card">${sectionTitle('Strength vs Personal Best')}${chartCanvasBlock('analytics-e1rm-gauge')}</div>`);
            cardList.push(`<div class="card">${sectionTitle('Loading Profile')}${chartCanvasBlock('analytics-set-load')}</div>`);
        } else {
            cardList.push(analyticsEmptyState('1 weightlifting'));
            cardList.push(analyticsEmptyState('1 weightlifting'));
        }

        const hasPeakPower = (lifting?.lifting?.exercises || []).some((ex) => (ex?.sets || []).some((set) => (Number(set?.peakPower) || 0) > 0));
        if (lifting && hasPeakPower) {
            cardList.push(`<div class="card">${sectionTitle('Peak Power Output')}${chartCanvasBlock('analytics-peak-power')}</div>`);
        } else {
            cardList.push(analyticsEmptyState('1 weightlifting with power'));
        }

        if (day.measurement) {
            cardList.push('<div class="card" id="analytics-daily-summary"></div>');
        } else {
            cardList.push(analyticsEmptyState('1 measurement'));
        }

        wrap.innerHTML = `<div class="analytics-grid">${cardList.join('')}</div>`;
        const dateInput = document.getElementById('analytics-daily-date');
        if (dateInput) {
            dateInput.addEventListener('change', (e) => {
                analyticsState.dailyDate = e.target.value || getLatestAnalyticsDate();
                renderDailyView();
                setTimeout(openDailyAccordion, 0);
            });
        }

        renderDailyCharts(day, running, lifting);
        renderDailySummaryCard(day);
        setTimeout(openDailyAccordion, 0);
    }

    function renderDailyCharts(day, running, lifting) {
        destroyAnalyticsChart('splitWaterfall');
        destroyAnalyticsChart('speedCurve');
        destroyAnalyticsChart('kinRadar');
        destroyAnalyticsChart('e1rmGauge');
        destroyAnalyticsChart('setLoad');
        destroyAnalyticsChart('peakPower');
        ['rmssd', 'sdnn', 'pnn50', 'meanHR'].forEach((k) => destroyAnalyticsChart(`spark-${k}`));

        if (running && (running.running?.splits || []).length >= 1) {
            const splits = (running.running?.splits || []).filter((s) => (Number(s?.distance) || 0) > 0 && (Number(s?.time) || 0) > 0);
            const avgPace = (Number(running.running?.totalTime) || 0) / ((Number(running.running?.totalDistance) || 1));
            const labels = splits.map((s, i) => s?.label || `Split ${i + 1}`);
            const data = splits.map((s) => Number(s?.time) || 0);
            const avgTimes = splits.map((s) => avgPace * (Number(s?.distance) || 0));
            const colors = splits.map((s) => {
                const pace = (Number(s?.time) || 0) / Math.max(1, (Number(s?.distance) || 0));
                const ratio = avgPace > 0 ? pace / avgPace : 1;
                if (ratio <= 0.95) return analyticsCss('--success');
                if (ratio <= 1.05) return analyticsCss('--accent');
                if (ratio > 1.2) return analyticsCss('--danger');
                return analyticsCss('--warning');
            });
            const ctx = document.getElementById('analytics-split-waterfall');
            if (ctx) {
                analyticsCharts.splitWaterfall = new Chart(ctx, {
                    type: 'bar',
                    data: { labels, datasets: [{ data, backgroundColor: colors }] },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: (c) => {
                                        const s = splits[c.dataIndex] || {};
                                        const dist = Number(s?.distance) || 0;
                                        const secs = Number(s?.time) || 0;
                                        const pacePerKm = dist > 0 ? (secs / dist) * 1000 : 0;
                                        const speed = secs > 0 ? (dist / secs) * 3.6 : 0;
                                        return `${labels[c.dataIndex]} • ${formatDistanceHuman(dist)} • ${formatMMSS(secs)} • ${formatMMSS(pacePerKm)}/km • ${formatKmh(speed)}`;
                                    }
                                }
                            }
                        },
                        scales: {
                            x: { title: { display: true, text: 'Time (s)' } },
                            y: { ticks: { color: analyticsCss('--text-main') } }
                        }
                    },
                    plugins: [splitAvgMarkerPlugin(avgTimes)]
                });
            }
        }

        if (running && (running.running?.splits || []).length >= 2) {
            const splits = (running.running?.splits || []).filter((s) => (Number(s?.distance) || 0) > 0 && (Number(s?.time) || 0) > 0);
            let cum = 0;
            const xVals = splits.map((s) => {
                cum += Number(s?.distance) || 0;
                return cum;
            });
            const yVals = splits.map((s) => ((Number(s?.distance) || 0) / Math.max(1, Number(s?.time) || 0)) * 3.6);
            const avgSpeed = ((Number(running.running?.totalDistance) || 0) / Math.max(1, Number(running.running?.totalTime) || 0)) * 3.6;
            const ctx = document.getElementById('analytics-speed-curve');
            if (ctx) {
                analyticsCharts.speedCurve = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: xVals,
                        datasets: [{
                            label: 'Speed',
                            data: yVals,
                            borderColor: analyticsCss('--accent'),
                            backgroundColor: analyticsCss('--accent-dim'),
                            fill: true,
                            tension: 0.25,
                            pointRadius: 3
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            analyticsRefLines: { lines: [{ axis: 'y', value: avgSpeed, dash: [6, 4] }] },
                            tooltip: {
                                callbacks: {
                                    label: (c) => {
                                        const s = splits[c.dataIndex] || {};
                                        return `Dist ${formatDistanceHuman(xVals[c.dataIndex])} • ${formatKmh(c.parsed.y)} • ${formatMMSS(s?.time || 0)}`;
                                    }
                                }
                            }
                        },
                        scales: {
                            x: { title: { display: true, text: 'Cumulative Distance (m)' } },
                            y: { title: { display: true, text: 'Speed (km/h)' } }
                        }
                    },
                    plugins: [refLinePlugin()]
                });
            }
        }

        if (running && (running.running?.splits || []).some((s) => s?.kinematics)) {
            const todayKinSplits = (running.running?.splits || []).filter((s) => s?.kinematics);
            const avgMetric = (extractor) => {
                const vals = todayKinSplits.map((s) => Number(extractor(s?.kinematics)) || 0).filter((v) => v > 0);
                return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
            };
            const todayData = [
                avgMetric((k) => k?.gct),
                avgMetric((k) => k?.ft),
                avgMetric((k) => (Number(k?.sl) || 0) * 100),
                avgMetric((k) => {
                    const raw = Number(k?.sf) || 0;
                    return raw > 0 && raw <= 20 ? raw * 60 : raw;
                }),
                avgMetric((k) => k?.vo)
            ];
            const todayDist = Number(running.running?.totalDistance) || 0;
            const pbCandidate = (appState.sessions || [])
                .filter((s) => s?.type === 'running' && (s?.running?.splits || []).some((sp) => sp?.kinematics))
                .filter((s) => sessionIdValue(s) !== sessionIdValue(running))
                .sort((a, b) => {
                    const da = Math.abs((Number(a?.running?.totalDistance) || 0) - todayDist);
                    const db = Math.abs((Number(b?.running?.totalDistance) || 0) - todayDist);
                    if (da !== db) return da - db;
                    return (Number(a?.running?.totalTime) || Infinity) - (Number(b?.running?.totalTime) || Infinity);
                })[0];

            const datasets = [{
                label: 'Today',
                data: todayData,
                borderColor: analyticsCss('--accent'),
                backgroundColor: analyticsCss('--accent-dim')
            }];
            if (pbCandidate) {
                const pbKin = (pbCandidate.running?.splits || []).filter((s) => s?.kinematics);
                const avgPb = (extractor) => {
                    const vals = pbKin.map((s) => Number(extractor(s?.kinematics)) || 0).filter((v) => v > 0);
                    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
                };
                datasets.push({
                    label: 'Personal Best Session',
                    data: [
                        avgPb((k) => k?.gct),
                        avgPb((k) => k?.ft),
                        avgPb((k) => (Number(k?.sl) || 0) * 100),
                        avgPb((k) => {
                            const raw = Number(k?.sf) || 0;
                            return raw > 0 && raw <= 20 ? raw * 60 : raw;
                        }),
                        avgPb((k) => k?.vo)
                    ],
                    borderColor: analyticsCss('--warning'),
                    backgroundColor: 'transparent'
                });
            }
            const ctx = document.getElementById('analytics-kin-radar');
            if (ctx) {
                analyticsCharts.kinRadar = new Chart(ctx, {
                    type: 'radar',
                    data: {
                        labels: ['GCT (ms)', 'Flight Time (ms)', 'Stride Length (×100)', 'Stride Frequency (steps/min)', 'Vertical Oscillation (cm)'],
                        datasets
                    },
                    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true } } }
                });
            }
        }

        if (lifting) {
            const exercises = (lifting.lifting?.exercises || []).filter((ex) => (ex?.sets || []).length > 0);
            const rows = exercises.map((ex) => {
                const working = (ex.sets || []).filter((set) => (set?.type || 'working') !== 'warmup' && (Number(set?.load) || 0) > 0 && (Number(set?.reps) || 0) > 0);
                const best = working.reduce((m, set) => Math.max(m, (Number(set.load) || 0) * (1 + (Number(set.reps) || 0) / 30)), 0);
                const pb = Number(appState.personalBests?.gym?.[ex.name]?.e1rm) || 0;
                const pct = pb > 0 ? (best / pb) * 100 : 100;
                return { exercise: ex.name || 'Exercise', best, pb, pct, workingSets: working.length };
            }).filter((r) => r.best > 0);
            if (rows.length) {
                const ctx = document.getElementById('analytics-e1rm-gauge');
                if (ctx) {
                    analyticsCharts.e1rmGauge = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: rows.map((r) => r.exercise),
                            datasets: [{
                                data: rows.map((r) => Math.min(110, r.pct)),
                                backgroundColor: rows.map((r) => r.pct >= 95 ? analyticsCss('--success') : r.pct >= 80 ? analyticsCss('--accent') : r.pct >= 65 ? analyticsCss('--warning') : analyticsCss('--danger'))
                            }]
                        },
                        options: {
                            indexAxis: 'y',
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                analyticsRefLines: { lines: [{ axis: 'x', value: 100, dash: [6, 4] }] },
                                tooltip: {
                                    callbacks: {
                                        label: (c) => {
                                            const r = rows[c.dataIndex];
                                            return `${r.exercise}: today e1RM ${formatKg(r.best)} = ${r.pct.toFixed(1)}% of PB ${formatKg(r.pb || r.best)}`;
                                        }
                                    }
                                }
                            },
                            scales: { x: { min: 0, max: 110, ticks: { callback: (v) => `${v}%` } } }
                        },
                        plugins: [refLinePlugin()]
                    });
                }
            }

            const limited = exercises.slice(0, 6);
            const maxSets = Math.max(1, ...limited.map((ex) => (ex?.sets || []).length));
            const setCtx = document.getElementById('analytics-set-load');
            if (setCtx && limited.length) {
                analyticsCharts.setLoad = new Chart(setCtx, {
                    type: 'line',
                    data: {
                        labels: Array.from({ length: maxSets }, (_, i) => i + 1),
                        datasets: limited.map((ex, i) => {
                            const sets = ex.sets || [];
                            return {
                                label: ex.name || `Exercise ${i + 1}`,
                                data: Array.from({ length: maxSets }, (_, idx) => Number(sets[idx]?.load) || null),
                                setTypes: Array.from({ length: maxSets }, (_, idx) => sets[idx]?.type || 'working'),
                                tension: 0.15,
                                pointRadius: 3
                            };
                        })
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { legend: { display: true } },
                        scales: {
                            x: { title: { display: true, text: 'Set Number' } },
                            y: { title: { display: true, text: 'Load (kg)' } }
                        },
                        elements: {
                            line: {
                                borderWidth: 2
                            }
                        }
                    }
                });
                analyticsCharts.setLoad.data.datasets.forEach((ds) => {
                    ds.segment = {
                        borderDash: (ctx) => {
                            const idx = ctx.p0DataIndex;
                            return ds.setTypes[idx] === 'warmup' ? [6, 4] : [];
                        }
                    };
                });
                analyticsCharts.setLoad.update();
            }

            const peakRows = [];
            (lifting.lifting?.exercises || []).forEach((ex) => {
                (ex?.sets || []).forEach((set, idx) => {
                    const p = Number(set?.peakPower) || 0;
                    if (p > 0) peakRows.push({ label: `${ex?.name || 'Exercise'} — Set ${idx + 1}`, power: p });
                });
            });
            if (peakRows.length) {
                const maxPower = Math.max(...peakRows.map((r) => r.power), 1);
                const ctx = document.getElementById('analytics-peak-power');
                if (ctx) {
                    analyticsCharts.peakPower = new Chart(ctx, {
                        type: 'bar',
                        data: {
                            labels: peakRows.map((r) => r.label),
                            datasets: [{
                                data: peakRows.map((r) => r.power),
                                backgroundColor: peakRows.map((r) => r.power >= maxPower * 0.9 ? analyticsCss('--success') : r.power >= maxPower * 0.7 ? analyticsCss('--accent') : analyticsCss('--danger'))
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                analyticsRefLines: { lines: [{ axis: 'y', value: maxPower * 0.9, dash: [6, 4] }] },
                                tooltip: { callbacks: { label: (c) => `${(Number(c.parsed.y) || 0).toFixed(1)} W` } }
                            },
                            scales: { y: { title: { display: true, text: 'Watts' } } }
                        },
                        plugins: [refLinePlugin()]
                    });
                }
            }
        }
    }

    function renderDailySummaryCard(day) {
        const host = document.getElementById('analytics-daily-summary');
        if (!host || !day?.measurement) return;
        const m = day.measurement;
        const readiness = Number(m?.readiness) || 0;
        const readinessColor = readiness >= 70 ? 'var(--success)' : readiness >= 40 ? 'var(--warning)' : 'var(--danger)';
        const rows = (appState.measurements || []).slice(-14);
        const selectedSession = (day.sessions || [])[0] || null;
        const loadUnits = getSessionLoadUnits(selectedSession);
        const sessionSummary = selectedSession ? `
            <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); font-size:0.85rem; color:var(--text-main);">
                <div><strong>${analyticsIconForType(selectedSession.type)} ${escapeHtml(selectedSession.title || 'Session')}</strong></div>
                <div style="display:flex; gap:8px; align-items:center; margin-top:4px;">
                    <span class="badge ${((Number(selectedSession?.rpe) || 0) >= 8) ? 'bg-red' : ((Number(selectedSession?.rpe) || 0) >= 5) ? 'bg-amber' : 'bg-green'}">RPE ${Number(selectedSession?.rpe) || 0}</span>
                    <span style="color:var(--text-muted);">Load Units: ${loadUnits.toFixed(1)}</span>
                </div>
            </div>
        ` : '';

        host.innerHTML = `
            ${sectionTitle('Daily HRV + Session Summary')}
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
                <div style="width:56px; height:56px; border-radius:50%; border:4px solid ${readinessColor}; display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--text-main);">${Math.round(readiness)}</div>
                <div style="font-size:0.9rem; color:var(--text-muted);">Readiness Score</div>
            </div>
            <div class="analytics-metric-grid">
                <div class="analytics-metric-card"><strong>${Math.round(Number(m?.rmssd) || 0)}</strong><div style="font-size:0.75rem; color:var(--text-muted);">RMSSD</div>${chartCanvasBlock('analytics-spark-rmssd')}</div>
                <div class="analytics-metric-card"><strong>${Math.round(Number(m?.sdnn) || 0)}</strong><div style="font-size:0.75rem; color:var(--text-muted);">SDNN</div>${chartCanvasBlock('analytics-spark-sdnn')}</div>
                <div class="analytics-metric-card"><strong>${(Number(m?.pnn50) || 0).toFixed(1)}</strong><div style="font-size:0.75rem; color:var(--text-muted);">pNN50</div>${chartCanvasBlock('analytics-spark-pnn50')}</div>
                <div class="analytics-metric-card"><strong>${Math.round(Number(m?.meanHR) || 0)}</strong><div style="font-size:0.75rem; color:var(--text-muted);">Mean HR</div>${chartCanvasBlock('analytics-spark-meanHR')}</div>
            </div>
            ${sessionSummary}
        `;
        ['rmssd', 'sdnn', 'pnn50', 'meanHR'].forEach((metric) => {
            const ctx = document.getElementById(`analytics-spark-${metric}`);
            if (!ctx) return;
            const pts = rows.map((x) => Number(x?.[metric]) || 0);
            analyticsCharts[`spark-${metric}`] = new Chart(ctx, {
                type: 'line',
                data: { labels: pts.map(() => ''), datasets: [{ data: pts, borderColor: analyticsCss('--accent'), backgroundColor: analyticsCss('--accent-dim'), fill: true, pointRadius: 0, tension: 0.35 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } }
            });
        });
    }

    function renderWeeklyView() {
        const host = document.getElementById('analytics-weekly-content');
        if (!host) return;
        const baseWeek = startOfISOWeek(addDays(new Date(), analyticsState.weekOffset * 7));
        const days = Array.from({ length: 7 }, (_, i) => addDays(baseWeek, i));
        const dayKeys = days.map((d) => formatDateKey(d));
        const weekNo = getISOWeekNumber(baseWeek);

        host.innerHTML = `
            <div class="analytics-grid">
                <div class="card analytics-controls">
                    <h3 style="font-size:1rem; margin:0; color:var(--text-main);">Week ${weekNo}</h3>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="nav-mini" id="analytics-prev-week">❮ Prev</button>
                        <button type="button" class="nav-mini" id="analytics-next-week">Next ❯</button>
                    </div>
                </div>
                <div class="card">${sectionTitle('Weekly Load & Readiness')}${chartCanvasBlock('analytics-week-load')}</div>
                <div class="card">${sectionTitle(`HRV Trend — Week ${weekNo}`)}${chartCanvasBlock('analytics-week-rmssd')}</div>
                <div class="card" id="analytics-week-speed-card"></div>
                <div class="card" id="analytics-week-volume-card"></div>
            </div>
        `;

        document.getElementById('analytics-prev-week')?.addEventListener('click', () => { analyticsState.weekOffset -= 1; renderWeeklyView(); setTimeout(() => { const b = document.getElementById('analytics-weekly-body'); if (b) b.style.maxHeight = b.scrollHeight + 'px'; }, 0); });
        document.getElementById('analytics-next-week')?.addEventListener('click', () => { analyticsState.weekOffset += 1; renderWeeklyView(); setTimeout(() => { const b = document.getElementById('analytics-weekly-body'); if (b) b.style.maxHeight = b.scrollHeight + 'px'; }, 0); });

        destroyAnalyticsChart('weeklyLoad');
        destroyAnalyticsChart('weeklyRmssd');
        destroyAnalyticsChart('weeklySpeedTrend');
        destroyAnalyticsChart('weeklyVolumeExercise');

        const sessionsByDay = dayKeys.map((key) => (appState.sessions || []).filter((s) => normalizeDate(s?.date) === key));
        const readinessByDay = dayKeys.map((key) => Number((appState.measurements || []).find((m) => normalizeDate(m?.date) === key)?.readiness) || 0);
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        const typeLoad = (type) => sessionsByDay.map((arr) => arr.filter((s) => (type === 'other' ? !['running', 'weightlifting'].includes(s?.type) : s?.type === type)).reduce((sum, s) => sum + getSessionLoadUnits(s), 0));
        const weekLoadCtx = document.getElementById('analytics-week-load');
        if (weekLoadCtx) {
            analyticsCharts.weeklyLoad = new Chart(weekLoadCtx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        { label: 'Running', data: typeLoad('running'), backgroundColor: analyticsCss('--accent'), stack: 'load' },
                        { label: 'Weightlifting', data: typeLoad('weightlifting'), backgroundColor: analyticsCss('--warning'), stack: 'load' },
                        { label: 'Other', data: typeLoad('other'), backgroundColor: analyticsCss('--text-muted'), stack: 'load' },
                        { label: 'Readiness', type: 'line', data: readinessByDay, borderColor: analyticsCss('--success'), yAxisID: 'y1', tension: 0.25, pointRadius: 3 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        tooltip: {
                            callbacks: {
                                afterLabel: (c) => {
                                    const daySessions = sessionsByDay[c.dataIndex] || [];
                                    const readiness = readinessByDay[c.dataIndex] || 0;
                                    if (!daySessions.length) return `Readiness: ${readiness}`;
                                    return `${daySessions.map((s) => `${s.title || 'Session'}: ${getSessionLoadUnits(s).toFixed(1)} LU`).join(' | ')} | Readiness: ${readiness}`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { stacked: true },
                        y: { stacked: true, title: { display: true, text: 'Load Units' } },
                        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Readiness' } }
                    }
                }
            });
        }

        const weekMeas = dayKeys.map((key) => (appState.measurements || []).find((m) => normalizeDate(m?.date) === key) || null);
        const rmssd = weekMeas.map((m) => Number(m?.rmssd) || null);
        const avg28 = (() => {
            const vals = (appState.measurements || []).slice(-28).map((m) => Number(m?.rmssd) || 0).filter((v) => v > 0);
            return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        })();
        const sessionMarkers = dayKeys.map((k, i) => {
            const daySessions = (appState.sessions || []).filter((s) => normalizeDate(s?.date) === k);
            if (!daySessions.length) return null;
            const rpe = Math.max(...daySessions.map((s) => Number(s?.rpe) || 0), 0);
            return { xLabel: labels[i], rpe };
        }).filter(Boolean);
        const weekRmssdCtx = document.getElementById('analytics-week-rmssd');
        if (weekRmssdCtx) {
            analyticsCharts.weeklyRmssd = new Chart(weekRmssdCtx, {
                type: 'line',
                data: { labels, datasets: [{ data: rmssd, borderColor: analyticsCss('--accent'), backgroundColor: analyticsCss('--accent-dim'), fill: true, tension: 0.25 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        analyticsRefLines: { lines: [{ axis: 'y', value: avg28, dash: [6, 4] }] },
                        tooltip: {
                            callbacks: {
                                label: (c) => {
                                    const m = weekMeas[c.dataIndex];
                                    const sess = sessionsByDay[c.dataIndex] || [];
                                    const sTxt = sess.length ? ` | ${sess.map((s) => s.title || s.type).join(', ')}` : '';
                                    return `RMSSD ${(Number(c.parsed.y) || 0).toFixed(1)} ms | Readiness ${Number(m?.readiness) || 0}${sTxt}`;
                                }
                            }
                        }
                    }
                },
                plugins: [
                    refLinePlugin(),
                    {
                        id: 'weeklySessionVerticals',
                        afterDraw(chart) {
                            const ctx = chart.ctx;
                            const area = chart.chartArea;
                            const xScale = chart.scales.x;
                            if (!ctx || !area || !xScale) return;
                            sessionMarkers.forEach((m) => {
                                const x = xScale.getPixelForValue(m.xLabel);
                                ctx.save();
                                ctx.strokeStyle = m.rpe >= 8 ? analyticsCss('--danger') : m.rpe >= 5 ? analyticsCss('--warning') : analyticsCss('--success');
                                ctx.setLineDash([4, 4]);
                                ctx.beginPath();
                                ctx.moveTo(x, area.top);
                                ctx.lineTo(x, area.bottom);
                                ctx.stroke();
                                ctx.restore();
                            });
                        }
                    }
                ]
            });
        }

        const speedCard = document.getElementById('analytics-week-speed-card');
        const running8w = (appState.sessions || []).filter((s) => s?.type === 'running' && (s?.running?.splits || []).length > 0 && (new Date(s.date) >= addDays(baseWeek, -7 * 7)));
        if (!speedCard) return;
        if (running8w.length < 2) {
            speedCard.innerHTML = analyticsEmptyState('2 running');
        } else {
            speedCard.innerHTML = `${sectionTitle('Speed Trend by Distance')}${chartCanvasBlock('analytics-week-speed-trend')}`;
            const standards = [100, 200, 400, 800, 1000, 1500, 3000, 5000, 10000];
            const weekStarts = Array.from({ length: 8 }, (_, i) => addDays(baseWeek, (i - 7) * 7));
            const weekLabels = weekStarts.map((d) => `W${getISOWeekNumber(d)}`);
            const distanceMap = new Map();
            running8w.forEach((s) => {
                const sw = startOfISOWeek(new Date(s.date || new Date()));
                const weekIdx = weekStarts.findIndex((w) => formatDateKey(w) === formatDateKey(sw));
                if (weekIdx < 0) return;
                (s.running?.splits || []).forEach((sp) => {
                    const dist = Number(sp?.distance) || 0;
                    const time = Number(sp?.time) || 0;
                    if (!dist || !time) return;
                    let nearest = null;
                    let err = Infinity;
                    standards.forEach((d) => {
                        const rel = Math.abs(dist - d) / d;
                        if (rel <= 0.02 && rel < err) { err = rel; nearest = d; }
                    });
                    if (!nearest) return;
                    const key = `${nearest}m`;
                    if (!distanceMap.has(key)) distanceMap.set(key, Array.from({ length: 8 }, () => ({ time: null, hasPb: false })));
                    const slot = distanceMap.get(key)[weekIdx];
                    if (slot.time == null || time < slot.time) {
                        slot.time = time;
                        slot.hasPb = !!s.hasPB;
                    }
                });
            });
            const selectedLines = [...distanceMap.entries()].sort((a, b) => b[1].filter((x) => x.time != null).length - a[1].filter((x) => x.time != null).length).slice(0, 5);
            const ctx = document.getElementById('analytics-week-speed-trend');
            if (ctx) {
                analyticsCharts.weeklySpeedTrend = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: weekLabels,
                        datasets: selectedLines.map(([distKey, pts]) => ({
                            label: distKey,
                            data: pts.map((p) => p.time),
                            pointStyle: pts.map((p) => p.hasPb ? 'star' : 'circle'),
                            pointRadius: pts.map((p) => p.hasPb ? 6 : 3),
                            spanGaps: true,
                            tension: 0.2
                        }))
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: { y: { reverse: true, title: { display: true, text: 'Best split time (s)' } } }
                    }
                });
            }
        }

        const volumeCard = document.getElementById('analytics-week-volume-card');
        const weekLifts = (appState.sessions || []).filter((s) => s?.type === 'weightlifting' && dayKeys.includes(normalizeDate(s?.date)));
        if (!volumeCard) return;
        if (!weekLifts.length) {
            volumeCard.innerHTML = analyticsEmptyState('1 weightlifting');
        } else {
            volumeCard.innerHTML = `${sectionTitle('Weekly Volume by Exercise')}${chartCanvasBlock('analytics-week-volume')}`;
            const volume = {};
            const setCount = {};
            weekLifts.forEach((s) => {
                (s.lifting?.exercises || []).forEach((ex) => {
                    const name = ex?.name || 'Exercise';
                    (ex?.sets || []).forEach((set) => {
                        if ((set?.type || 'working') === 'warmup') return;
                        const v = (Number(set?.reps) || 0) * (Number(set?.load) || 0);
                        volume[name] = (volume[name] || 0) + v;
                        setCount[name] = (setCount[name] || 0) + 1;
                    });
                });
            });
            const names = Object.keys(volume);
            const avg4 = {};
            names.forEach((name) => {
                let totals = [];
                for (let i = 0; i < 4; i++) {
                    const ws = startOfISOWeek(addDays(baseWeek, -i * 7));
                    const we = addDays(ws, 6);
                    const val = (appState.sessions || []).filter((s) => s?.type === 'weightlifting').filter((s) => {
                        const d = new Date(s.date || 0);
                        return d >= ws && d <= we;
                    }).reduce((sum, s) => {
                        return sum + (s.lifting?.exercises || []).filter((ex) => (ex?.name || 'Exercise') === name).reduce((inner, ex) => inner + (ex?.sets || []).reduce((setSum, set) => ((set?.type || 'working') === 'warmup' ? setSum : setSum + (Number(set?.reps) || 0) * (Number(set?.load) || 0)), 0), 0);
                    }, 0);
                    totals.push(val);
                }
                avg4[name] = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
            });
            const ctx = document.getElementById('analytics-week-volume');
            if (ctx) {
                analyticsCharts.weeklyVolumeExercise = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: names,
                        datasets: [{
                            data: names.map((n) => volume[n]),
                            backgroundColor: names.map((n) => (volume[n] > (avg4[n] || 0) ? analyticsCss('--success') : analyticsCss('--accent')))
                        }]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                callbacks: {
                                    label: (c) => `${names[c.dataIndex]}: ${(Number(c.parsed.x) || 0).toFixed(1)} kg • ${setCount[names[c.dataIndex]] || 0} working sets`
                                }
                            }
                        }
                    }
                });
            }
        }

    }

    function renderMonthlyView() {
        const host = document.getElementById('analytics-monthly-content');
        if (!host) return;
        const base = new Date();
        const monthDate = new Date(base.getFullYear(), base.getMonth() + analyticsState.monthOffset, 1);
        const year = monthDate.getFullYear();
        const month = monthDate.getMonth();
        const monthLabel = monthDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });

        host.innerHTML = `
            <div class="analytics-grid">
                <div class="card analytics-controls">
                    <h3 style="font-size:1rem; margin:0; color:var(--text-main);">${monthLabel}</h3>
                    <div style="display:flex; gap:8px;">
                        <button type="button" class="nav-mini" id="analytics-prev-month">❮ Prev</button>
                        <button type="button" class="nav-mini" id="analytics-next-month">Next ❯</button>
                    </div>
                </div>
                <div class="card" id="analytics-month-heatmap"></div>
                <div class="card">${sectionTitle('Monthly Load Periodization')}${chartCanvasBlock('analytics-month-load')}</div>
                <div class="card" id="analytics-month-e1rm-card"></div>
                <div class="card" id="analytics-month-running-card"></div>
                <div class="card">${sectionTitle('Volume Load & Strength Trend')}${chartCanvasBlock('analytics-month-volume-strength')}</div>
                <div class="card">${sectionTitle('Session Distribution')}${chartCanvasBlock('analytics-month-distribution')}</div>
            </div>
        `;
        document.getElementById('analytics-prev-month')?.addEventListener('click', () => { analyticsState.monthOffset -= 1; renderMonthlyView(); setTimeout(() => { const b = document.getElementById('analytics-monthly-body'); if (b) b.style.maxHeight = b.scrollHeight + 'px'; }, 0); });
        document.getElementById('analytics-next-month')?.addEventListener('click', () => { analyticsState.monthOffset += 1; renderMonthlyView(); setTimeout(() => { const b = document.getElementById('analytics-monthly-body'); if (b) b.style.maxHeight = b.scrollHeight + 'px'; }, 0); });

        ['monthLoad', 'monthE1rm', 'monthRunPr', 'monthVolumeStrength', 'monthDistribution'].forEach((k) => destroyAnalyticsChart(k));

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const daysInMonth = lastDay.getDate();
        const monthSessions = (appState.sessions || []).filter((s) => {
            const d = new Date(s?.date || 0);
            return d.getFullYear() === year && d.getMonth() === month;
        });
        const monthMeasurements = (appState.measurements || []).filter((m) => {
            const d = new Date(m?.date || 0);
            return d.getFullYear() === year && d.getMonth() === month;
        });

        const heatmap = document.getElementById('analytics-month-heatmap');
        if (heatmap) {
            const weekdayShift = (firstDay.getDay() + 6) % 7;
            let cellHtml = '';
            for (let i = 0; i < weekdayShift; i++) cellHtml += `<div class="analytics-heatmap-cell empty"></div>`;
            for (let d = 1; d <= daysInMonth; d++) {
                const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const m = monthMeasurements.find((x) => normalizeDate(x?.date) === dateKey);
                const daySessions = monthSessions.filter((s) => normalizeDate(s?.date) === dateKey);
                const readiness = Number(m?.readiness) || 0;
                const bg = m ? `oklch(from var(--success) l c h / ${Math.max(0, Math.min(1, readiness / 100)).toFixed(2)})` : 'var(--card)';
                const icon = daySessions.length ? analyticsIconForType(daySessions[0]?.type) : '○';
                const hasPb = daySessions.some((s) => s?.hasPB);
                cellHtml += `
                    <button type="button" class="analytics-heatmap-cell" data-analytics-date="${dateKey}" style="background:${bg};">
                        <span style="font-size:11px; color:var(--text-main);">${d}</span>
                        ${hasPb ? '<span class="pb-star">★</span>' : ''}
                        <span style="position:absolute; right:4px; bottom:2px; font-size:10px; color:var(--text-muted);">${icon}</span>
                    </button>
                `;
            }
            heatmap.innerHTML = `
                ${sectionTitle('Monthly Calendar Heatmap')}
                <div class="analytics-heatmap-grid">
                    <div class="cal-header">Mon</div><div class="cal-header">Tue</div><div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div><div class="cal-header">Sun</div>
                </div>
                <div class="analytics-heatmap-grid" style="margin-top:4px;">${cellHtml}</div>
                <div style="margin-top:8px;">
                    <div class="analytics-heatmap-legend"></div>
                    <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-muted); margin-top:4px;"><span>Low</span><span>High readiness</span></div>
                </div>
            `;
            heatmap.querySelectorAll('[data-analytics-date]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    analyticsState.dailyDate = btn.getAttribute('data-analytics-date');
                    renderDailyView();
                    openDailyAccordion();
                    const dailySection = document.querySelector('.analytics-section');
                    if (dailySection) dailySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });
        }

        const weekBucketCount = Math.ceil(daysInMonth / 7);
        const weekLabels = Array.from({ length: weekBucketCount }, (_, i) => `Week ${i + 1}`);
        const weekLoads = Array.from({ length: weekBucketCount }, () => 0);
        monthSessions.forEach((s) => {
            const day = new Date(s.date || 0).getDate();
            const idx = Math.min(weekBucketCount - 1, Math.floor((day - 1) / 7));
            weekLoads[idx] += getSessionLoadUnits(s);
        });
        const last4WeeksStart = startOfISOWeek(addDays(lastDay, -21));
        const rolling4 = [];
        for (let i = 0; i < 4; i++) {
            const ws = addDays(last4WeeksStart, i * 7);
            const we = addDays(ws, 6);
            rolling4.push((appState.sessions || []).filter((s) => {
                const d = new Date(s?.date || 0);
                return d >= ws && d <= we;
            }).reduce((sum, s) => sum + getSessionLoadUnits(s), 0));
        }
        const avg4Load = rolling4.length ? rolling4.reduce((a, b) => a + b, 0) / rolling4.length : 0;
        const monthLoadCtx = document.getElementById('analytics-month-load');
        if (monthLoadCtx) {
            analyticsCharts.monthLoad = new Chart(monthLoadCtx, {
                type: 'bar',
                data: {
                    labels: weekLabels,
                    datasets: [{
                        data: weekLoads,
                        backgroundColor: weekLoads.map((v) => v > avg4Load * 1.3 ? analyticsCss('--danger') : v < avg4Load * 0.6 ? analyticsCss('--text-muted') : analyticsCss('--accent'))
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, analyticsRefLines: { lines: [{ axis: 'y', value: avg4Load }] } },
                    scales: { y: { title: { display: true, text: 'Load Units' } } }
                },
                plugins: [refLinePlugin()]
            });
        }

        const e1rmCard = document.getElementById('analytics-month-e1rm-card');
        const lifts90 = (appState.sessions || []).filter((s) => s?.type === 'weightlifting' && new Date(s?.date || 0) >= addDays(new Date(), -90));
        if (!e1rmCard) return;
        if (lifts90.length < 2) {
            e1rmCard.innerHTML = analyticsEmptyState('2 weightlifting');
        } else {
            const exKeys = Object.keys(appState.personalBests?.gym || {}).slice(0, 6);
            e1rmCard.innerHTML = `${sectionTitle('Strength Progression — 90 Days')}${chartCanvasBlock('analytics-month-e1rm')}`;
            const datasets = exKeys.map((ex) => {
                const points = lifts90.map((s) => {
                    const exObj = (s.lifting?.exercises || []).find((e) => e?.name === ex);
                    if (!exObj) return null;
                    const best = (exObj.sets || []).filter((set) => (set?.type || 'working') !== 'warmup').reduce((m, set) => Math.max(m, (Number(set?.load) || 0) * (1 + (Number(set?.reps) || 0) / 30)), 0);
                    if (!best) return null;
                    return { x: normalizeDate(s?.date), y: best, hasPb: !!s?.hasPB };
                }).filter(Boolean);
                return {
                    label: ex,
                    data: points,
                    tension: 0.2,
                    spanGaps: true,
                    pointStyle: points.map((p) => p.hasPb ? 'star' : 'circle'),
                    pointRadius: points.map((p) => p.hasPb ? 6 : 3)
                };
            }).filter((ds) => ds.data.length > 0);
            const lines = exKeys.map((ex) => ({ axis: 'y', value: Number(appState.personalBests?.gym?.[ex]?.e1rm) || 0, dash: [4, 4] })).filter((l) => l.value > 0);
            const ctx = document.getElementById('analytics-month-e1rm');
            if (ctx) {
                const labels = Array.from(new Set(datasets.flatMap((ds) => ds.data.map((p) => p.x))));
                datasets.forEach((ds) => {
                    const byDate = new Map(ds.data.map((p) => [p.x, p]));
                    ds.data = labels.map((lbl) => byDate.get(lbl)?.y ?? null);
                    ds.pointStyle = labels.map((lbl) => byDate.get(lbl)?.hasPb ? 'star' : 'circle');
                    ds.pointRadius = labels.map((lbl) => byDate.get(lbl)?.hasPb ? 6 : 3);
                });
                analyticsCharts.monthE1rm = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: { analyticsRefLines: { lines } },
                        scales: {
                            x: { ticks: { maxRotation: 0, autoSkip: true } },
                            y: { title: { display: true, text: 'e1RM (kg)' } }
                        }
                    },
                    plugins: [refLinePlugin()]
                });
            }
        }

        const runCard = document.getElementById('analytics-month-running-card');
        const run90 = (appState.sessions || []).filter((s) => s?.type === 'running' && new Date(s?.date || 0) >= addDays(new Date(), -90) && !!s?.hasPB && (s?.running?.splits || []).length > 0);
        if (!runCard) return;
        if (run90.length < 2) {
            runCard.innerHTML = analyticsEmptyState('2 running');
        } else {
            const trackKeys = Object.keys(appState.personalBests?.track || {}).slice(0, 5);
            runCard.innerHTML = `${sectionTitle('Speed Progression by Distance — 90 Days')}${chartCanvasBlock('analytics-month-running')}`;
            const distanceToMeters = (k) => {
                if (k === '1 Mile') return 1609;
                const n = parseFloat(String(k).replace('m', ''));
                return Number.isFinite(n) ? n : 0;
            };
            const datasets = trackKeys.map((k) => {
                const target = distanceToMeters(k);
                const points = run90.map((s) => {
                    let best = null;
                    (s.running?.splits || []).forEach((sp) => {
                        const dist = Number(sp?.distance) || 0;
                        const time = Number(sp?.time) || 0;
                        if (!dist || !time || !target) return;
                        if (Math.abs(dist - target) / target <= 0.02 && (best == null || time < best)) best = time;
                    });
                    if (best == null) return null;
                    return { x: normalizeDate(s?.date), y: best, hasPb: !!s?.hasPB };
                }).filter(Boolean);
                return { label: k, data: points, spanGaps: true, tension: 0.15, pointStyle: points.map((p) => p.hasPb ? 'star' : 'circle'), pointRadius: points.map((p) => p.hasPb ? 6 : 3) };
            }).filter((d) => d.data.length > 0);
            const ctx = document.getElementById('analytics-month-running');
            if (ctx) {
                const labels = Array.from(new Set(datasets.flatMap((ds) => ds.data.map((p) => p.x))));
                datasets.forEach((ds) => {
                    const byDate = new Map(ds.data.map((p) => [p.x, p]));
                    ds.data = labels.map((lbl) => byDate.get(lbl)?.y ?? null);
                    ds.pointStyle = labels.map((lbl) => byDate.get(lbl)?.hasPb ? 'star' : 'circle');
                    ds.pointRadius = labels.map((lbl) => byDate.get(lbl)?.hasPb ? 6 : 3);
                });
                analyticsCharts.monthRunPr = new Chart(ctx, {
                    type: 'line',
                    data: { labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: { ticks: { maxRotation: 0, autoSkip: true } },
                            y: { reverse: true, ticks: { callback: (v) => formatMMSS(v) } }
                        }
                    }
                });
            }
        }

        const weeks12 = Array.from({ length: 12 }, (_, i) => startOfISOWeek(addDays(new Date(), (i - 11) * 7)));
        const labels12 = weeks12.map((w) => `W${getISOWeekNumber(w)}`);
        const volume12 = [];
        const avgE1rm12 = [];
        weeks12.forEach((ws) => {
            const we = addDays(ws, 6);
            const lifts = (appState.sessions || []).filter((s) => s?.type === 'weightlifting').filter((s) => {
                const d = new Date(s?.date || 0);
                return d >= ws && d <= we;
            });
            let totalVol = 0;
            const e1rmVals = [];
            lifts.forEach((s) => {
                (s.lifting?.exercises || []).forEach((ex) => {
                    let exBest = 0;
                    (ex?.sets || []).forEach((set) => {
                        if ((set?.type || 'working') !== 'warmup') {
                            totalVol += (Number(set?.reps) || 0) * (Number(set?.load) || 0);
                            exBest = Math.max(exBest, (Number(set?.load) || 0) * (1 + (Number(set?.reps) || 0) / 30));
                        }
                    });
                    if (exBest > 0) e1rmVals.push(exBest);
                });
            });
            volume12.push(totalVol);
            avgE1rm12.push(e1rmVals.length ? e1rmVals.reduce((a, b) => a + b, 0) / e1rmVals.length : null);
        });
        const volAvg4 = volume12.slice(-4).reduce((a, b) => a + b, 0) / Math.max(1, volume12.slice(-4).length);
        const volCtx = document.getElementById('analytics-month-volume-strength');
        if (volCtx) {
            analyticsCharts.monthVolumeStrength = new Chart(volCtx, {
                data: {
                    labels: labels12,
                    datasets: [
                        {
                            type: 'bar',
                            label: 'Volume Load',
                            data: volume12,
                            backgroundColor: volume12.map((v) => v > volAvg4 * 1.3 ? analyticsCss('--danger') : v < volAvg4 * 0.6 ? analyticsCss('--text-muted') : analyticsCss('--accent'))
                        },
                        { type: 'line', label: 'Avg e1RM', data: avgE1rm12, borderColor: analyticsCss('--warning'), yAxisID: 'y1', tension: 0.2 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: { title: { display: true, text: 'Volume (kg)' } },
                        y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Avg e1RM (kg)' } }
                    }
                }
            });
        }

        const countRunning = monthSessions.filter((s) => s?.type === 'running').length;
        const countLifting = monthSessions.filter((s) => s?.type === 'weightlifting').length;
        const countOther = monthSessions.filter((s) => !['running', 'weightlifting'].includes(s?.type)).length;
        const sessionDays = new Set(monthSessions.map((s) => normalizeDate(s?.date)).filter(Boolean));
        const restDays = Math.max(0, daysInMonth - sessionDays.size);
        const distCtx = document.getElementById('analytics-month-distribution');
        if (distCtx) {
            analyticsCharts.monthDistribution = new Chart(distCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Running', 'Weightlifting', 'Other', 'Rest Days'],
                    datasets: [{
                        data: [countRunning, countLifting, countOther, restDays],
                        backgroundColor: [analyticsCss('--accent'), analyticsCss('--warning'), analyticsCss('--text-muted'), analyticsCss('--border')]
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
                plugins: [donutCenterPlugin(monthSessions.length)]
            });
        }
    }

    function renderAnalytics() {
        const view = document.getElementById('analytics-content');
        if (!view) return;
        if (!currentUser) {
            view.innerHTML = '<p>Sign in to see analytics.</p>';
            return;
        }
        if (appState.sessions.length === 0 && appState.measurements.length === 0) {
            view.innerHTML = '<p>No data yet. Log a session or measurement to get started.</p>';
            return;
        }
        Chart.defaults.color = analyticsCss('--text-muted');
        Chart.defaults.borderColor = analyticsCss('--border');
        Chart.defaults.font.family = 'Inter';
        Chart.defaults.font.size = 12;
        if (!analyticsState.dailyDate) analyticsState.dailyDate = getLatestAnalyticsDate();
        destroyAllAnalyticsCharts();
        view.innerHTML = `
            <div class="analytics-section">
                <button type="button" class="accordion-toggle" onclick="toggleAccordion('analytics-daily-body')"><span>Daily</span><span>▾</span></button>
                <div id="analytics-daily-body" class="accordion-body"><div id="analytics-daily-content"></div></div>
            </div>
            <div class="analytics-section">
                <button type="button" class="accordion-toggle" onclick="toggleAccordion('analytics-weekly-body')"><span>Weekly</span><span>▾</span></button>
                <div id="analytics-weekly-body" class="accordion-body"><div id="analytics-weekly-content"></div></div>
            </div>
            <div class="analytics-section">
                <button type="button" class="accordion-toggle" onclick="toggleAccordion('analytics-monthly-body')"><span>Monthly</span><span>▾</span></button>
                <div id="analytics-monthly-body" class="accordion-body"><div id="analytics-monthly-content"></div></div>
            </div>
        `;
        renderDailyView();
        renderWeeklyView();
        renderMonthlyView();
        ensureAccordionState();
    }
    window.renderAnalytics = renderAnalytics;
