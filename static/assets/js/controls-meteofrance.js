// controls-meteofrance.js — issu du découpage de controls.js (Phase 3).
// Préchargement/quota/automation serveur MeteoFrance + setupPrimaryControls (init). Script classique, chargé après les 2 autres.
    function setMeteoFranceTestStatus(message, state = '') {
      if (!mfTestStatus) return;
      mfTestStatus.classList.remove('is-ok', 'is-error', 'is-waiting');
      if (state) mfTestStatus.classList.add(`is-${state}`);
      mfTestStatus.textContent = message;
    }

    function meteoFranceSlotKeyFromHour(hour) {
      const value = Number(hour);
      if (!Number.isFinite(value) || value < 0 || value > 23) return null;
      return `h${String(Math.trunc(value)).padStart(2, '0')}`;
    }

    function meteoFranceCoverageForSelectedDate(status) {
      const coverages = Array.isArray(status?.coverage) ? status.coverage : [];
      const selectedDate = normalizeDateIso(selectedBaseDate);
      return coverages.find((item) => normalizeDateIso(item?.date) === selectedDate) || null;
    }

    function meteoFranceCachedSlotKeysFromCoverage(coverage) {
      const hours = Array.isArray(coverage?.cached_hours) ? coverage.cached_hours : [];
      return hours.map(meteoFranceSlotKeyFromHour).filter(Boolean);
    }

    function meteoFranceAvailableSlotKeysFromCoverage(coverage) {
      const hours = Array.isArray(coverage?.available_hours) ? coverage.available_hours : null;
      if (!hours) return null;
      return hours.map(meteoFranceSlotKeyFromHour).filter(Boolean);
    }

    function updateMeteoFranceCacheStatusFromAutomation(status, { hydrate = true } = {}) {
      const coverages = Array.isArray(status?.coverage) ? status.coverage : [];
      for (const item of coverages) {
        const itemDate = normalizeDateIso(item?.date);
        const itemCachedKeys = meteoFranceCachedSlotKeysFromCoverage(item);
        const itemAvailableKeys = meteoFranceAvailableSlotKeysFromCoverage(item);
        if (typeof rememberMeteoFranceGribCacheStatus === 'function' && itemCachedKeys.length) {
          rememberMeteoFranceGribCacheStatus(itemDate, itemCachedKeys);
        }
        if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && itemAvailableKeys) {
          rememberMeteoFranceGribAvailabilityStatus(itemDate, itemAvailableKeys);
        }
      }
      const coverage = meteoFranceCoverageForSelectedDate(status);
      if (!coverage) return false;
      const cachedKeys = meteoFranceCachedSlotKeysFromCoverage(coverage);
      const availableKeys = meteoFranceAvailableSlotKeysFromCoverage(coverage);
      const availabilityKey = availableKeys ? availableKeys.join(',') : 'unknown';
      const nextKey = `${normalizeDateIso(coverage.date)}|${cachedKeys.join(',')}|${availabilityKey}|${Number(coverage.ok_count || 0)}/${Number(coverage.hour_count || 24)}`;
      if (nextKey === mfServerAutomationLastCoverageKey) return false;
      mfServerAutomationLastCoverageKey = nextKey;
      meteoFranceGribCachedSlotKeys = new Set(cachedKeys);
      meteoFranceGribAvailableSlotKeys = availableKeys ? new Set(availableKeys) : null;
      if (typeof rememberMeteoFranceGribCacheStatus === 'function' && cachedKeys.length) {
        rememberMeteoFranceGribCacheStatus(normalizeDateIso(coverage.date), cachedKeys);
      }
      if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && availableKeys) {
        rememberMeteoFranceGribAvailabilityStatus(normalizeDateIso(coverage.date), availableKeys);
      }
      const day = getCurrentDay();
      if (day && typeof isMeteoFranceSlotUnavailable === 'function') {
        const selectedSlot = getRenderableSlots(day).find((slot) => slot?.slot_key === selectedSlotKey);
        if (selectedSlot && isMeteoFranceSlotUnavailable(selectedSlot, day)) {
          selectedSlotKey = (typeof getSelectableSlots === 'function' ? getSelectableSlots(day)[0]?.slot_key : null) || selectedSlotKey;
          closeSelection();
          closeDetails();
        }
      }
      renderSlotButtons();
      if (hydrate && cachedKeys.length) {
        hydrateMeteoFranceGribFranceDayFromCache({ force: false });
        maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true, force: true, buildFromNationalCache: false });
      }
      return true;
    }

    function summarizeMeteoFranceAutomationStatus(status) {
      const state = status?.state || {};
      const coverage = meteoFranceCoverageForSelectedDate(status);
      const cooldownSeconds = Number(status?.quota_cooldown_seconds || state?.quota_cooldown_seconds || 0);
      const cache = status?.config?.cache_dir_status || {};
      const parts = [];
      if (coverage) {
        const ok = Number(coverage.ok_count || 0);
        const total = Number(coverage.hour_count || 24);
        const calendarTotal = Number(coverage.calendar_hour_count || 24);
        const missing = Array.isArray(coverage.missing_hours) ? coverage.missing_hours.length : Math.max(0, total - ok);
        const availabilityText = coverage.partial_availability ? ` · publié ${total}/${calendarTotal}h` : '';
        parts.push(`cache ${ok}/${total}h${missing ? `, ${missing} manquante(s)` : ''}${availabilityText}`);
      }
      if (cooldownSeconds > 0) parts.push(`quota ${formatMeteoFranceCooldown(cooldownSeconds)}`);
      if (state.running) parts.push('automation active');
      if (cache.writable === false) parts.push('cache disque non inscriptible');
      return parts.join(' · ');
    }

    function syncMeteoFranceServerAutomationStatus(status, { quiet = true } = {}) {
      if (!status?.ok) return false;
      syncMeteoFranceQuotaCooldown(status);
      const state = status.state || {};
      const currentJob = state.current_job && typeof state.current_job === 'object' ? state.current_job : null;
      if (currentJob?.job_key && currentJob.running) {
        trackMeteoFrancePreload({ progress: currentJob, already_running: true });
      } else if (currentJob?.job_key && currentJob.job_key !== mfPreloadActiveJobKey) {
        // Le serveur a avancé sur un AUTRE job (jour suivant) déjà terminé — typiquement
        // servi depuis le cache, donc 100% instantané sans état "running". On bascule
        // l'affichage dessus pour ne pas rester figé sur le jour précédent. Aucun polling
        // à relancer (le job est fini), mais on adopte sa clé pour rester cohérent.
        stopMeteoFrancePreloadPolling();
        mfPreloadActiveJobKey = currentJob.job_key;
        renderMeteoFrancePreloadProgress(currentJob);
      } else if (currentJob?.job_key && !mfPreloadActiveJobKey) {
        renderMeteoFrancePreloadProgress(currentJob);
      }
      updateMeteoFranceCacheStatusFromAutomation(status, { hydrate: true });
      const summary = summarizeMeteoFranceAutomationStatus(status);
      const message = String(state.message || '').trim();
      const nextMessage = message && summary ? `${message} (${summary})` : (message || summary);
      if (!quiet && nextMessage) {
        setMeteoFranceTestStatus(nextMessage, state.running ? 'waiting' : '');
      } else if (nextMessage && nextMessage !== mfServerAutomationLastMessage && state.running && !mfPreloadActiveJobKey) {
        setMeteoFranceTestStatus(nextMessage, 'waiting');
      }
      if (nextMessage) mfServerAutomationLastMessage = nextMessage;
      return true;
    }

    function stopMeteoFranceServerAutomationPolling() {
      if (mfServerAutomationPollTimer) {
        window.clearTimeout(mfServerAutomationPollTimer);
        mfServerAutomationPollTimer = null;
      }
    }

    // P4 : la carte de base est-elle COUVERTE par une page plein écran (Risque/Radar/Étoiles/
    // Historique/Forum/Spots…) ? Si oui, son polling de fond (statut préchargement/automation) est
    // inutile → on RALENTIT la cadence (jamais d'arrêt : au retour, loadAromeFranceData rafraîchit).
    // Repli sûr : un signal erroné ne change QUE la cadence, jamais la donnée.
    function isBaseMapCovered() {
      try {
        var b = document.body;
        if (b.classList.contains('chase-mode') || b.classList.contains('stargaze-mode')
          || b.classList.contains('forum-open') || b.classList.contains('history-open')
          || b.classList.contains('spots-open')) return true;
        var ids = ['predictionPage', 'historyPage', 'forumPage', 'spotsListPage', 'maintenancePage'];
        for (var i = 0; i < ids.length; i++) {
          var elx = document.getElementById(ids[i]);
          if (elx && elx.offsetParent !== null && getComputedStyle(elx).display !== 'none') return true;
        }
      } catch (_) {}
      return false;
    }

    async function pollMeteoFranceServerAutomationStatus({ immediate = false, quiet = true } = {}) {
      stopMeteoFranceServerAutomationPolling();
      const fetchToken = ++mfServerAutomationFetchToken;
      try {
        const response = await fetch('/api/server/arome-automation-status', { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (fetchToken !== mfServerAutomationFetchToken) return null;
        if (response.ok && data?.ok) syncMeteoFranceServerAutomationStatus(data, { quiet });
        const state = data?.state || {};
        const currentJob = state.current_job || {};
        const cooldownSeconds = Number(data?.quota_cooldown_seconds || state?.quota_cooldown_seconds || 0);
        const running = Boolean(state.running || currentJob.running || cooldownSeconds > 0);
        const nextDelay = (document.visibilityState === 'visible' && !isBaseMapCovered())
          ? (running ? METEOFRANCE_SERVER_POLL_RUNNING_MS : METEOFRANCE_SERVER_POLL_IDLE_MS)
          : METEOFRANCE_SERVER_POLL_HIDDEN_MS;
        mfServerAutomationPollTimer = window.setTimeout(() => {
          pollMeteoFranceServerAutomationStatus({ quiet: true });
        }, nextDelay);
        return data;
      } catch (_) {
        if (fetchToken === mfServerAutomationFetchToken) {
          mfServerAutomationPollTimer = window.setTimeout(() => {
            pollMeteoFranceServerAutomationStatus({ quiet: true });
          }, immediate ? 10000 : 30000);
        }
        return null;
      }
    }

    function formatMeteoFranceCooldown(seconds) {
      const total = Math.max(0, Math.ceil(Number(seconds || 0)));
      const minutes = Math.floor(total / 60);
      const secs = total % 60;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return `${hours}h ${String(remMinutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
      }
      return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function clearMeteoFranceQuotaCooldownBadge() {
      mfQuotaCooldownEndsAtMs = 0;
      mfQuotaCooldownMessage = '';
      mfQuotaCooldownSourceKey = '';
      if (mfQuotaCooldownTimer) {
        window.clearInterval(mfQuotaCooldownTimer);
        mfQuotaCooldownTimer = null;
      }
      if (typeof mfQuotaCooldownBadge !== 'undefined' && mfQuotaCooldownBadge) {
        mfQuotaCooldownBadge.hidden = true;
      }
    }

    function renderMeteoFranceQuotaCooldownBadge() {
      if (typeof mfQuotaCooldownBadge === 'undefined' || !mfQuotaCooldownBadge) return;
      const remainingMs = mfQuotaCooldownEndsAtMs - Date.now();
      if (remainingMs <= 0) {
        clearMeteoFranceQuotaCooldownBadge();
        return;
      }
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      mfQuotaCooldownBadge.hidden = false;
      mfQuotaCooldownBadge.textContent = `Quota AROME : ${formatMeteoFranceCooldown(remainingSeconds)}`;
      mfQuotaCooldownBadge.title = mfQuotaCooldownMessage || 'Cooldown quota Météo-France actif côté serveur';
    }

    function meteoFranceQuotaCooldownSourceKey(data, progress) {
      const jobKey = data?.job_key || progress?.job_key || '';
      const scope = data?.quota_cooldown_scope || progress?.quota_cooldown_scope || 'meteofrance';
      const status = data?.status || progress?.status || 'quota';
      const date = progress?.date || selectedBaseDate || '';
      return `${scope}|${jobKey || date}|${status}`;
    }

    function startMeteoFranceQuotaCooldown(seconds, message = '', sourceKey = '') {
      const duration = Number(seconds || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const now = Date.now();
      const proposedEndsAtMs = now + Math.ceil(duration) * 1000;
      const activeRemainingMs = mfQuotaCooldownEndsAtMs - now;
      const sameSource = sourceKey && sourceKey === mfQuotaCooldownSourceKey;
      if (activeRemainingMs > 0 && sameSource && proposedEndsAtMs >= mfQuotaCooldownEndsAtMs - 1500) {
        mfQuotaCooldownMessage = String(message || mfQuotaCooldownMessage || 'Cooldown quota Météo-France actif côté serveur');
        renderMeteoFranceQuotaCooldownBadge();
        if (!mfQuotaCooldownTimer) mfQuotaCooldownTimer = window.setInterval(renderMeteoFranceQuotaCooldownBadge, 1000);
        return;
      }
      mfQuotaCooldownEndsAtMs = proposedEndsAtMs;
      mfQuotaCooldownMessage = String(message || 'Cooldown quota Météo-France actif côté serveur');
      mfQuotaCooldownSourceKey = sourceKey || mfQuotaCooldownSourceKey || 'meteofrance-quota';
      renderMeteoFranceQuotaCooldownBadge();
      if (mfQuotaCooldownTimer) window.clearInterval(mfQuotaCooldownTimer);
      mfQuotaCooldownTimer = window.setInterval(renderMeteoFranceQuotaCooldownBadge, 1000);
    }

    function syncMeteoFranceQuotaCooldown(data) {
      const progress = normalizeMeteoFrancePreloadProgress(data);
      const seconds = Number(data?.quota_cooldown_seconds || progress?.quota_cooldown_seconds || 0);
      if (Number.isFinite(seconds) && seconds > 0) {
        startMeteoFranceQuotaCooldown(
          seconds,
          data?.message || progress?.message || 'Quota Météo-France en cooldown serveur.',
          meteoFranceQuotaCooldownSourceKey(data, progress),
        );
        return true;
      }
      return false;
    }

    function cancelMeteoFranceQuotaAutoResume() {
      if (mfQuotaCooldownResumeTimer) {
        window.clearTimeout(mfQuotaCooldownResumeTimer);
        mfQuotaCooldownResumeTimer = null;
      }
      mfQuotaCooldownResumeDate = '';
      mfQuotaCooldownResumeEndsAtMs = 0;
      mfQuotaCooldownResumeSourceKey = '';
    }

    function scheduleMeteoFranceQuotaAutoResume(seconds, sourceKey = '') {
      const duration = Number(seconds || 0);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const resumeDate = selectedBaseDate;
      const targetEndsAtMs = Date.now() + Math.ceil(duration) * 1000 + 900;
      const sameResume = mfQuotaCooldownResumeTimer
        && mfQuotaCooldownResumeDate === resumeDate
        && sourceKey
        && sourceKey === mfQuotaCooldownResumeSourceKey;
      if (sameResume && targetEndsAtMs >= mfQuotaCooldownResumeEndsAtMs - 1000) return;
      cancelMeteoFranceQuotaAutoResume();
      mfQuotaCooldownResumeDate = resumeDate;
      mfQuotaCooldownResumeEndsAtMs = targetEndsAtMs;
      mfQuotaCooldownResumeSourceKey = sourceKey || '';
      mfQuotaCooldownResumeTimer = window.setTimeout(() => {
        mfQuotaCooldownResumeTimer = null;
        mfQuotaCooldownResumeEndsAtMs = 0;
        mfQuotaCooldownResumeSourceKey = '';
        const shouldResume = selectedBaseDate === resumeDate
          && !!readMeteoFranceApiKey();
        if (!shouldResume) return;
        setMeteoFranceTestStatus('Cooldown quota terminé : attente de la reprise automatique serveur AROME…', 'waiting');
        refreshMeteoFranceGribCacheStatus({ force: true });
      }, Math.max(1000, Math.ceil(duration) * 1000 + 900));
    }

    function stopMeteoFrancePreloadPolling() {
      if (mfPreloadPollTimer) {
        clearTimeout(mfPreloadPollTimer);
        mfPreloadPollTimer = null;
      }
    }

    function normalizeMeteoFrancePreloadProgress(preload) {
      if (!preload) return null;
      return preload.progress || preload;
    }

    function stopMeteoFrancePreloadUiTick() {
      if (mfPreloadUiTickTimer) {
        window.clearInterval(mfPreloadUiTickTimer);
        mfPreloadUiTickTimer = null;
      }
    }

    function ensureMeteoFrancePreloadUiTick() {
      if (mfPreloadUiTickTimer) return;
      mfPreloadUiTickTimer = window.setInterval(() => {
        if (!mfPreloadUiSnapshot) {
          stopMeteoFrancePreloadUiTick();
          return;
        }
        renderMeteoFrancePreloadProgress(mfPreloadUiSnapshot);
      }, 1000);
    }

    function formatMeteoFranceHourLabel(hour) {
      const value = Number(hour);
      return Number.isFinite(value) ? `${String(value).padStart(2, '0')}h` : null;
    }

    // Libellé du jour préchargé : « lun. 23/06 (aujourd'hui) », « mar. 24/06 (demain) »,
    // « J+2 »… pour que la barre dise explicitement QUELLE journée elle charge.
    function formatMeteoFrancePreloadDayLabel(dateIso) {
      const iso = String(dateIso || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
      try {
        const today = (typeof getTodayIsoDate === 'function') ? getTodayIsoDate() : new Date().toISOString().slice(0, 10);
        const d0 = new Date(`${today}T12:00:00`);
        const d1 = new Date(`${iso}T12:00:00`);
        const offset = Math.round((d1 - d0) / 86400000);
        const rel = offset === 0 ? "aujourd'hui"
          : offset === 1 ? 'demain'
          : offset === 2 ? 'après-demain'
          : offset > 0 ? `J+${offset}`
          : `J${offset}`;
        const short = d1.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
        return `${short} (${rel})`;
      } catch (_) {
        return iso;
      }
    }

    function formatMeteoFranceDuration(ms) {
      const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min ${String(seconds).padStart(2, '0')} s`;
      if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
      return `${seconds} s`;
    }

    function meteoFrancePreloadElapsedMs(progress) {
      const directElapsed = Number(progress?.elapsed_ms);
      if (Number.isFinite(directElapsed) && directElapsed > 0) return directElapsed;
      const clientStartedAt = Number(progress?.client_started_at_ms || 0);
      if (clientStartedAt > 0) return Date.now() - clientStartedAt;
      const jobStartedAt = Number(progress?.started_at);
      if (Number.isFinite(jobStartedAt) && jobStartedAt > 0) {
        const jobFinishedAt = Number(progress?.finished_at);
        const endAt = Number.isFinite(jobFinishedAt) && jobFinishedAt > 0 ? jobFinishedAt * 1000 : Date.now();
        return endAt - (jobStartedAt * 1000);
      }
      if (progress?.job_key && progress.job_key === mfPreloadActiveJobKey && mfPreloadClientStartedAtMs > 0) {
        return Date.now() - mfPreloadClientStartedAtMs;
      }
      return 0;
    }

    function renderMeteoFrancePreloadProgress(preload) {
      if (!mfPreloadProgress) return;
      const progress = normalizeMeteoFrancePreloadProgress(preload);
      if (!progress) {
        mfPreloadUiSnapshot = null;
        stopMeteoFrancePreloadUiTick();
        mfPreloadProgress.hidden = true;
        return;
      }
      if (progress.running || progress.indeterminate) {
        mfPreloadUiSnapshot = {
          ...progress,
          client_started_at_ms: progress.client_started_at_ms || mfPreloadClientStartedAtMs || Date.now(),
        };
        ensureMeteoFrancePreloadUiTick();
      } else {
        mfPreloadUiSnapshot = null;
        stopMeteoFrancePreloadUiTick();
      }
      const hourCount = Number(progress.hour_count || (Array.isArray(progress.hours) ? progress.hours.length : 0));
      const unitCount = Number(progress.unit_count || hourCount);
      const completedCount = Number(progress.completed_count || 0);
      const percentSource = Number(progress.percent);
      const percent = Math.max(0, Math.min(100, Number.isFinite(percentSource)
        ? percentSource
        : (unitCount > 0 ? Math.round((completedCount / unitCount) * 100) : 0)));
      const okCount = Number(progress.ok_count || 0);
      const failedCount = Number(progress.failed_count || 0);
      const rangeCount = Number(progress.total_range_request_count || 0);
      const packageCount = Number(progress.package_request_count || 0);
      const cachedPackageCount = Number(progress.cached_package_request_count || 0);
      const cachedRangeCount = Number(progress.cached_total_range_request_count || 0);
      const currentHour = formatMeteoFranceHourLabel(progress.current_hour);
      const lastHour = formatMeteoFranceHourLabel(progress.last_result?.hour);
      const running = Boolean(progress.running);
      const indeterminate = Boolean(progress.indeterminate);
      const isDayScope = progress.scope === 'day';
      const isNationalScope = progress.scope === 'national_day';
      const unitLabel = progress.unit_label || (isNationalScope ? 'champ(s)' : 'heure(s)');
      const title = progress.title || (isNationalScope
        ? (running ? 'Préchargement France en cours' : 'Préchargement France terminé')
        : (isDayScope
          ? (running ? 'Préchargement journée en cours' : 'Préchargement journée terminé')
          : (running ? 'Préchargement du bloc en cours' : 'Préchargement du bloc terminé')));
      const countText = progress.detail || (unitCount > 0
        ? `${Math.min(completedCount, unitCount)}/${unitCount} ${unitLabel}`
        : (isNationalScope ? 'Préparation France' : (isDayScope ? 'Préparation journée' : 'Préparation du bloc')));
      const fieldText = progress.current_field ? `${progress.current_field}` : '';
      const currentText = running && currentHour
        ? ` · ${isNationalScope && fieldText ? `${fieldText} ` : ''}${currentHour} en cours`
        : (lastHour ? ` · dernière heure ${lastHour}` : '');
      const failureText = failedCount > 0 ? ` · ${failedCount} échec(s)` : '';
      const rangeText = rangeCount > 0 ? ` · ${rangeCount} Range API` : '';
      const packageText = packageCount > 0 ? ` · ${packageCount} paquet(s)` : '';
      const cachedPackageText = cachedPackageCount > 0 ? ` · ${cachedPackageCount} paquet(s) cache` : '';
      const cacheText = cachedRangeCount > 0 ? ` · ${cachedRangeCount} Range évités` : '';
      const elapsedMs = meteoFrancePreloadElapsedMs(progress);
      const durationText = elapsedMs > 0
        ? ` · ${running ? 'depuis' : 'durée'} ${formatMeteoFranceDuration(elapsedMs)}`
        : '';
      // Quelle journée ? (affichée dans le titre pour lever toute ambiguïté).
      const dayLabel = formatMeteoFrancePreloadDayLabel(progress.date);

      // Deux phases pour un jour national : (1) téléchargement/décodage des CHAMPS, puis
      // (2) matérialisation des GRILLES HORAIRES — c'est la phase 2 qui peuple réellement
      // la carte. Dès qu'on est en phase 2, le % et le compteur reflètent les GRILLES, pas
      // les champs : sinon « 100% champs » trompe alors que 0 grille n'est dispo (ex. J+3
      // ARPEGE = 288/288 champs mais 0/24 grilles). Les champs deviennent un détail.
      const materializeTotal = Number(progress.materialization_total_hours || 0);
      const materializeDone = Number(progress.materialized_hour_count || 0);
      const materializeFailed = Number(progress.materialization_failed_count || 0);
      const inMaterializePhase = isNationalScope && materializeTotal > 0;

      let displayPercent = percent;
      let displayTitle = title;
      let displayCountText = countText;
      if (inMaterializePhase) {
        const done = Math.min(materializeDone, materializeTotal);
        displayPercent = Math.round((done / materializeTotal) * 100);
        displayCountText = `${done}/${materializeTotal} grille(s) horaire(s)`;
        displayTitle = running
          ? 'Matérialisation grilles France en cours'
          : (materializeDone >= materializeTotal ? 'Préchargement France terminé' : 'Préchargement France incomplet');
      }
      const displayTitleWithDay = dayLabel ? `${displayTitle} — ${dayLabel}` : displayTitle;
      // Champs (phase 1) rappelés en info secondaire une fois en phase grilles.
      const fieldsNote = inMaterializePhase && unitCount > 0
        ? ` · ${Math.min(completedCount, unitCount)}/${unitCount} ${unitLabel}`
        : '';
      const materializeFailText = inMaterializePhase && materializeFailed > 0
        ? ` · ${materializeFailed} grille(s) en échec`
        : '';
      const okText = inMaterializePhase ? '' : ` · ${okCount} OK`;

      mfPreloadProgress.hidden = false;
      mfPreloadProgress.classList.toggle('is-indeterminate', indeterminate);
      if (mfPreloadProgressLabel) mfPreloadProgressLabel.textContent = displayTitleWithDay;
      if (mfPreloadProgressValue) mfPreloadProgressValue.textContent = indeterminate ? '…' : `${displayPercent}%`;
      if (mfPreloadProgressBar) mfPreloadProgressBar.style.width = indeterminate ? '' : `${displayPercent}%`;
      if (mfPreloadProgressDetail) {
        mfPreloadProgressDetail.textContent = `${displayCountText}${fieldsNote}${materializeFailText}${currentText}${okText}${failureText}${rangeText}${packageText}${cachedPackageText}${cacheText}${durationText}`;
      }
    }

    async function pollMeteoFrancePreloadProgress(jobKey) {
      if (!jobKey || mfPreloadActiveJobKey !== jobKey) return;
      try {
        const response = await fetch(`/api/meteofrance/grib-preload-status?job_key=${encodeURIComponent(jobKey)}`);
        const data = await response.json().catch(() => ({}));
        if (!data?.ok) {
          stopMeteoFrancePreloadPolling();
          return;
        }
        const hasQuotaCooldown = syncMeteoFranceQuotaCooldown(data);
        renderMeteoFrancePreloadProgress(data);
        if (data.running && mfPreloadActiveJobKey === jobKey) {
          if (!hasQuotaCooldown) clearMeteoFranceQuotaCooldownBadge();
          mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), isBaseMapCovered() ? METEOFRANCE_SERVER_POLL_HIDDEN_MS : METEOFRANCE_PRELOAD_POLL_RUNNING_MS);
        } else {
          stopMeteoFrancePreloadPolling();
          const duration = formatMeteoFranceDuration(meteoFrancePreloadElapsedMs(data));
          const okCount = Number(data.ok_count || 0);
          const hourCount = Number(data.hour_count || (Array.isArray(data.hours) ? data.hours.length : 0));
          const unitCount = Number(data.unit_count || hourCount);
          const unitLabel = data.unit_label || (data.scope === 'national_day' ? 'champ(s)' : 'heure(s)');
          const failedCount = Number(data.failed_count || 0);
          const rangeCount = Number(data.total_range_request_count || 0);
          const packageCount = Number(data.package_request_count || 0);
          const cachedPackageCount = Number(data.cached_package_request_count || 0);
          const cachedRangeCount = Number(data.cached_total_range_request_count || 0);
          const nationalCacheCount = Number(data.national_field_cache_hit_count || 0);
          const decodedFieldCount = Number(data.decoded_field_count || 0);
          const isDayScope = data.scope === 'day';
          const isNationalScope = data.scope === 'national_day';
          const resultLabel = failedCount > 0 ? 'terminé partiellement' : 'terminé';
          const scopeLabel = isNationalScope ? 'France AROME' : (isDayScope ? 'journée AROME' : 'bloc AROME');
          const cacheText = cachedRangeCount > 0 ? `, ${cachedRangeCount} Range évités` : '';
          const packageText = packageCount > 0 ? `, ${packageCount} paquet(s) complet(s)` : '';
          const cachedPackageText = cachedPackageCount > 0 ? `, ${cachedPackageCount} paquet(s) cache` : '';
          const nationalText = isNationalScope ? `, ${decodedFieldCount} champ(s) décodé(s), ${nationalCacheCount} déjà en cache national` : '';
          const rainText = '';
          const failedUnits = Array.isArray(data.failed_units) ? data.failed_units.slice(0, 5) : [];
          const failedUnitLabel = (item) => {
            const prefix = `${String(Number(item?.hour || 0)).padStart(2, '0')}h ${item?.field || 'champ'}`;
            const message = String(item?.message || '').replace(/\s+/g, ' ').trim();
            return message ? `${prefix} (${message.slice(0, 76)}${message.length > 76 ? '…' : ''})` : prefix;
          };
          const failedUnitText = isNationalScope && failedUnits.length
            ? ` Échecs visibles : ${failedUnits.map(failedUnitLabel).join(', ')}${failedCount > failedUnits.length ? '…' : ''}.`
            : '';
          let statusMessage = `Préchargement ${scopeLabel} ${resultLabel} en ${duration} : ${okCount}/${unitCount} ${unitLabel}, ${rangeCount} Range API${packageText}${cachedPackageText}${cacheText}${nationalText}${rainText}.${failedUnitText}`;
          const cooldownSeconds = Number(data.quota_cooldown_seconds || 0);
          if (hasQuotaCooldown && isNationalScope && failedCount > 0 && okCount < unitCount && cooldownSeconds > 0) {
            scheduleMeteoFranceQuotaAutoResume(cooldownSeconds, meteoFranceQuotaCooldownSourceKey(data, data));
            statusMessage += ` Reprise automatique dans ${formatMeteoFranceCooldown(cooldownSeconds)}.`;
          }
          setMeteoFranceTestStatus(statusMessage, failedCount > 0 ? 'waiting' : 'ok');
          await refreshMeteoFranceGribCacheStatus({ force: true });
          let materializedFromNationalFields = false;
          if (isNationalScope && okCount > 0 && unitCount > 0) {
            materializedFromNationalFields = await materializeMeteoFranceGribFranceDayFromNationalCache({ quiet: true });
            if (materializedFromNationalFields) await refreshMeteoFranceGribCacheStatus({ force: true });
          }
          const loadedFromSlotCache = await maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet: true, force: true });
          const loadedFromNationalFields = false;
          if (loadedFromSlotCache || loadedFromNationalFields || materializedFromNationalFields) {
            const loadedHours = typeof aromeFranceLoadedSlotKeys === 'function' ? aromeFranceLoadedSlotKeys().size : 0;
            statusMessage += materializedFromNationalFields
              ? ` ${loadedHours}/24 grille(s) horaires prêtes côté navigateur.`
              : ` Grille ${String(selectedMeteoFranceHour()).padStart(2, '0')}h affichée depuis le cache France.`;
            setMeteoFranceTestStatus(statusMessage, failedCount > 0 ? 'waiting' : 'ok');
          }
          if (!hasQuotaCooldown && failedCount === 0) {
            cancelMeteoFranceQuotaAutoResume();
            clearMeteoFranceQuotaCooldownBadge();
          }
        }
      } catch (_) {
        if (mfPreloadActiveJobKey === jobKey) {
          mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_ERROR_MS);
        }
      }
    }

    function trackMeteoFrancePreload(preload) {
      const progress = normalizeMeteoFrancePreloadProgress(preload);
      const jobKey = progress?.job_key || preload?.job_key;
      if (!jobKey && !preload?.scheduled && !preload?.already_running && !preload?.already_done && !progress?.hour_count) return;
      renderMeteoFrancePreloadProgress(progress || preload);
      if (!jobKey) return;
      mfPreloadActiveJobKey = jobKey;
      stopMeteoFrancePreloadPolling();
      if (preload?.scheduled || preload?.already_running || progress?.running) {
        mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_START_MS);
      } else if (preload?.already_done) {
        mfPreloadPollTimer = setTimeout(() => pollMeteoFrancePreloadProgress(jobKey), METEOFRANCE_PRELOAD_POLL_START_MS);
      }
    }

    function readMeteoFranceApiKey() {
      return mfTokenInput?.value?.trim() || '';
    }

    function withMeteoFranceToken(body, token = readMeteoFranceApiKey()) {
      const cleanToken = String(token || '').trim();
      if (cleanToken) return { token: cleanToken, ...body };
      return body;
    }

    function loadStoredMeteoFranceApiKey() {
      try {
        return localStorage.getItem(METEOFRANCE_API_KEY_STORAGE_KEY) || '';
      } catch (_) {
        return '';
      }
    }

    function saveStoredMeteoFranceApiKey(value) {
      try {
        if (value) localStorage.setItem(METEOFRANCE_API_KEY_STORAGE_KEY, value);
        else localStorage.removeItem(METEOFRANCE_API_KEY_STORAGE_KEY);
      } catch (_) {}
    }

    function persistCurrentMeteoFranceApiKey() {
      saveStoredMeteoFranceApiKey(readMeteoFranceApiKey());
    }

    function initializeMeteoFranceApiKeyField() {
      if (!mfTokenInput) return;
      const stored = loadStoredMeteoFranceApiKey();
      if (!stored || mfTokenInput.value) return;
      mfTokenInput.value = stored;
      setMeteoFranceTestStatus('Clé API restaurée depuis ce navigateur. Tu peux actualiser AROME France.', '');
    }

    function addDaysIso(dateIso, days) {
      const base = new Date(`${normalizeDateIso(dateIso)}T12:00:00`);
      base.setDate(base.getDate() + days);
      return base.toISOString().slice(0, 10);
    }

    function getMeteoFranceWcsDateStatus(dateIso = selectedBaseDate, { allowPreviousDay = false } = {}) {
      const selected = normalizeDateIso(dateIso);
      const today = getTodayIsoDate();
      const minDate = allowPreviousDay ? addDaysIso(today, -1) : today;
      // J-1..J+2 = AROME ; J+3 = ARPEGE (le serveur choisit le modèle selon la date).
      // J+4+ n'est PLUS sur la grille de base → tendance ECMWF dans la carte Prévision.
      const maxDaysAhead = allowPreviousDay ? 3 : METEOFRANCE_WCS_MAX_DAYS_AHEAD;
      const maxDate = addDaysIso(today, maxDaysAhead);
      if (selected < minDate) {
        return {
          ok: false,
          message: allowPreviousDay
            ? `La grille France peut être tentée de la veille à J+4 (${minDate} à ${maxDate} ; AROME jusqu’à J+2, ARPEGE ensuite). Sélection actuelle : ${selected}.`
            : `La grille AROME WCS directe couvre seulement l’horizon prévisionnel courant (${today} à ${maxDate}). Pour ${selected}, garde la source historique.`,
        };
      }
      if (selected > maxDate) {
        return {
          ok: false,
          message: allowPreviousDay
            ? `La grille France peut être tentée de la veille à J+4 (${minDate} à ${maxDate} ; AROME jusqu’à J+2, ARPEGE ensuite). Sélection actuelle : ${selected}.`
            : `La grille AROME WCS directe est limitée à aujourd’hui et demain (${today} à ${maxDate}). Sélection actuelle : ${selected}.`,
        };
      }
      return { ok: true, today, minDate, maxDate };
    }

    function selectedMeteoFranceHour() {
      const match = String(selectedSlotKey || '').match(/^h(\d{2})$/);
      if (match) return Number(match[1]);
      return new Date().getHours();
    }

    function slotKeyForMeteoFranceHour(hour) {
      return `h${String(Number(hour) || 0).padStart(2, '0')}`;
    }

    function currentSlotUsesMeteoFranceGrib() {
      const cells = getCurrentSlot()?.cells || [];
      return cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib');
    }

    function currentLatestPayloadSignature() {
      return `${currentCenter.lat}|${currentCenter.lon}|${currentCenter.label}|${selectedBaseDate}`;
    }

    function currentMeteoFranceGribCacheStatusSignature() {
      return `france|${selectedBaseDate}|server-cache`;
    }

    function fitMapToCells(cells, { maxZoom = 6.4, duration = 900 } = {}) {
      if (!map || !Array.isArray(cells) || !cells.length) return;
      let north = -Infinity;
      let south = Infinity;
      let east = -Infinity;
      let west = Infinity;
      for (const cell of cells) {
        const lat = Number(cell?.lat);
        const lon = Number(cell?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const halfH = Math.max(0, Number(cell?.cell_height_deg || 0) / 2);
        const halfW = Math.max(0, Number(cell?.cell_width_deg || 0) / 2);
        north = Math.max(north, lat + halfH);
        south = Math.min(south, lat - halfH);
        east = Math.max(east, lon + halfW);
        west = Math.min(west, lon - halfW);
      }
      if (![north, south, east, west].every(Number.isFinite)) return;
      try {
        map.fitBounds([[west, south], [east, north]], {
          padding: { top: 72, right: 56, bottom: 96, left: 56 },
          duration,
          maxZoom,
          essential: true,
        });
      } catch (_) {}
    }

    async function refreshMeteoFranceGribCacheStatus({ force = false } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) {
        if (meteoFranceGribCachedSlotKeys.size) {
          meteoFranceGribCachedSlotKeys = new Set();
          renderSlotButtons();
        }
        meteoFranceGribCacheStatusSignature = "";
        return null;
      }
      const signature = currentMeteoFranceGribCacheStatusSignature();
      if (!force && signature === meteoFranceGribCacheStatusSignature) {
        hydrateMeteoFranceGribFranceDayFromCache({ force: false });
        return { ok: true, cached_slot_keys: Array.from(meteoFranceGribCachedSlotKeys || []) };
      }
      const fetchToken = ++meteoFranceGribCacheStatusFetchToken;
      const body = withMeteoFranceToken({
        lat: currentCenter.lat,
        lon: currentCenter.lon,
        label: currentCenter.label,
        date: selectedBaseDate,
        detail_level: "core",
      }, token);
      const endpoints = [
        "/api/meteofrance/grib-france-cache-status",
      ];
      try {
        for (const endpoint of endpoints) {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));
          if (fetchToken !== meteoFranceGribCacheStatusFetchToken) return null;
          if (!data?.ok) continue;
          const cachedKeys = Array.isArray(data.cached_slot_keys) ? data.cached_slot_keys : [];
          const availableKeys = Array.isArray(data.available_slot_keys) ? data.available_slot_keys : null;
          if (!cachedKeys.length && endpoint.includes("france") && !availableKeys) continue;
          meteoFranceGribCacheStatusSignature = signature;
          meteoFranceGribCachedSlotKeys = new Set(cachedKeys);
          meteoFranceGribAvailableSlotKeys = availableKeys ? new Set(availableKeys) : meteoFranceGribAvailableSlotKeys;
          if (typeof rememberMeteoFranceGribCacheStatus === 'function' && cachedKeys.length) rememberMeteoFranceGribCacheStatus(selectedBaseDate, cachedKeys);
          if (typeof rememberMeteoFranceGribAvailabilityStatus === 'function' && availableKeys) rememberMeteoFranceGribAvailabilityStatus(selectedBaseDate, availableKeys);
          if (!force) renderSlotButtons();
          const hydrationPromise = hydrateMeteoFranceGribFranceDayFromCache({ force });
          if (force) await hydrationPromise;
          renderSlotButtons();
          return data;
        }
        if (fetchToken === meteoFranceGribCacheStatusFetchToken) {
          meteoFranceGribCacheStatusSignature = signature;
          meteoFranceGribCachedSlotKeys = new Set();
          renderSlotButtons();
        }
        return null;
      } catch (_) {
        return null;
      }
    }


    function meteoFranceProviderInfo(provider) {
      if (provider === 'meteofrance_arome_grib') {
        return {
          provider: 'meteofrance_arome_grib',
          bucket: 'meteofrance_grib',
          label: 'Météo-France AROME GRIB cache',
        };
      }
      return {
        provider: 'meteofrance_arome_grib',
        bucket: 'meteofrance_grib',
        label: 'Météo-France AROME GRIB cache',
      };
    }

    function normalizeMeteoFranceSlot(slot, incomingMeta = {}) {
      const providerInfo = meteoFranceProviderInfo(incomingMeta.provider || incomingMeta.source_provider || 'meteofrance_arome_grib');
      return {
        ...slot,
        cells: Array.isArray(slot?.cells)
          ? slot.cells.map((cell) => ({
              ...cell,
              source_provider: cell?.source_provider || providerInfo.provider,
              source_label: cell?.source_label || incomingMeta.source_label || providerInfo.label,
            }))
          : [],
      };
    }

    function meteoFranceGribPayloadHasRequiredFields(slotPayload) {
      const meta = slotPayload?.meta || {};
      const provider = meta.provider || meta.source_provider || '';
      if (provider !== 'meteofrance_arome_grib') return true;
      // ARPEGE (J+3/J+4) porte le même provider que l'AROME mais a un jeu de champs RÉDUIT :
      // il ne fournit pas shortwave_radiation ni precipitation_rate. Sans cette distinction,
      // chaque créneau ARPEGE échouait au contrôle → fusion refusée → grille France vide.
      const isArpege = String(meta.nwp_model || '').toLowerCase() === 'arpege';
      const requiredFields = isArpege
        ? ['cape', 'precipitable_water', 'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'temperature_2m', 'dew_point_2m', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m']
        : ['cape', 'precipitable_water', 'shortwave_radiation', 'precipitation_rate', 'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'temperature_2m', 'dew_point_2m', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_gusts_10m'];
      const missing = Array.isArray(meta.missing_fields) ? meta.missing_fields.map(String) : [];
      if (requiredFields.some((field) => missing.includes(field))) return false;
      const requests = Array.isArray(meta.field_requests) ? meta.field_requests : [];
      if (!requests.length) return false;
      return requiredFields.every((field) => requests.some((item) => item?.field === field && item?.ok === true));
    }

    function mergeMeteoFranceDayPayload(dayPayload, allowedSlotKeys = null) {
      const incomingDays = Array.isArray(dayPayload?.days) ? dayPayload.days : [];
      const incomingDay = incomingDays.find((day) => day?.day_key === normalizeDateIso(selectedBaseDate)) || incomingDays[0];
      const incomingSlots = getRenderableSlots(incomingDay);
      if (!incomingDay || !incomingSlots.length) return 0;
      const allowed = allowedSlotKeys instanceof Set ? allowedSlotKeys : null;
      let merged = 0;
      for (const slot of incomingSlots) {
        const slotKey = String(slot?.slot_key || '');
        if (!/^h\d{2}$/.test(slotKey)) continue;
        if (allowed && !allowed.has(slotKey)) continue;
        const hour = Number(slotKey.slice(1));
        const slotPayload = {
          meta: dayPayload?.meta || {},
          days: [{ ...incomingDay, slots: [slot] }],
        };
        if (mergeMeteoFranceSlotPayload(slotPayload, hour)) merged += 1;
      }
      return merged;
    }

    function mergeMeteoFranceSlotPayload(slotPayload, hour) {
      if (!meteoFranceGribPayloadHasRequiredFields(slotPayload)) return false;
      const targetDayKey = normalizeDateIso(selectedBaseDate);
      const targetSlotKey = `h${String(hour).padStart(2, '0')}`;
      const incomingDays = Array.isArray(slotPayload?.days) ? slotPayload.days : [];
      const incomingDay = incomingDays.find((day) => day?.day_key === targetDayKey) || incomingDays[0];
      const incomingSlots = getRenderableSlots(incomingDay);
      const incomingSlot = incomingSlots.find((slot) => slot?.slot_key === targetSlotKey) || incomingSlots[0];
      if (!incomingDay || !incomingSlot) return false;

      if (!payload || !Array.isArray(payload.days)) {
        payload = slotPayload;
      }

      const incomingMeta = slotPayload?.meta || {};
      const providerInfo = meteoFranceProviderInfo(incomingMeta.provider || incomingMeta.source_provider || 'meteofrance_arome_grib');
      const nextSlot = normalizeMeteoFranceSlot(incomingSlot, incomingMeta);
      const targetPayload = payload;
      const days = Array.isArray(targetPayload.days) ? targetPayload.days : [];
      targetPayload.days = days;
      let targetDay = days.find((day) => day?.day_key === incomingDay.day_key);
      if (!targetDay) {
        targetDay = {
          day_key: incomingDay.day_key,
          day_label: incomingDay.day_label,
          day_index: incomingDay.day_index,
          slots: [],
        };
        days.push(targetDay);
      }
      if (!Array.isArray(targetDay.slots)) targetDay.slots = [];
      const existingIndex = targetDay.slots.findIndex((slot) => slot?.slot_key === nextSlot.slot_key);
      if (existingIndex >= 0) targetDay.slots.splice(existingIndex, 1, nextSlot);
      else targetDay.slots.push(nextSlot);
      targetDay.slots.sort((a, b) => String(a?.slot_key || '').localeCompare(String(b?.slot_key || '')));
      targetPayload.days.sort((a, b) => Number(a?.day_index || 0) - Number(b?.day_index || 0));
      if (providerInfo.provider === 'meteofrance_arome_grib' && typeof rememberAromeFranceDay === 'function') {
        rememberAromeFranceDay(targetDay);
      }

      const previousMeta = targetPayload.meta || {};
      const sourceBucket = providerInfo.bucket;
      const previousSourceMeta = previousMeta[sourceBucket] || {};
      const trackedSlots = new Set(Array.isArray(previousSourceMeta?.slots) ? previousSourceMeta.slots : []);
      trackedSlots.add(`${incomingDay.day_key}:${nextSlot.slot_key}`);
      const nextProvider = providerInfo.provider;
      const nextSourceLabel = providerInfo.label;
      targetPayload.meta = {
        ...previousMeta,
        provider: nextProvider,
        source_provider: nextProvider,
        source_label: nextSourceLabel,
        nwp_model: incomingMeta.nwp_model || previousMeta.nwp_model,
        nwp_model_label: incomingMeta.nwp_model_label || previousMeta.nwp_model_label,
        time_targets: incomingMeta.time_targets || previousMeta.time_targets,
        arome_run_reference_times: incomingMeta.arome_run_reference_times || previousMeta.arome_run_reference_times,
        arome_run_latest_reference_time: incomingMeta.arome_run_latest_reference_time || previousMeta.arome_run_latest_reference_time,
        arome_run_api_updated_at: incomingMeta.arome_run_api_updated_at || previousMeta.arome_run_api_updated_at,
        [sourceBucket]: {
          ...previousSourceMeta,
          provider: providerInfo.provider,
          source_label: incomingMeta.source_label || providerInfo.label,
          last_day_key: incomingDay.day_key,
          last_slot_key: nextSlot.slot_key,
          last_updated_at: new Date().toISOString(),
          slots: Array.from(trackedSlots).sort(),
          detail_level: incomingMeta.detail_level,
          coverage_request_count: incomingMeta.coverage_request_count,
          field_request_count: incomingMeta.field_request_count,
          total_range_request_count: incomingMeta.total_range_request_count,
          grid_scope: incomingMeta.grid_scope,
          france_grid: incomingMeta.france_grid,
          country_mask: incomingMeta.country_mask,
          france_grid_cell_count: incomingMeta.france_grid_cell_count,
          time_targets: incomingMeta.time_targets,
          arome_run_reference_times: incomingMeta.arome_run_reference_times,
          arome_run_latest_reference_time: incomingMeta.arome_run_latest_reference_time,
          arome_run_api_updated_at: incomingMeta.arome_run_api_updated_at,
          index_range_request_count: incomingMeta.index_range_request_count,
          message_range_request_count: incomingMeta.message_range_request_count,
          optional_missing_fields: incomingMeta.optional_missing_fields,
          skipped_optional_fields: incomingMeta.skipped_optional_fields,
          wind_direction_ready: incomingMeta.wind_direction_ready,
          warning: incomingMeta.warning,
        },
      };
      if (providerInfo.provider === 'meteofrance_arome_grib' && typeof rememberAromeFranceDay === 'function') {
        rememberAromeFranceDay(targetDay);
      }
      return true;
    }

    function aromeFranceLoadedSlotKeys() {
      const day = getCurrentDay();
      const slots = Array.isArray(day?.slots) ? day.slots : [];
      return new Set(slots
        .filter((slot) => Array.isArray(slot?.cells) && slot.cells.some((cell) => cell?.source_provider === 'meteofrance_arome_grib'))
        .map((slot) => slot.slot_key));
    }

    function meteoFranceCacheHydrationSignature() {
      const cacheKeys = Array.from(meteoFranceGribCachedSlotKeys || []).sort().join(',');
      return `france-hydrate|${normalizeDateIso(selectedBaseDate)}|server-cache|${cacheKeys}`;
    }

    function meteoFranceAllDaySlotKeys() {
      return Array.from({ length: 24 }, (_, hour) => `h${String(hour).padStart(2, '0')}`);
    }

    function queueAromeFranceGeojsonPrewarm(slots = null) {
      if (typeof buildSlotGeoJSON !== 'function') return;
      const sourceSlots = Array.isArray(slots)
        ? slots
        : (Array.isArray(getCurrentDay()?.slots) ? getCurrentDay().slots : []);
      const queue = sourceSlots.filter((slot) => Array.isArray(slot?.cells) && slot.cells.length > 0);
      if (!queue.length) return;
      if (mfAromeGeojsonPrewarmTimer) {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(mfAromeGeojsonPrewarmTimer);
        else clearTimeout(mfAromeGeojsonPrewarmTimer);
        mfAromeGeojsonPrewarmTimer = null;
      }
      const run = (deadline = null) => {
        mfAromeGeojsonPrewarmTimer = null;
        const startedAt = performance.now();
        while (queue.length) {
          const slot = queue.shift();
          try { buildSlotGeoJSON(slot, slot.cells); } catch (_) {}
          const hasTime = deadline && typeof deadline.timeRemaining === 'function' ? deadline.timeRemaining() > 8 : (performance.now() - startedAt) < 18;
          if (!hasTime) break;
        }
        if (queue.length) {
          mfAromeGeojsonPrewarmTimer = typeof requestIdleCallback === 'function'
            ? requestIdleCallback(run, { timeout: 600 })
            : setTimeout(run, 40);
        }
      };
      mfAromeGeojsonPrewarmTimer = typeof requestIdleCallback === 'function'
        ? requestIdleCallback(run, { timeout: 600 })
        : setTimeout(run, 40);
    }

    async function hydrateMeteoFranceGribFranceDayFromCache({ force = false } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const hydrateKey = meteoFranceCacheHydrationSignature();
      if (!force && mfFranceDayHydrationPromise && hydrateKey === mfFranceDayHydrationKey) return mfFranceDayHydrationPromise;

      const loaded = aromeFranceLoadedSlotKeys();
      const cacheKeys = Array.from(meteoFranceGribCachedSlotKeys || []).filter((key) => /^h\d{2}$/.test(String(key)));
      // Important: this hydrator is only for slot grids already materialized by
      // the server. Rebuilding from national field caches here makes blue AROME
      // badges linger and slows timeline navigation.
      const targetKeys = cacheKeys
        .filter((key, index, arr) => arr.indexOf(key) === index)
        .filter((key) => force || !loaded.has(key));
      // Au boot, le statut serveur (meteoFranceGribCachedSlotKeys) n'est pas encore
      // arrivé : on hydrate quand même depuis IndexedDB (dernier état connu) pour un
      // affichage instantané ; le réseau revalidera quand le statut sera là.
      const idbOnly = !targetKeys.length;
      const idbBootKeys = idbOnly
        ? Array.from({ length: 24 }, (_, h) => `h${String(h).padStart(2, '0')}`).filter((key) => !loaded.has(key))
        : [];
      if (idbOnly && (!idbBootKeys.length || typeof idbGetAromeSlot !== 'function')) return true;

      const hydrationToken = ++mfFranceDayHydrationToken;
      const startDate = selectedBaseDate;
      const startCenterToken = centerChangeToken;
      mfFranceDayHydrationKey = hydrateKey;
      mfFranceDayHydrationPromise = (async () => {
        let mergedCount = 0;
        const startDateIso = normalizeDateIso(startDate);
        const guard = () => hydrationToken === mfFranceDayHydrationToken && startCenterToken === centerChangeToken && selectedBaseDate === startDate;
        const slotGenKey = (slotKey) => `${startDateIso}|${slotKey}`;

        // Rafraîchit l'UI dès qu'un lot de créneaux est mergé (rendu progressif : l'heure
        // active s'affiche sans attendre l'hydratation des 23 autres).
        const syncGridUi = ({ final = false } = {}) => {
          if (!guard()) return;
          renderDayButtons();
          renderSlotButtons();
          if (mergedCount > 0 && typeof updateMetaLine === 'function') updateMetaLine();
          if (currentSlotUsesMeteoFranceGrib()) {
            shouldAnimateNextGrid = false;
            scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          }
          if (final) {
            lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : lastFetchSignature;
            if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
          }
        };

        // Hydratation instantanée depuis IndexedDB (payloads « render » du dernier état
        // connu) : zéro réseau, zéro JSON.parse. Revalidé ensuite par le réseau.
        const hydrateSlotsFromIdb = async (keys) => {
          if (typeof idbGetAromeSlot !== 'function') return 0;
          let merged = 0;
          for (const slotKey of keys) {
            if (!guard()) return merged;
            if (mfAromeSlotGeneratedAt.get(slotGenKey(slotKey))) continue;
            try {
              const entry = await idbGetAromeSlot(startDateIso, slotKey);
              const payload = entry?.payload;
              if (!payload) continue;
              const hour = Number(String(slotKey).slice(1));
              if (!mergeMeteoFranceSlotPayload(payload, hour)) continue;
              mfAromeSlotGeneratedAt.set(slotGenKey(slotKey), String(payload?.meta?.generated_at || '') || 'idb');
              merged += 1;
              mergedCount += 1;
            } catch (_) {}
          }
          return merged;
        };

        // Fetch réseau d'un créneau en niveau « render » (≈70 % plus léger : sans les
        // champs de détail, récupérés à la demande au tap d'une cellule).
        const fetchSlot = async (slotKey) => {
          const hour = Number(String(slotKey).slice(1));
          const body = withMeteoFranceToken({
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: startDate,
            hour,
            detail_level: 'render',
            cache_only: true,
          }, token);
          try {
            const response = await fetch('/api/meteofrance/grib-france-slot-grid-cache', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (!guard()) return false;
            syncMeteoFranceQuotaCooldown(data);
            if (!data?.ok || !data?.payload) return false;
            const generatedAt = String(data.payload?.meta?.generated_at || '');
            if (typeof idbPutAromeSlot === 'function') idbPutAromeSlot(startDateIso, slotKey, data.payload);
            // Hit IndexedDB déjà mergé et identique : rien à re-render.
            if (generatedAt && mfAromeSlotGeneratedAt.get(slotGenKey(slotKey)) === generatedAt) return false;
            if (!mergeMeteoFranceSlotPayload(data.payload, hour)) return false;
            mfAromeSlotGeneratedAt.set(slotGenKey(slotKey), generatedAt || 'net');
            mergedCount += 1;
            return true;
          } catch (_) {
            return false;
          }
        };
        const runHydrationBatch = async (keys, maxWorkers) => {
          let cursor = 0;
          const workerCount = Math.min(maxWorkers, keys.length);
          if (!workerCount) return;
          const runWorker = async () => {
            while (cursor < keys.length) {
              const slotKey = keys[cursor];
              cursor += 1;
              await fetchSlot(slotKey);
            }
          };
          await Promise.all(Array.from({ length: workerCount }, runWorker));
        };

        // Mode boot : IndexedDB seul (pas de réseau tant que le statut serveur des
        // créneaux n'est pas connu) — affichage instantané du dernier état archivé.
        if (idbOnly) {
          const activeBootKey = (/^h\d{2}$/.test(String(selectedSlotKey || '')) && idbBootKeys.includes(selectedSlotKey)) ? selectedSlotKey : idbBootKeys[0];
          if (await hydrateSlotsFromIdb([activeBootKey])) syncGridUi();
          if (await hydrateSlotsFromIdb(idbBootKeys.filter((key) => key !== activeBootKey))) syncGridUi();
          return mergedCount > 0;
        }

        // 1) L'heure ACTIVE d'abord : IndexedDB (instantané) puis réseau, et rendu immédiat.
        const activeKey = (/^h\d{2}$/.test(String(selectedSlotKey || '')) && targetKeys.includes(selectedSlotKey)) ? selectedSlotKey : targetKeys[0];
        const restKeys = targetKeys.filter((key) => key !== activeKey);
        if (await hydrateSlotsFromIdb([activeKey])) syncGridUi();
        if (await fetchSlot(activeKey)) syncGridUi();

        // 2) Le reste : IndexedDB d'un bloc (affichage immédiat), puis revalidation réseau.
        const beforeRest = mergedCount;
        await hydrateSlotsFromIdb(restKeys);
        if (mergedCount > beforeRest) syncGridUi();
        await runHydrationBatch(restKeys, 3);

        // Migration paquet complet : le front ne matérialise plus les heures manquantes une par une.
        // Les slots apparaissent uniquement quand le serveur les a produits depuis les paquets complets.
        syncGridUi({ final: true });
        return mergedCount > 0;
      })();
      try {
        return await mfFranceDayHydrationPromise;
      } finally {
        if (hydrateKey === mfFranceDayHydrationKey) mfFranceDayHydrationPromise = null;
      }
    }

    async function materializeMeteoFranceGribFranceDayFromNationalCache({ force = false, quiet = true } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const startDate = selectedBaseDate;
      const materializeKey = `france-materialize|${normalizeDateIso(startDate)}|server-cache`;
      if (!force && mfFranceDayMaterializePromise && mfFranceDayMaterializeKey === materializeKey) return mfFranceDayMaterializePromise;

      const loaded = aromeFranceLoadedSlotKeys();
      const selectedKey = /^h\d{2}$/.test(String(selectedSlotKey || '')) ? selectedSlotKey : null;
      const selectableKeys = typeof getSelectableSlots === 'function'
        ? getSelectableSlots(getCurrentDay()).map((slot) => slot?.slot_key).filter((key) => /^h\d{2}$/.test(String(key)))
        : [];
      const allKeys = selectableKeys.length ? selectableKeys : meteoFranceAllDaySlotKeys();
      const orderedKeys = selectedKey && allKeys.includes(selectedKey)
        ? [selectedKey, ...allKeys.filter((key) => key !== selectedKey)]
        : allKeys;
      const targetKeys = orderedKeys.filter((key) => force || !loaded.has(key));
      if (!targetKeys.length) {
        queueAromeFranceGeojsonPrewarm();
        if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
        return true;
      }

      const materializeToken = ++mfFranceDayMaterializeToken;
      const startCenterToken = centerChangeToken;
      mfFranceDayMaterializeKey = materializeKey;
      mfFranceDayMaterializePromise = (async () => {
        let mergedCount = 0;
        let failedCount = 0;
        const fetchSlot = async (slotKey, endpoint) => {
          const hour = Number(String(slotKey).slice(1));
          const body = withMeteoFranceToken({
            lat: currentCenter.lat,
            lon: currentCenter.lon,
            label: currentCenter.label,
            date: startDate,
            hour,
            detail_level: 'core',
            cache_only: true,
          }, token);
          try {
            const response = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => ({}));
            if (materializeToken !== mfFranceDayMaterializeToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate) return false;
            syncMeteoFranceQuotaCooldown(data);
            if (!data?.ok || !data?.payload) {
              failedCount += 1;
              return false;
            }
            if (!mergeMeteoFranceSlotPayload(data.payload, hour)) {
              failedCount += 1;
              return false;
            }
            meteoFranceGribCachedSlotKeys.add(slotKey);
            mergedCount += 1;
            if (slotKey === selectedSlotKey) {
              shouldAnimateNextGrid = false;
              scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
            }
            return true;
          } catch (_) {
            failedCount += 1;
            return false;
          }
        };
        const runHydrationBatch = async (keys, endpoint, maxWorkers) => {
          let cursor = 0;
          const workerCount = Math.min(maxWorkers, keys.length);
          if (!workerCount) return;
          const runWorker = async () => {
            while (cursor < keys.length) {
              const slotKey = keys[cursor];
              cursor += 1;
              await fetchSlot(slotKey, endpoint);
            }
          };
          await Promise.all(Array.from({ length: workerCount }, runWorker));
        };

        await runHydrationBatch(targetKeys, '/api/meteofrance/grib-france-slot-grid-cache', 8);
        const stillMissingKeys = targetKeys.filter((key) => !aromeFranceLoadedSlotKeys().has(key));
        if (stillMissingKeys.length) failedCount += stillMissingKeys.length;
        if (materializeToken === mfFranceDayMaterializeToken && startCenterToken === centerChangeToken && selectedBaseDate === startDate) {
          const cachedKeys = Array.from(meteoFranceGribCachedSlotKeys || []);
          if (typeof rememberMeteoFranceGribCacheStatus === 'function') rememberMeteoFranceGribCacheStatus(startDate, cachedKeys);
          lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : lastFetchSignature;
          renderDayButtons();
          renderSlotButtons();
          if (mergedCount > 0 && typeof updateMetaLine === 'function') updateMetaLine();
          queueAromeFranceGeojsonPrewarm();
          if (typeof maybePrecomputePredictionPageImage === 'function') maybePrecomputePredictionPageImage();
          if (currentSlotUsesMeteoFranceGrib()) {
            shouldAnimateNextGrid = false;
            scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          }
          if (!quiet && typeof setMeteoFranceTestStatus === 'function') {
            const totalLoaded = aromeFranceLoadedSlotKeys().size;
            const failedText = failedCount ? `, ${failedCount} heure(s) encore absente(s) du cache national` : '';
            setMeteoFranceTestStatus(`Grilles horaires France AROME matérialisées : ${totalLoaded}/24 prêtes côté navigateur${failedText}.`, failedCount ? 'waiting' : 'ok');
          }
        }
        return mergedCount > 0;
      })();
      try {
        return await mfFranceDayMaterializePromise;
      } finally {
        if (mfFranceDayMaterializeKey === materializeKey) mfFranceDayMaterializePromise = null;
      }
    }

    async function maybeLoadCachedMeteoFranceGribForSelectedSlot({ quiet = true, force = false, buildFromNationalCache = true } = {}) {
      const token = "";
      const dateStatus = getMeteoFranceWcsDateStatus(selectedBaseDate, { allowPreviousDay: true });
      if (!dateStatus.ok) return false;
      const hour = selectedMeteoFranceHour();
      const slotKey = slotKeyForMeteoFranceHour(hour);
      if (selectedSlotKey !== slotKey) return false;
      const currentDay = getCurrentDay();
      const currentSlot = currentDay?.slots?.find((slot) => slot?.slot_key === slotKey);
      if (currentSlot && typeof isMeteoFranceSlotUnavailable === 'function' && isMeteoFranceSlotUnavailable(currentSlot, currentDay)) return false;
      if (!force && currentSlotUsesMeteoFranceGrib()) return false;

      const requestToken = ++mfCachedGribFetchToken;
      const startCenterToken = centerChangeToken;
      const startDate = selectedBaseDate;
      const startCenter = { ...currentCenter };
      const body = withMeteoFranceToken({
        lat: startCenter.lat,
        lon: startCenter.lon,
        label: startCenter.label,
        date: startDate,
        hour,
        detail_level: 'core',
      }, token);
      const candidates = [
        { endpoint: '/api/meteofrance/grib-france-slot-grid-cache', france: true },
      ];

      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => ({}));
          if (requestToken !== mfCachedGribFetchToken || startCenterToken !== centerChangeToken || selectedBaseDate !== startDate || selectedSlotKey !== slotKey) {
            return false;
          }
          if (!data?.ok || !data?.payload) continue;
          if (!mergeMeteoFranceSlotPayload(data.payload, hour)) continue;

          lastFetchSignature = typeof currentAromeFrancePayloadSignature === 'function' ? currentAromeFrancePayloadSignature(startDate) : currentLatestPayloadSignature();
          shouldAnimateNextGrid = !quiet;
          lastFetchAt = Date.now();
          updateMetaLine();
          renderDayButtons();
          renderSlotButtons();
          scheduleLoadedGridSync(centerChangeToken, selectedDayKey, selectedSlotKey);
          const cells = getCurrentSlot()?.cells || [];
          const isFranceGrid = candidate.france || data.payload?.meta?.grid_scope === 'france' || data.payload?.meta?.france_grid;
          if (isFranceGrid) fitMapToCells(cells, { maxZoom: 6.2, duration: quiet ? 0 : 750 });
          if (!quiet) {
            const cellCount = Number(cells.length || 0);
            const scopeLabel = isFranceGrid ? 'France AROME GRIB' : 'AROME GRIB';
            setMeteoFranceTestStatus('Grille ' + scopeLabel + ' chargée automatiquement depuis le cache pour ' + String(hour).padStart(2, '0') + 'h : ' + cellCount + ' cellules, 0 Range API.', 'ok');
          }
          return true;
        } catch (_) {
          continue;
        }
      }
      if (buildFromNationalCache && !quiet && typeof setMeteoFranceTestStatus === 'function') {
        setMeteoFranceTestStatus('Heure absente du cache France matérialisé : attente du préchargement serveur par paquets complets.', 'waiting');
      }
      return false;
    }




    function setupPrimaryControls() {
      toggleSearchBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const shouldOpen = !topbar.classList.contains('show-search');
        closeTopPanels();
        if (cityInput) {
          cityInput.value = '';
          cityInput.placeholder = 'Tape une ville, un secteur ou un point de départ…';
        }
        if (shouldOpen) {
          topbar.classList.add('show-search');
          requestAnimationFrame(() => cityInput?.focus({ preventScroll: true }));
        }
        requestAnimationFrame(alignTopPanels);
      });
      // Fermeture au tap/clic EN DEHORS du dock de recherche (toggle + panneau vivent
      // dans #topbar) — surtout tactile, où rien ne refermait le panneau.
      if (window.OFDismiss && topbar) {
        window.OFDismiss.register({
          el: topbar,
          isOpen: () => topbar.classList.contains('show-search'),
          close: closeTopPanels,
        });
      }
      // Carte de sélection (clic cellule sur la carte de base) : au TACTILE, un tap
      // ailleurs la referme (le bouton ✕ restait la seule sortie). coarseOnly → le pan
      // souris desktop ne la ferme pas intempestivement.
      if (window.OFDismiss && selectionCard) {
        window.OFDismiss.register({
          el: selectionCard,
          isOpen: () => selectionCard.classList.contains('visible'),
          close: closeSelection,
          coarseOnly: true,
        });
      }
      closeSelectionBtn?.addEventListener('click', closeSelection);
      openDetailsBtn?.addEventListener('click', openDetails);
      recenterBtn?.addEventListener('click', () => {
        if (!selectedFeature) return;
        map.easeTo({ center: [Number(selectedFeature.lon), Number(selectedFeature.lat)], duration: 700, zoom: Math.max(map.getZoom(), 10.2) });
      });
      closeDetailsBtn?.addEventListener('click', closeDetails);
      modalBackdrop?.addEventListener('click', closeDetails);
      infoDrawerBtn?.addEventListener('click', () => infoDrawer.classList.contains('visible') ? closeInfoDrawer() : openInfoDrawer());
      closeDrawerBtn?.addEventListener('click', closeInfoDrawer);
      drawerBackdrop?.addEventListener('click', closeInfoDrawer);
      initializeMeteoFranceApiKeyField();
      if (typeof probeMeteoFranceGribFullPackage === 'function') {
        mfGribFullPackageProbeBtn?.addEventListener('click', probeMeteoFranceGribFullPackage);
      } else if (mfGribFullPackageProbeBtn) {
        mfGribFullPackageProbeBtn.hidden = true;
      }
      mfTokenInput?.addEventListener('input', persistCurrentMeteoFranceApiKey);
      locateBtn?.addEventListener('click', locateUser);
      bestCellsBtn?.addEventListener('click', toggleBestCellsMode);
      exportGifBtn?.addEventListener('click', toggleExportFormatMenu);
      predictionPageBtn?.addEventListener('click', () => {
        if (typeof openPredictionPage === 'function') openPredictionPage();
      });
      predictionPageCloseBtn?.addEventListener('click', () => {
        if (typeof closePredictionPage === 'function') closePredictionPage();
      });
      if (typeof aroundMeBtn !== 'undefined' && aroundMeBtn) aroundMeBtn.addEventListener('click', locateUser);
      searchCityBtn?.addEventListener('click', handleCitySearch);
      cityInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') handleCitySearch(); });
      document.addEventListener('click', (event) => {
        if (!topbar.contains(event.target)) closeTopPanels();
        if (exportFormatMenu?.classList.contains('visible')) {
          const target = event.target;
          if (!exportFormatMenu.contains(target) && !exportGifBtn?.contains(target)) closeExportFormatMenu();
        }
      });
      window.addEventListener('resize', closeExportFormatMenu);
      window.addEventListener('orientationchange', closeExportFormatMenu);


      if (todayBtn) {
        todayBtn.addEventListener('click', () => applySelectedDate(getTodayIsoDate(), { force: true, loadingMessage: 'Chargement de la date du jour…' }));
      }
      playTimelineBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof toggleTimelinePlayback === 'function') toggleTimelinePlayback();
      });
      if (dateInput) {
        dateInput.addEventListener('change', (event) => {
          const nextDate = normalizeDateIso(event.target?.value);
          applySelectedDate(nextDate, { force: true, loadingMessage: 'Chargement de la date…' });
        });
      }
      if (prevDayBtn) {
        prevDayBtn.addEventListener('click', () => {
          shiftSelectedDate(-1, 'Chargement du jour précédent…');
        });
      }
      if (nextDayBtn) {
        nextDayBtn.addEventListener('click', () => {
          shiftSelectedDate(1, 'Chargement du jour suivant…');
        });
      }

      setupSlotButtonsDrag();
      setupMetricInfoTriggers();
      setupTimelineToggle();
      setupBottomUiLayoutSync();

      installChip?.addEventListener('click', installApp);
    }
