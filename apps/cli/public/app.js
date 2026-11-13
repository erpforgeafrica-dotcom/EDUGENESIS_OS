/* ==========================================================================
   EduGenesis OS — Settings UI behaviour.
   Plain JavaScript. No build step, no framework, no dependency.
   An API key is write-only: this script can SEND a key but can never READ one.
   ========================================================================== */
(function () {
  'use strict';

  var form = document.getElementById('settings-form');
  var status = document.getElementById('status');
  var keysContainer = document.getElementById('api-keys');
  var newKeyName = document.getElementById('providers-apiKey-new-name');
  var newKeyValue = document.getElementById('providers-apiKey-new');
  var reloadButton = document.getElementById('reload-button');

  var knownKeys = {};
  var removedKeys = {};

  function setStatus(message, tone) {
    status.textContent = message;
    status.setAttribute('data-tone', tone || 'ok');
  }

  function field(name) {
    return form.querySelector('[name="' + name + '"]');
  }

  function setField(name, value) {
    var element = field(name);
    if (!element) {
      return;
    }
    if (element.type === 'checkbox') {
      element.checked = value === true;
      return;
    }
    element.value = value === undefined || value === null ? '' : String(value);
  }

  function numberOf(element, fallback) {
    if (!element) {
      return fallback;
    }
    var parsed = Number(element.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /* ---- API key rows ---------------------------------------------------- */

  function renderKeyRows() {
    keysContainer.textContent = '';
    var names = Object.keys(knownKeys).sort();

    if (names.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No provider key is stored yet.';
      keysContainer.appendChild(empty);
      return;
    }

    names.forEach(function (name) {
      var info = knownKeys[name] || { set: false, length: 0 };
      var row = document.createElement('div');
      row.className = 'eg-keys__row';

      var label = document.createElement('label');
      label.setAttribute('for', 'key-' + name);
      label.textContent = name;
      label.style.flex = '0 0 10rem';
      label.style.fontFamily = 'var(--eg-font-mono)';

      var input = document.createElement('input');
      input.id = 'key-' + name;
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.setAttribute('aria-describedby', 'key-status-' + name);
      input.placeholder = info.set ? 'stored — leave blank to keep' : 'not set';

      var state = document.createElement('span');
      state.id = 'key-status-' + name;
      state.className = 'eg-keys__status';
      state.textContent = info.set ? 'set (' + info.length + ' chars)' : 'not set';

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--quiet';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        removedKeys[name] = true;
        input.value = '';
        input.placeholder = 'will be removed on save';
        state.textContent = 'marked for removal';
        setStatus('The key "' + name + '" will be removed when you save.', 'ok');
      });

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(state);
      row.appendChild(remove);
      keysContainer.appendChild(row);
    });
  }

  /* ---- load ------------------------------------------------------------ */

  function applySettings(settings) {
    setField('server.host', settings.server && settings.server.host);
    setField('server.port', settings.server && settings.server.port);
    setField('paths.dataDir', settings.paths && settings.paths.dataDir);
    setField('providers.primary', settings.providers && settings.providers.primary);
    setField('providers.secondary', settings.providers && settings.providers.secondary);
    setField('providers.local', settings.providers && settings.providers.local);

    var features = settings.features || {};
    setField('features.accessibilityGuardian', features.accessibilityGuardian);
    setField('features.offlineBundle', features.offlineBundle);
    setField('features.telemetry', features.telemetry);
    setField('features.publicAnchoring', features.publicAnchoring);

    var limits = settings.limits || {};
    setField('limits.budgetUnits', limits.budgetUnits);
    setField('limits.mediaBudgetBytes', limits.mediaBudgetBytes);
    setField('limits.confidenceThreshold', limits.confidenceThreshold);

    knownKeys = (settings.providers && settings.providers.apiKeys) || {};
    removedKeys = {};
    renderKeyRows();
  }

  function load(notice) {
    setStatus('Loading…', 'ok');
    fetch('/api/settings', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.json();
      })
      .then(function (payload) {
        if (!payload || payload.ok !== true) {
          setStatus('Could not read the settings: ' + ((payload && payload.error) || 'unknown error'), 'error');
          return;
        }
        applySettings(payload.settings);
        setStatus(notice || 'Loaded from ' + (payload.file || 'the settings file') + '.', 'ok');
      })
      .catch(function (error) {
        setStatus('Could not reach the local server: ' + error.message, 'error');
      });
  }

  /* ---- save ------------------------------------------------------------ */

  function collect() {
    var apiKeys = {};

    Object.keys(knownKeys).forEach(function (name) {
      var input = document.getElementById('key-' + name);
      var value = input ? input.value : '';
      if (removedKeys[name]) {
        apiKeys[name] = null;
        return;
      }
      if (value.length > 0) {
        apiKeys[name] = value;
      }
    });

    var name = newKeyName.value.trim();
    var secret = newKeyValue.value;
    if (name.length > 0 && secret.length > 0) {
      apiKeys[name] = secret;
    }

    return {
      server: {
        host: (field('server.host') || {}).value || '127.0.0.1',
        port: numberOf(field('server.port'), 8787)
      },
      paths: {
        dataDir: (field('paths.dataDir') || {}).value || './.edugenesis-data'
      },
      providers: {
        primary: (field('providers.primary') || {}).value || 'local-echo',
        secondary: (field('providers.secondary') || {}).value || 'local-echo',
        local: (field('providers.local') || {}).value || 'local-echo',
        apiKeys: apiKeys
      },
      features: {
        accessibilityGuardian: (field('features.accessibilityGuardian') || {}).checked === true,
        offlineBundle: (field('features.offlineBundle') || {}).checked === true,
        telemetry: (field('features.telemetry') || {}).checked === true,
        publicAnchoring: (field('features.publicAnchoring') || {}).checked === true
      },
      limits: {
        budgetUnits: numberOf(field('limits.budgetUnits'), 0),
        mediaBudgetBytes: numberOf(field('limits.mediaBudgetBytes'), 0),
        confidenceThreshold: numberOf(field('limits.confidenceThreshold'), 0.7)
      }
    };
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    setStatus('Saving…', 'ok');
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect())
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.payload || result.payload.ok !== true) {
          setStatus('Not saved: ' + ((result.payload && result.payload.error) || 'unknown error'), 'error');
          return;
        }
        applySettings(result.payload.settings);
        newKeyName.value = '';
        newKeyValue.value = '';
        setStatus(
          'Saved to ' + (result.payload.file || 'the settings file') + '. ' + (result.payload.notice || ''),
          'ok'
        );
      })
      .catch(function (error) {
        setStatus('Could not save: ' + error.message, 'error');
      });
  });

  if (reloadButton) {
    reloadButton.addEventListener('click', function () {
      load();
    });
  }

  /* ---- hosted demonstration -------------------------------------------- */

  // The Render deployment serves this same UI, but settings are read-only
  // there. Ask the server which mode it is in before enabling the form, so a
  // hosted visitor never types into a form that cannot save.
  fetch('/api/health', { headers: { Accept: 'application/json' } })
    .then(function (response) {
      return response.json();
    })
    .then(function (health) {
      return health && health.hosted === true;
    })
    .catch(function () {
      return false;
    })
    .then(function (hosted) {
      var submit = form.querySelector('button[type="submit"]');
      if (hosted && submit) {
        submit.disabled = true;
        submit.textContent = 'Read-only on the hosted demonstration';
      }
      load(
        hosted
          ? 'Hosted demonstration: settings are read-only. Run the project locally to change them.'
          : undefined
      );
    });
})();
