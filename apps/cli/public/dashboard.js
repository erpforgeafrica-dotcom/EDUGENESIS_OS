/* EduGenesis OS — dashboard renderer.

   One dependency-free file, three surfaces (learner, sponsor, operator).
   Three rules govern it:

     1. The server is the only source of every number. Nothing is cached,
        inferred, or defaulted to zero. A missing field is shown as missing.
     2. If the API is unavailable, the page says so in a live region and in the
        affected sections. It never renders plausible-looking zeros.
     3. A control action is never claimed as successful until the server has
        answered. The two-person rule is enforced in the client and, crucially,
        the server is the authority for the outcome.
 */
(function () {
  'use strict';

  var surface = document.body ? document.body.getAttribute('data-surface') : null;
  if (!surface) return;

  var ELLIPSIS = '\u2026';

  function byId(id) { return document.getElementById(id); }

  function setStatus(el, message, tone) {
    if (!el) return;
    el.textContent = message || '';
    if (tone) el.setAttribute('data-tone', tone);
    else el.removeAttribute('data-tone');
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function fmtNumber(value) {
    try { return new Intl.NumberFormat(undefined).format(value); }
    catch (error) { return String(value); }
  }

  function fmtCurrency(value, currency) {
    if (!isNumber(value)) return null;
    if (typeof currency === 'string' && currency.length > 0) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(value);
      } catch (error) { /* fall through to a plain, labelled number */ }
    }
    return fmtNumber(value) + (currency ? ' ' + currency : '');
  }

  function fmtTime(iso) {
    if (typeof iso !== 'string' || iso.length === 0) return null;
    var date = new Date(iso);
    if (isNaN(date.getTime())) return null;
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch (error) { return date.toISOString(); }
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (value.charAt(0) === '/') return value;
    if (value.indexOf('https://') === 0 || value.indexOf('http://') === 0) return value;
    return null;
  }

  function setAllBusy(busy) {
    var nodes = document.querySelectorAll('[aria-busy]');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function addMetric(grid, value, label) {
    if (!grid) return;
    var cell = make('div', 'card db-metric');
    cell.appendChild(make('p', 'db-metric__value', value));
    cell.appendChild(make('p', 'db-metric__label', label));
    grid.appendChild(cell);
  }

  function showEmpty(element, show) {
    if (element) element.hidden = !show;
  }

  function setOfflineEmpty(ids, messages) {
    ids.forEach(function (id, index) {
      var element = byId(id);
      if (!element) return;
      element.hidden = false;
      element.textContent = messages[index] || messages[0];
    });
  }

  function readJson(response) {
    return response.json().then(function (data) { return { ok: response.ok, data: data }; })
      .catch(function () { return { ok: false, data: null }; });
  }

  /* ------------------------------ learner ------------------------------ */

  function renderLearner(data) {
    var grid = byId('progress-grid');
    var empty = byId('progress-empty');
    var progress = data.progress;
    var hasProgress = progress && (isNumber(progress.lessonsCompleted) || isNumber(progress.topicsExplored));

    clear(grid);
    if (hasProgress) {
      if (isNumber(progress.lessonsCompleted)) {
        addMetric(grid, fmtNumber(progress.lessonsCompleted), 'Lessons completed');
      }
      if (isNumber(progress.topicsExplored)) {
        addMetric(grid, fmtNumber(progress.topicsExplored), 'Topics explored');
      }
      showEmpty(empty, false);
    } else {
      showEmpty(empty, true);
    }

    var card = byId('next-card');
    var nextEmpty = byId('next-empty');
    var next = data.nextLesson;
    if (next && typeof next.title === 'string' && next.title.length > 0) {
      byId('next-topic').textContent = typeof next.topic === 'string' ? next.topic : '';
      byId('next-title').textContent = next.title;
      byId('next-description').textContent = typeof next.description === 'string' ? next.description : '';
      card.hidden = false;
      showEmpty(nextEmpty, false);
    } else {
      card.hidden = true;
      showEmpty(nextEmpty, true);
    }
  }

  function offlineLearner() {
    clear(byId('progress-grid'));
    byId('next-card').hidden = true;
    setOfflineEmpty(
      ['progress-empty', 'next-empty'],
      [
        'Offline. Progress could not be loaded because the server did not respond. No numbers are shown.',
        'Offline. A next lesson cannot be suggested until the server responds.'
      ]
    );
  }

  /* ------------------------------ sponsor ------------------------------ */

  function renderSponsor(data) {
    var funding = data.funding;
    var fundingGrid = byId('funding-grid');
    var fundingEmpty = byId('funding-empty');
    clear(fundingGrid);
    if (funding && (isNumber(funding.totalCommitted) || isNumber(funding.totalDisbursed))) {
      if (isNumber(funding.totalCommitted)) {
        addMetric(fundingGrid, fmtCurrency(funding.totalCommitted, funding.currency) || 'Not available', 'Total committed');
      }
      if (isNumber(funding.totalDisbursed)) {
        addMetric(fundingGrid, fmtCurrency(funding.totalDisbursed, funding.currency) || 'Not available', 'Total disbursed');
      }
      showEmpty(fundingEmpty, false);
    } else {
      showEmpty(fundingEmpty, true);
    }

    var impact = data.impact;
    var impactGrid = byId('impact-grid');
    var impactEmpty = byId('impact-empty');
    var reached = impact ? impact.learnersReached : null;
    var suppressed = !isNumber(reached);
    var hasReached = isNumber(reached);
    clear(impactGrid);
    if (impact && (isNumber(impact.lessonsDelivered) || hasReached)) {
      if (isNumber(impact.lessonsDelivered)) {
        addMetric(impactGrid, fmtNumber(impact.lessonsDelivered), 'Lessons delivered');
      }
      if (hasReached) {
        addMetric(impactGrid, fmtNumber(reached), 'Learners reached');
      }
      if (typeof impact.reportingPeriod === 'string' && impact.reportingPeriod.length > 0) {
        addMetric(impactGrid, impact.reportingPeriod, 'Reporting period');
      }
      showEmpty(impactEmpty, false);
    } else {
      showEmpty(impactEmpty, true);
    }
    showEmpty(byId('impact-suppression-note'), suppressed && !!(impact && typeof impact.reportingPeriod === 'string'));

    var ledger = data.ledger;
    var stateLabels = {
      verified: 'Verified',
      anchored: 'Anchored and verified',
      pending: 'Pending verification',
      unverified: 'Unverified'
    };
    byId('ledger-root').textContent = (ledger && typeof ledger.root === 'string' && ledger.root.length > 0)
      ? ledger.root : 'Not available';
    var ledgerState = (ledger && typeof ledger.verificationState === 'string' && hasOwn(stateLabels, ledger.verificationState))
      ? stateLabels[ledger.verificationState] : 'Not available';
    var ledgerBadge = byId('ledger-state');
    ledgerBadge.textContent = ledgerState;
    if (ledgerState === 'Verified' || ledgerState === 'Anchored and verified') ledgerBadge.setAttribute('data-tone', 'ok');
    else if (ledgerState === 'Unverified') ledgerBadge.setAttribute('data-tone', 'error');
    else ledgerBadge.removeAttribute('data-tone');
    byId('ledger-anchored').textContent = (ledger && fmtTime(ledger.lastAnchoredAt)) || 'Not available';

    var report = data.report;
    var reportBadge = byId('report-status');
    var reportNote = byId('report-note');
    var download = byId('report-download');
    var isDraft = !report || report.status !== 'final';
    if (report && typeof report.status === 'string') {
      reportBadge.textContent = isDraft ? 'UNVERIFIED — DRAFT' : 'Verified final report';
      if (isDraft) {
        reportBadge.setAttribute('data-tone', 'draft');
        reportNote.textContent = 'This report is a draft and has not been verified. Do not rely on its figures.';
      } else {
        reportBadge.setAttribute('data-tone', 'ok');
        reportNote.textContent = report.generatedAt
          ? 'Generated ' + (fmtTime(report.generatedAt) || 'at an unrecorded time') + '.'
          : 'Final report.';
      }
      var url = safeUrl(report.url);
      if (url) { download.setAttribute('href', url); download.hidden = false; }
      else { download.removeAttribute('href'); download.hidden = true; }
    } else {
      reportBadge.textContent = 'Not available';
      reportBadge.removeAttribute('data-tone');
      reportNote.textContent = 'No report information has been received from the server.';
      download.hidden = true;
    }
  }

  function offlineSponsor() {
    clear(byId('funding-grid'));
    clear(byId('impact-grid'));
    setOfflineEmpty(
      ['funding-empty', 'impact-empty'],
      [
        'Offline. Funding totals could not be loaded because the server did not respond. No figures are shown.',
        'Offline. Impact figures could not be loaded because the server did not respond. No figures are shown.'
      ]
    );
    byId('impact-suppression-note').hidden = true;
    byId('ledger-root').textContent = 'Not available — server did not respond';
    byId('ledger-state').textContent = 'Not available';
    byId('ledger-state').removeAttribute('data-tone');
    byId('ledger-anchored').textContent = 'Not available';
    byId('report-status').textContent = 'Not available';
    byId('report-status').removeAttribute('data-tone');
    byId('report-note').textContent = 'No report information could be retrieved; nothing is shown as verified.';
    byId('report-download').hidden = true;
  }

  /* ------------------------------ operator ----------------------------- */

  function renderOperator(data) {
    var health = data.health;
    var healthLabels = { operational: 'Operational', degraded: 'Degraded', down: 'Down' };
    var healthState = byId('health-state');
    healthState.textContent = (health && typeof health.status === 'string' && hasOwn(healthLabels, health.status))
      ? healthLabels[health.status] : 'Not available';
    if (healthState.textContent === 'Operational') healthState.setAttribute('data-tone', 'ok');
    else if (healthState.textContent === 'Degraded' || healthState.textContent === 'Down') healthState.setAttribute('data-tone', 'error');
    else healthState.removeAttribute('data-tone');
    var checked = health && fmtTime(health.checkedAt);
    byId('health-time').textContent = checked ? 'Last checked ' + checked + '.' : 'No health reading has been received.';

    var tiers = data.tiers;
    var tiersList = byId('tiers-list');
    var tiersEmpty = byId('tiers-empty');
    clear(tiersList);
    if (Array.isArray(tiers) && tiers.length > 0) {
      tiers.forEach(function (tier) {
        var row = make('li');
        row.appendChild(make('span', 'db-metric__label', (tier && tier.tier) || 'Unnamed tier'));
        row.appendChild(make('span', '', (tier && tier.provider) || 'Not reported'));
        var status = (tier && typeof tier.status === 'string') ? tier.status : 'not reported';
        row.appendChild(make('span', 'db-badge', status.charAt(0).toUpperCase() + status.slice(1)));
        tiersList.appendChild(row);
      });
      showEmpty(tiersEmpty, false);
    } else {
      showEmpty(tiersEmpty, true);
    }

    var budget = data.budget;
    var budgetGrid = byId('budget-grid');
    var budgetEmpty = byId('budget-empty');
    clear(budgetGrid);
    if (budget && (isNumber(budget.unitsUsed) || isNumber(budget.unitsCap) ||
                   isNumber(budget.tokensUsed) || isNumber(budget.burnRatePerHour))) {
      if (isNumber(budget.unitsUsed)) addMetric(budgetGrid, fmtNumber(budget.unitsUsed), 'Budget units used');
      if (isNumber(budget.unitsCap)) addMetric(budgetGrid, fmtNumber(budget.unitsCap), 'Hard cap (units)');
      if (isNumber(budget.tokensUsed)) addMetric(budgetGrid, fmtNumber(budget.tokensUsed), 'Tokens used');
      if (isNumber(budget.burnRatePerHour)) addMetric(budgetGrid, fmtNumber(budget.burnRatePerHour), 'Tokens per hour');
      showEmpty(budgetEmpty, false);
    } else {
      showEmpty(budgetEmpty, true);
    }

    var controls = data.controls;
    var controlNote = byId('control-state-note');
    if (controls && typeof controls.state === 'string') {
      controlNote.textContent = 'Current state as reported: ' + controls.state + '.';
    } else {
      controlNote.textContent = 'Current state has not been reported by the server.';
    }

    var audit = data.audit;
    var auditList = byId('audit-list');
    var auditEmpty = byId('audit-empty');
    clear(auditList);
    if (Array.isArray(audit) && audit.length > 0) {
      audit.forEach(function (entry) {
        var row = make('li');
        var when = entry && fmtTime(entry.at);
        var timeEl = make('time', '', when || 'Time not reported');
        if (entry && typeof entry.at === 'string') timeEl.setAttribute('datetime', entry.at);
        row.appendChild(timeEl);
        row.appendChild(make('span', '', (entry && entry.action) || 'Unnamed action'));
        row.appendChild(make('span', 'db-audit-detail', 'Actor: ' + ((entry && entry.actor) || 'Not reported')));
        row.appendChild(make('span', 'db-audit-detail', 'Approver: ' + ((entry && entry.approver) || 'Not reported')));
        row.appendChild(make('span', 'db-audit-detail', 'Reason: ' + ((entry && entry.reason) || 'Not reported')));
        auditList.appendChild(row);
      });
      showEmpty(auditEmpty, false);
    } else {
      showEmpty(auditEmpty, true);
    }
  }

  function offlineOperator() {
    clear(byId('tiers-list'));
    clear(byId('budget-grid'));
    clear(byId('audit-list'));
    setOfflineEmpty(
      ['tiers-empty', 'budget-empty', 'audit-empty'],
      [
        'Offline. Provider availability could not be loaded because the server did not respond.',
        'Offline. Budget figures could not be loaded because the server did not respond. No numbers are shown.',
        'Offline. The audit trail could not be loaded because the server did not respond.'
      ]
    );
    byId('health-state').textContent = 'Not available';
    byId('health-state').removeAttribute('data-tone');
    byId('health-time').textContent = 'No health reading could be retrieved.';
    byId('control-state-note').textContent = 'Current state has not been reported by the server.';
  }

  /* ------------------------- two-person control ------------------------ */

  function initControls() {
    var actor = byId('ctl-actor');
    var reason = byId('ctl-reason');
    var approver = byId('ctl-approver');
    var confirm = byId('ctl-confirm');
    var kill = byId('ctl-kill');
    var revive = byId('ctl-revive');
    var status = byId('control-status');
    if (!actor || !reason || !approver || !confirm || !kill || !revive) return;

    function ready() {
      return actor.value.trim().length > 0 &&
        reason.value.trim().length > 0 &&
        approver.value.trim().length > 0 &&
        confirm.checked;
    }

    function updateButtons() {
      var allowed = ready();
      kill.disabled = !allowed;
      revive.disabled = !allowed;
      if (allowed) {
        setStatus(status, 'All four conditions are present. The server must still confirm any action before success is claimed.');
      } else {
        setStatus(status, 'Both actions stay disabled until an actor, a reason, a second person, and the confirmation are present.');
      }
    }

    [actor, reason, approver, confirm].forEach(function (element) {
      element.addEventListener('input', updateButtons);
      element.addEventListener('change', updateButtons);
    });
    updateButtons();

    function submit(action) {
      if (!ready()) return;
      kill.disabled = true;
      revive.disabled = true;
      setStatus(status, 'Submitting ' + action + ' for server confirmation' + ELLIPSIS);

      fetch('/api/dashboard/operator/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          action: action,
          actor: actor.value.trim(),
          reason: reason.value.trim(),
          approver: approver.value.trim()
        })
      })
        .then(readJson)
        .then(function (result) {
          updateButtons();
          if (!result.ok || !result.data) {
            setStatus(status,
              (result.data && typeof result.data.error === 'string') ? result.data.error
                : 'The server did not confirm the action. Its outcome is unknown; no success is claimed.',
              'error');
            return;
          }
          var message = (typeof result.data.message === 'string' && result.data.message.length > 0)
            ? result.data.message : 'The server confirmed the action.';
          setStatus(status, message, 'ok');
          fetchSurface(config.operator);
        })
        .catch(function () {
          updateButtons();
          setStatus(status, 'Offline. The action was not confirmed by the server, so no success is claimed.', 'error');
        });
    }

    kill.addEventListener('click', function () { submit('kill'); });
    revive.addEventListener('click', function () { submit('revive'); });
  }

  /* ------------------------------- fetch ------------------------------- */

  function fetchSurface(conf) {
    var status = byId('page-status');
    setStatus(status, 'Loading dashboard' + ELLIPSIS);
    setAllBusy(true);
    fetch(conf.url, { headers: { 'Accept': 'application/json' }, cache: 'no-store' })
      .then(readJson)
      .then(function (result) {
        setAllBusy(false);
        if (!result.ok || !result.data || typeof result.data !== 'object') {
          conf.offline();
          setStatus(status, 'Unavailable. The server returned no dashboard data, so no figures are shown.', 'error');
          return;
        }
        conf.render(result.data);
        setStatus(status, 'Dashboard data loaded from the server.', 'ok');
      })
      .catch(function () {
        setAllBusy(false);
        conf.offline();
        setStatus(status, 'Offline. The server did not respond, so no figures are shown.', 'error');
      });
  }

  var config = {
    learner: { url: '/api/dashboard/learner', render: renderLearner, offline: offlineLearner },
    sponsor: { url: '/api/dashboard/sponsor', render: renderSponsor, offline: offlineSponsor },
    operator: { url: '/api/dashboard/operator', render: renderOperator, offline: offlineOperator }
  };

  var chosen = config[surface];
  if (!chosen) return;
  fetchSurface(chosen);
  if (surface === 'operator') initControls();
})();
