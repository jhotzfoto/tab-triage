// Tab Triage app window: guided setup. The native side (ViewController.swift) calls
// TabTriageApp.setup({...}) once and TabTriageApp.state({ enabled }) whenever it re-checks.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const post = (msg) => { try { webkit.messageHandlers.controller.postMessage(msg); } catch (e) { /* preview outside the app */ } };
  let enabled = null;

  function ticked() { return [...document.querySelectorAll('input[data-step]:checked')].map((i) => i.dataset.step); }

  function render() {
    const status = $('#status');
    $('#step-enable').classList.toggle('done', enabled === true);
    status.className = 'status ' + (enabled === true ? 'on' : enabled === false ? 'off' : 'unknown');
    status.textContent = enabled === true ? 'On'
      : enabled === false ? 'Off: tick Tab Triage in the list.'
        : "Safari doesn't see Tab Triage yet. Open Safari once, then check its Extensions list.";
    for (const box of document.querySelectorAll('input[data-step]')) {
      box.closest('.step').classList.toggle('done', box.checked);
    }
    const all = enabled === true && ticked().length === 3;
    $('#ready').classList.toggle('hidden', !all);
  }

  window.TabTriageApp = {
    setup(info) {
      $('#version').textContent = info.version ? `Version ${info.version}` + (info.build ? ` (${info.build})` : '') : '';
      $('#unsigned').classList.toggle('hidden', info.signed !== false);
      for (const el of document.querySelectorAll('.sw')) el.textContent = info.settingsWord || 'Settings';
      for (const box of document.querySelectorAll('input[data-step]')) box.checked = (info.steps || []).includes(box.dataset.step);
      render();
    },
    state(s) { enabled = typeof s.enabled === 'boolean' ? s.enabled : null; render(); }
  };

  $('#open-settings').addEventListener('click', () => post({ action: 'open-safari-settings' }));
  for (const box of document.querySelectorAll('input[data-step]')) {
    box.addEventListener('change', () => { post({ action: 'save-steps', steps: ticked() }); render(); });
  }
  for (const a of document.querySelectorAll('a[data-url]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); post({ action: 'open-url', url: a.dataset.url }); });
  }
  render();
})();
