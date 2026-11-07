// ==UserScript==
// @name         LSS Ausbildungssteuerung by DieRaubsau
// @namespace    https://www.leitstellenspiel.de/
// @version      0.4.3
// @author       DieRaubsau
// @description  Plant die Personalverteilung fortlaufend über Klassen und Schulen. Ausbildungsstart immer manuell.
// @match        https://www.leitstellenspiel.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self || document.getElementById('lsa-panel')) return;

  const STORE = 'lssAusbildung_';
  const SCHOOL_TYPES = {
    1: 'Feuerwehrschule', 3: 'Rettungsschule', 8: 'Polizeischule',
    10: 'THW Bundesschule', 27: 'Schule für Seefahrt und Seenotrettung'
  };
  const SOURCE_GROUPS = [
    ['Feuerwehr', [0]], ['Rettung', [2, 4, 5, 12, 21]],
    ['Polizei', [6, 11, 17, 13, 24, 29]], ['THW', [9]],
    ['Wasserrettung', [15]], ['Bergrettung', [25]], ['Seenotrettung', [26, 28]]
  ];
  const DEFAULTS = {
    schoolType: '1', educationKey: '', perBuilding: 12, maxClassrooms: 160,
    prior: 'any', priorKey: '',
    sourceTypes: [0, 2, 4, 5, 12, 21], sourceMode: 'all', selectedSourceIds: [], schoolIndex: 0
  };
  let cfg = Object.assign({}, DEFAULTS);
  try { cfg = Object.assign(cfg, JSON.parse(localStorage.getItem(STORE + 'cfg') || '{}')); } catch (_) {}
  const save = () => { try { localStorage.setItem(STORE + 'cfg', JSON.stringify(cfg)); } catch (_) {} };
  const state = {
    schools: [], sources: [], allBuildings: [], educations: [], plan: null,
    busy: false, stop: false, currentDoc: null
  };
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const buildingName = b => b.caption || b.name || ('Wache ' + b.id);
  const log = msg => {
    console.log('[LSS Ausbildung]', msg);
    const el = $('#lsa-log');
    if (!el) return;
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString('de-DE') + ' ' + msg;
    el.prepend(line);
    while (el.children.length > 60) el.lastChild.remove();
  };
  const status = msg => { const el = $('#lsa-status'); if (el) el.textContent = msg; };
  const option = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
  const courseKey = value => String(value || '').split(':')[0];

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.json();
  }
  async function getBuildings() { return getJson('/api/buildings'); }
  async function waitFor(fn, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const v = fn(); if (v) return v; await sleep(200); }
    return null;
  }

  // UI
  const panel = document.createElement('section');
  panel.id = 'lsa-panel';
  panel.style.cssText = 'position:fixed;left:12px;top:12px;width:340px;max-height:92vh;overflow:auto;z-index:999999;background:#20252b;color:#fff;border:1px solid #66717d;border-radius:8px;padding:12px;box-shadow:0 3px 16px #0009;font:13px/1.45 Arial,sans-serif';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:16px;font-weight:bold;margin-bottom:8px"><span>🎓 Ausbildungssteuerung by DieRaubsau</span><button id="lsa-minimize" style="padding:3px 7px;background:#e5e7eb;color:#111;border:1px solid #9ca3af;border-radius:4px">Minimieren</button></div>
    <div id="lsa-content">
    <label>Schultyp<select id="lsa-schooltype" style="width:100%;color:#111"></select></label>
    <label style="display:block;margin-top:7px">Lehrgang<select id="lsa-course" style="width:100%;color:#111"><option value="">Zuerst Schulen laden</option></select></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px">
      <label>TN je Quell-Wache<input id="lsa-count" type="number" min="1" max="300" style="width:100%;color:#111"></label>
      <label>Max. Klassen gesamt<input id="lsa-maxrooms" type="number" min="1" max="1000" style="width:100%;color:#111"></label>
    </div>
    <div style="margin-top:9px;font-weight:bold">Personal aus diesen Bereichen</div>
    <div id="lsa-sources" style="display:grid;grid-template-columns:1fr 1fr;gap:3px"></div>
    <div style="margin-top:8px;font-weight:bold">Welche Wachen sollen Teilnehmer schicken?</div>
    <div style="display:flex;gap:12px;margin-top:4px">
      <label style="display:flex;gap:4px;align-items:center"><input type="radio" name="lsa-source-mode" value="all"> Alle Wachen</label>
      <label style="display:flex;gap:4px;align-items:center"><input type="radio" name="lsa-source-mode" value="selected"> Wachen aussuchen</label>
    </div>
    <div id="lsa-source-count" style="margin-top:4px;font-size:11px;color:#b9c4cf"></div>
    <div id="lsa-source-list" style="display:none;margin-top:6px;max-height:180px;overflow:auto;background:#202832;padding:6px;border:1px solid #59636e;border-radius:4px"></div>
    <label style="display:block;margin-top:9px">Vorbildung<select id="lsa-prior" style="width:100%;color:#111"><option value="any">Alle geeigneten</option><option value="none">Keine andere Ausbildung</option><option value="has">Bestimmte Ausbildung vorhanden</option></select></label>
    <label style="display:block;margin-top:5px">Gesuchte Vorbildung<select id="lsa-prior-course" style="width:100%;color:#111"></select></label>
    <div style="display:flex;gap:5px;margin-top:10px">
      <button id="lsa-load" style="flex:1;padding:7px;background:#e5e7eb;color:#111;border:1px solid #9ca3af;border-radius:4px;font-weight:bold">Schulen / Lehrgänge laden</button>
    </div>
    <div style="display:flex;gap:5px;margin-top:5px">
      <button id="lsa-plan" style="flex:1;padding:7px;background:#b9e2ff;color:#111;border:1px solid #75a9ca;border-radius:4px;font-weight:bold">Gesamtverteilung planen</button>
      <button id="lsa-prepare" style="flex:1;padding:7px;background:#bfe8c5;color:#111;border:1px solid #83b58b;border-radius:4px;font-weight:bold">Schule/n vorbereiten</button>
    </div>
          <div style="display:flex;gap:5px;margin-top:5px">
      <button id="lsa-start" style="flex:1;padding:8px;background:#ffcc80;color:#111;border:1px solid #c99b55;border-radius:4px;font-weight:bold">
        Ausbildungen starten
      </button>
    </div>
    <div style="display:flex;gap:5px;margin-top:5px">
      <button id="lsa-stop" style="flex:1;padding:7px;background:#ffd1d1;color:#111;border:1px solid #c98a8a;border-radius:4px">Abbrechen</button>
    </div>
    <div id="lsa-status" style="margin-top:9px;color:#9ed7ff">Bereit.</div>
    <div id="lsa-schoolinfo" style="margin-top:5px"></div>
    <pre id="lsa-report" style="white-space:pre-wrap;background:#111820;padding:7px;border-radius:4px;max-height:240px;overflow:auto;font:11px/1.4 monospace">Noch keine Verteilung geplant.</pre>
    <div id="lsa-log" style="margin-top:8px;max-height:120px;overflow:auto;color:#c6cbd0;font-size:11px"></div>
    </div>`;
  document.body.appendChild(panel);

  $('#lsa-minimize').addEventListener('click', () => {
    const content = $('#lsa-content');
    const hidden = content.style.display === 'none';
    content.style.display = hidden ? 'block' : 'none';
    $('#lsa-minimize').textContent = hidden ? 'Minimieren' : 'Einblenden';
    panel.style.width = hidden ? '340px' : 'auto';
  });

  const frameWrap = document.createElement('div');
  frameWrap.id = 'lsa-frame-wrap';
  frameWrap.style.cssText = 'display:none;position:fixed;z-index:999990;left:365px;right:8px;top:8px;bottom:8px;background:#fff;border:2px solid #555;border-radius:5px;overflow:hidden';
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:100%;height:100%;border:0;background:white';
  frameWrap.appendChild(frame);
  document.body.appendChild(frameWrap);
      function fillSchoolTypes() {
    const s = $('#lsa-schooltype');
    s.innerHTML = '';
    Object.entries(SCHOOL_TYPES).forEach(([id, name]) => s.appendChild(option(id, name)));
    s.value = cfg.schoolType;
  }

  function fillSourceTypes() {
    const root = $('#lsa-sources');
    root.innerHTML = '';
    SOURCE_GROUPS.forEach(([name, ids]) => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:4px;align-items:center';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ids.some(id => cfg.sourceTypes.includes(id));
      cb.addEventListener('change', () => {
        ids.forEach(id => {
          cfg.sourceTypes = cfg.sourceTypes.filter(x => x !== id);
          if (cb.checked) cfg.sourceTypes.push(id);
        });
        cfg.sourceTypes = [...new Set(cfg.sourceTypes)];
        if (state.allBuildings.length) {
          state.sources = state.allBuildings.filter(b => cfg.sourceTypes.includes(Number(b.building_type)));
          cfg.selectedSourceIds = state.sources.map(b => String(b.id));
          renderSourceBuildingList();
        }
        save();
        state.plan = null;
      });
      label.append(cb, document.createTextNode(name));
      root.appendChild(label);
    });
  }

  function renderSourceBuildingList() {
    const root = $('#lsa-source-list');
    if (!root) return;
    root.innerHTML = '';
    if (!state.sources.length) {
      root.textContent = 'Keine passenden Wachen gefunden.';
      return;
    }
    const selected = new Set((cfg.selectedSourceIds || []).map(String));
    state.sources.forEach(building => {
      const id = String(building.id);
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:6px;align-items:center;padding:3px 1px;border-bottom:1px solid #39434d';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(id);
      cb.addEventListener('change', () => {
        const ids = new Set((cfg.selectedSourceIds || []).map(String));
        if (cb.checked) ids.add(id);
        else ids.delete(id);
        cfg.selectedSourceIds = [...ids];
        save();
        state.plan = null;
        updateSourceSelectionCount();
      });
      const name = document.createElement('span');
      name.textContent = buildingName(building);
      label.append(cb, name);
      root.appendChild(label);
    });
    updateSourceSelectionCount();
  }

  function updateSourceSelectionCount() {
    const count = $('#lsa-source-count');
    if (count) {
      const n = (cfg.selectedSourceIds || []).filter(id =>
        state.sources.some(b => String(b.id) === String(id))
      ).length;
      count.textContent = n + ' von ' + state.sources.length + ' Wachen ausgewählt';
    }
  }

  function fillCoursesFromSchool(doc) {
    const select = $('#education_select', doc);
    if (!select) throw new Error('Lehrgangsauswahl #education_select fehlt.');
    const entries = $$('option', select).filter(o => o.value && o.textContent.trim());
    state.educations = entries.map(o => ({
      value: o.value,
      key: courseKey(o.value),
      name: o.textContent.trim()
    }));
    const main = $('#lsa-course'), prior = $('#lsa-prior-course');
    main.innerHTML = '';
    prior.innerHTML = '';
    main.appendChild(option('', '- Lehrgang wählen -'));
    prior.appendChild(option('', '- Vorbildung wählen -'));
    state.educations.forEach(e => {
      main.appendChild(option(e.value, e.name));
      prior.appendChild(option(e.key, e.name));
    });
    main.value = cfg.educationKey;
    prior.value = cfg.priorKey;
  }

  $('#lsa-schooltype').addEventListener('change', e => {
    cfg.schoolType = e.target.value;
    cfg.educationKey = '';
    save();
    state.plan = null;
    loadSchools();
  });

  $('#lsa-course').addEventListener('change', e => {
    cfg.educationKey = e.target.value;
    save();
    state.plan = null;
  });

  document.querySelectorAll('input[name="lsa-source-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      cfg.sourceMode = r.value;
      $('#lsa-source-list').style.display = cfg.sourceMode === 'selected' ? 'block' : 'none';
      save();
      state.plan = null;
    });
  });

  $('#lsa-count').value = cfg.perBuilding;
  $('#lsa-count').addEventListener('change', e => {
    cfg.perBuilding = Math.max(1, Math.min(300, Number(e.target.value) || 1));
    e.target.value = cfg.perBuilding;
    save();
    state.plan = null;
  });

  $('#lsa-maxrooms').value = cfg.maxClassrooms;
  $('#lsa-maxrooms').addEventListener('change', e => {
    cfg.maxClassrooms = Math.max(1, Math.min(1000, Number(e.target.value) || 1));
    e.target.value = cfg.maxClassrooms;
    save();
    state.plan = null;
  });

  $('#lsa-prior').value = cfg.prior;
  $('#lsa-prior').addEventListener('change', e => {
    cfg.prior = e.target.value;
    save();
    state.plan = null;
  });

  $('#lsa-prior-course').addEventListener('change', e => {
    cfg.priorKey = e.target.value;
    save();
    state.plan = null;
  });

  async function loadSchoolFrame(school) {
    frameWrap.style.display = 'none';

    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Schulseite lädt nicht: ' + buildingName(school))),
        20000
      );
      frame.onload = () => {
        clearTimeout(timeout);
        resolve();
      };
      frame.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Fehler beim Laden von ' + buildingName(school)));
      };
    });

    frame.src = '/buildings/' + school.id;
    await loaded;

    const doc = frame.contentDocument;
    if (!doc) throw new Error('Schulseite kann nicht gelesen werden.');

    await waitFor(
      () => $('#education_select, #building_rooms_use, form[action*="/education"]', doc),
      8000
    );

    state.currentDoc = doc;
    frameWrap.style.display = 'none';
    return doc;
  }

  function fixSchoolFrameLayout(doc) {
    const container = doc.querySelector('#iframe-inside-container');
    const schooling = doc.querySelector('#schooling');
    const form = doc.querySelector('form[action*="/education"]');
    if (!container || !schooling || !form) return;
    [container, schooling, form].forEach(el => {
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
    });
    doc.body.style.setProperty('height', 'auto', 'important');
    doc.documentElement.style.setProperty('height', 'auto', 'important');
    container.style.setProperty('height', schooling.scrollHeight + 'px', 'important');
  }

  async function loadSchools() {
    try {
      state.plan = null;
      status('Lade Schulen und Quell-Wachen ...');

      const buildings = await getBuildings();
      state.allBuildings = buildings;

      state.schools = buildings
        .filter(b => String(b.building_type) === String(cfg.schoolType))
        .sort((a, b) => Number(a.id) - Number(b.id));

      state.sources = buildings.filter(
        b => cfg.sourceTypes.includes(Number(b.building_type))
      );

      if (!Array.isArray(cfg.selectedSourceIds) || !cfg.selectedSourceIds.length) {
        cfg.selectedSourceIds = state.sources.map(b => String(b.id));
      }

      renderSourceBuildingList();
      document.querySelectorAll('input[name="lsa-source-mode"]').forEach(r => {
        r.checked = r.value === cfg.sourceMode;
      });
      $('#lsa-source-list').style.display = cfg.sourceMode === 'selected' ? 'block' : 'none';

      cfg.schoolIndex = 0;
      save();

      if (!state.schools.length) {
        throw new Error('Keine eigene Schule dieses Typs gefunden.');
      }

      log(state.schools.length + ' Schulen und ' + state.sources.length + ' Quell-Wachen gefunden.');

      let firstUsableSchool = null;

      for (const school of state.schools) {
        const doc = await loadSchoolFrame(school);
        const select = $('#education_select', doc);
        const roomSelect = $('#building_rooms_use', doc);

        const courses = select
          ? $$('option', select).filter(o => o.value && !o.disabled)
          : [];

        const freeRooms = roomSelect
          ? $$('option', roomSelect)
              .map(o => Number(o.value))
              .filter(n => Number.isInteger(n) && n > 0)
              .reduce((a, b) => Math.max(a, b), 0)
          : 0;

        if (courses.length && freeRooms > 0) {
          firstUsableSchool = { school, doc };
          break;
        }

        log(buildingName(school) + ': übersprungen – voll oder kein Lehrgangsangebot.');
      }

      if (!firstUsableSchool) {
        throw new Error('Keine Schule mit freien Klassenräumen und Lehrgangsangebot gefunden.');
      }

      fillCoursesFromSchool(firstUsableSchool.doc);

      status('Schulen und Lehrgänge geladen. Lehrgang auswählen und Gesamtverteilung planen.');

      $('#lsa-schoolinfo').textContent =
        state.schools.length + ' Schulen · ' +
        state.sources.length + ' mögliche Quell-Wachen · erste verfügbare Schule: ' +
        buildingName(firstUsableSchool.school);

      fixSchoolFrameLayout(firstUsableSchool.doc);

    } catch (e) {
      status('Fehler: ' + e.message);
      log(e.message);
      console.error(e);
    }
  }
      function isEligible(cb, targetKey) {
    if (!targetKey || cb.getAttribute(targetKey) !== 'false' && cb.getAttribute(targetKey) !== null) return false;
    // Nur eindeutige, nicht bereits absolvierte Zielqualifikation zulassen.
    if (cb.getAttribute(targetKey) === 'true') return false;
    if (cfg.prior === 'any') return true;
    if (cfg.prior === 'has') return !!cfg.priorKey && cb.getAttribute(cfg.priorKey) === 'true';
    if (cfg.prior === 'none') {
      const keys = state.educations.map(e => e.key).filter(k => k && k !== targetKey);
      return keys.length > 0 && keys.every(k => cb.getAttribute(k) !== 'true');
    }
    return false;
  }

  async function fetchSourceRoster(building, targetKey) {
    const url = '/buildings/' + building.id + '/schooling_personal_select';
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Personalabruf fehlgeschlagen: ' + buildingName(building));
    const html = await response.text();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const checkboxes = $$('input.schooling_checkbox', parsed);
    const people = [];
    const seen = new Set();

    for (const cb of checkboxes) {
      const id = String(cb.value || '');
      if (!id || seen.has(id) || cb.disabled || !isEligible(cb, targetKey)) continue;
      seen.add(id);
      people.push({
        id,
        html: cb.outerHTML,
        sourceId: String(building.id),
        sourceName: buildingName(building)
      });
      if (people.length >= cfg.perBuilding) break;
    }
    return people;
  }

  async function getSchoolRoomCapacities(targetCourseValue) {
    const capacities = [];
    let roomsFound = 0;
    const roomTarget = Math.max(1, Number(cfg.maxClassrooms) || 1);

    for (let i = 0; i < state.schools.length && roomsFound < roomTarget; i++) {
      if (state.stop) throw new Error('Planung abgebrochen.');

      const school = state.schools[i];

      status(`Prüfe freie Klassenräume: ${roomsFound}/${roomTarget} (Schule ${i + 1})`);

      const doc = await loadSchoolFrame(school);
      const roomSelect = $('#building_rooms_use', doc);
      const courseSelect = $('#education_select', doc);

      if (!roomSelect || !courseSelect) {
        log(buildingName(school) + ': übersprungen – kein Ausbildungsformular.');
        continue;
      }

      const hasCourse = $$('option', courseSelect)
        .some(o => o.value === targetCourseValue && !o.disabled);

      if (!hasCourse) {
        log(buildingName(school) + ': übersprungen – gewünschter Lehrgang nicht verfügbar.');
        continue;
      }

      const nums = $$('option', roomSelect)
        .map(o => Number(o.value))
        .filter(n => Number.isInteger(n) && n > 0);

      const maxRooms = nums.length ? Math.max(...nums) : 0;

      if (maxRooms <= 0) {
        log(buildingName(school) + ': übersprungen – keine freien Klassenräume.');
        continue;
      }

      capacities.push({ school, maxRooms });
      roomsFound += maxRooms;
    }

    return capacities;
  }

  function createAllocation(people, capacities) {
    const totalRoomsAvailable = capacities.reduce((n, x) => n + x.maxRooms, 0);
    const roomLimit = Math.min(cfg.maxClassrooms, totalRoomsAvailable);
    const usablePeople = people.slice(0, roomLimit * 10);
    const schools = capacities.map(x => ({
      school: x.school,
      rooms: [],
      maxRooms: x.maxRooms
    }));

    let p = 0;
    let remainingRooms = roomLimit;

    for (const entry of schools) {
      const useRooms = Math.min(
        entry.maxRooms,
        remainingRooms,
        Math.ceil((usablePeople.length - p) / 10)
      );

      for (let r = 0; r < useRooms; r++) {
        const cls = { number: r + 1, people: [] };
        while (cls.people.length < 10 && p < usablePeople.length) {
          cls.people.push(usablePeople[p++]);
        }
        entry.rooms.push(cls);
      }

      remainingRooms -= useRooms;
      if (p >= usablePeople.length || remainingRooms <= 0) break;
    }

    return {
      schools: schools.filter(s => s.rooms.length),
      totalEligible: people.length,
      totalPlanned: p,
      totalRooms: schools.reduce((n, s) => n + s.rooms.length, 0),
      totalRoomsAvailable,
      roomLimit
    };
  }

  function renderReport(plan) {
    const lines = [];
    lines.push(`GEPLANTE GESAMTVERTEILUNG: ${plan.totalPlanned} TN / ${plan.totalRooms} Klassen`);
    lines.push(`Geeignet gefunden: ${plan.totalEligible} · Klassenlimit: ${plan.roomLimit} · Max. 10 TN je Klasse`);
    lines.push('');

    plan.schools.forEach((s, si) => {
      const count = s.rooms.reduce((n, c) => n + c.people.length, 0);
      lines.push(`${si + 1}. ${buildingName(s.school)} — ${s.rooms.length} Klassen / ${count} TN${s.prepared ? ' [Formular geprüft]' : ''}`);
      s.rooms.forEach(c => {
        const counts = new Map();
        c.people.forEach(p => counts.set(p.sourceName, (counts.get(p.sourceName) || 0) + 1));
        lines.push(`  Klasse ${c.number}: ${[...counts].map(([name, n]) => `${n} TN ${name}`).join(' · ')} (${c.people.length}/10)`);
      });
      lines.push('');
    });

    $('#lsa-report').textContent = lines.join('\n');
  }

  async function buildPlan() {
    if (state.busy) return;
    if (!cfg.educationKey) return status('Bitte zuerst einen Lehrgang auswählen.');
    if (!state.schools.length || !state.sources.length) return status('Bitte zuerst Schulen / Lehrgänge laden.');

    const eligibleSources = cfg.sourceMode === 'selected'
      ? state.sources.filter(b => (cfg.selectedSourceIds || []).map(String).includes(String(b.id)))
      : state.sources.slice();

    if (!eligibleSources.length) return status('Bitte mindestens eine Quell-Wache auswählen.');

    state.busy = true;
    state.stop = false;
    state.plan = null;
    cfg.schoolIndex = 0;

    try {
      const targetKey = courseKey(cfg.educationKey);
      status('Prüfe freie Klassenräume ...');

      const capacities = await getSchoolRoomCapacities(cfg.educationKey);
      const totalRoomsAvailable = capacities.reduce((n, x) => n + x.maxRooms, 0);
      const roomTarget = Math.min(Math.max(1, Number(cfg.maxClassrooms) || 1), totalRoomsAvailable);

      if (!roomTarget) throw new Error('Keine freien Klassenräume in den eigenen Schulen gefunden.');

      const participantTarget = roomTarget * 10;
      status(`Suche höchstens ${participantTarget} geeignete Teilnehmer für ${roomTarget} Klassen ...`);

      const allPeople = [];
      const used = new Set();
      let checkedSources = 0;

      for (let i = 0; i < eligibleSources.length && allPeople.length < participantTarget; i++) {
        if (state.stop) throw new Error('Planung abgebrochen.');

        const source = eligibleSources[i];
        checkedSources++;
        status(`Prüfe Personal: ${allPeople.length}/${participantTarget} TN (Wache ${i + 1}/${eligibleSources.length})`);

        const roster = await fetchSourceRoster(source, targetKey);

        for (const person of roster) {
          if (allPeople.length >= participantTarget) break;
          if (!used.has(person.id)) {
            used.add(person.id);
            allPeople.push(person);
          }
        }
      }

      if (!allPeople.length) throw new Error('Keine geeigneten Teilnehmer gefunden. Prüfe Lehrgang und Vorbildungsfilter.');

      log(`${allPeople.length} geeignete Teilnehmer in ${checkedSources} Quell-Wachen gefunden.`);

      const plan = createAllocation(allPeople, capacities);
      if (!plan.totalPlanned) throw new Error('Mit den verfügbaren Klassenräumen kann kein Teilnehmer eingeplant werden.');

      plan.targetKey = targetKey;
      plan.courseValue = cfg.educationKey;
      plan.createdAt = Date.now();

      state.plan = plan;
      cfg.schoolIndex = 0;
      save();
      renderReport(plan);

      status(`Plan fertig: ${plan.totalPlanned} TN auf ${plan.totalRooms} Klassen in ${plan.schools.length} Schulen.`);
      log('Gesamtverteilung erstellt. „Schule/n vorbereiten“ befüllt jetzt alle geplanten Schulen nacheinander.');

      $('#lsa-schoolinfo').textContent =
        `Vorbereitung: ${plan.schools.length} Schulen · erste Schule: ${buildingName(plan.schools[0].school)}`;

    } catch (e) {
      status('Fehler: ' + e.message);
      log(e.message);
      console.error(e);
    } finally {
      state.busy = false;
    }
  }
      async function prepareAllSchools() {
    if (state.busy) return;
    if (!state.plan) return status('Bitte zuerst die Gesamtverteilung planen.');

    const pending = state.plan.schools.filter(s => !s.prepared);
    if (!pending.length) return status('Alle geplanten Schulen sind bereits vorbereitet.');

    state.busy = true;
    state.stop = false;
    let completed = 0;

    try {
      for (let index = 0; index < state.plan.schools.length; index++) {
        const entry = state.plan.schools[index];

        if (entry.prepared) {
          completed++;
          continue;
        }
        if (state.stop) throw new Error('Vorbereitung abgebrochen.');

        status(`Bereite Schule ${index + 1}/${state.plan.schools.length} vor: ${buildingName(entry.school)}`);
        $('#lsa-schoolinfo').textContent =
          `Schule ${index + 1}/${state.plan.schools.length}: ${buildingName(entry.school)}`;

        const doc = await loadSchoolFrame(entry.school);
        const form = $('#education_select', doc)?.form ||
          $$('form', doc).find(f => /\/education/.test(f.action));
        const select = $('#education_select', doc);
        const roomSelect = $('#building_rooms_use', doc);

        if (!form || !select || !roomSelect) {
          throw new Error('Ausbildungsformular oder Auswahlfeld fehlt: ' + buildingName(entry.school));
        }

        fillCoursesFromSchool(doc);
        select.value = state.plan.courseValue;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        roomSelect.value = String(entry.rooms.length);
        roomSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);

        const holderOld = $('#lsa-extra-personal', doc);
        if (holderOld) holderOld.remove();

        const holder = doc.createElement('div');
        holder.id = 'lsa-extra-personal';
        holder.style.display = 'none';
        form.appendChild(holder);

        const expected = new Set();

        for (const cls of entry.rooms) {
          for (const person of cls.people) {
            if (state.stop) throw new Error('Vorbereitung abgebrochen.');

            const parsed = new DOMParser().parseFromString(person.html, 'text/html');
            const original = $('input.schooling_checkbox', parsed);
            if (!original) continue;

            const clone = doc.importNode(original, true);
            clone.checked = false;
            clone.disabled = false;
            holder.appendChild(clone);
            expected.add(person.id);
          }
        }

        let selected = 0;

        for (const cb of $$('input.schooling_checkbox', holder)) {
          cb.click();
          if (cb.checked) selected++;
        }

        const actual = new Set(
          $$('input.schooling_checkbox:checked', form).map(cb => String(cb.value))
        );
        const missing = [...expected].filter(id => !actual.has(id));

        fixSchoolFrameLayout(doc);
        await new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        fixSchoolFrameLayout(doc);

        if (missing.length || selected !== expected.size) {
          entry.prepared = false;
          entry.preparedCount = selected;
          renderReport(state.plan);
          throw new Error(
            `${buildingName(entry.school)}: ${missing.length} von ${expected.size} geplanten TN konnten nicht sicher markiert werden. Weitere Schulen wurden nicht verändert.`
          );
        }

        entry.prepared = true;
        entry.preparedCount = selected;
        completed++;
        renderReport(state.plan);

        log(`${buildingName(entry.school)} vorbereitet: ${selected} TN in ${entry.rooms.length} Klassen. Kein Ausbildungsstart ausgelöst.`);
      }

      status(`Fertig: ${completed}/${state.plan.schools.length} Schulen vorbereitet. Ausbildungsstart bleibt manuell.`);
      $('#lsa-schoolinfo').textContent =
        `Alle ${state.plan.schools.length} geplanten Schulen wurden vorbereitet.`;

    } catch (e) {
      status('Vorbereitung gestoppt: ' + e.message);
      log(e.message);
      console.error(e);
    } finally {
      state.busy = false;
      frameWrap.style.display = 'none';
    }
  }

  async function startAllTrainings() {
    if (state.busy) return;
    if (!state.plan) return status('Bitte zuerst die Gesamtverteilung planen.');

    const pending = state.plan.schools.filter(s => s.prepared && !s.started);

    if (!pending.length) {
      return status('Keine vorbereiteten, noch nicht gestarteten Schulen vorhanden.');
    }

    if (!confirm(`Sollen die Ausbildungen in ${pending.length} vorbereiteten Schulen jetzt gestartet werden?`)) return;

    state.busy = true;
    state.stop = false;

    try {
      for (let index = 0; index < state.plan.schools.length; index++) {
        const entry = state.plan.schools[index];

        if (!entry.prepared || entry.started) continue;
        if (state.stop) throw new Error('Startvorgang abgebrochen.');

        status(`Starte Ausbildung ${index + 1}/${state.plan.schools.length}: ${buildingName(entry.school)}`);

        const doc = await loadSchoolFrame(entry.school);
        const form = $('#education_select', doc)?.form ||
          $$('form', doc).find(f => /\/education/.test(f.action));

        const select = $('#education_select', doc);
        const roomSelect = $('#building_rooms_use', doc);

        if (!form || !select || !roomSelect) {
          throw new Error('Ausbildungsformular fehlt: ' + buildingName(entry.school));
        }

        select.value = state.plan.courseValue;
        select.dispatchEvent(new Event('change', { bubbles: true }));

        roomSelect.value = String(entry.rooms.length);
        roomSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const oldHolder = $('#lsa-extra-personal', doc);
        if (oldHolder) oldHolder.remove();

        const holder = doc.createElement('div');
        holder.id = 'lsa-extra-personal';
        holder.style.display = 'none';
        form.appendChild(holder);

        for (const cls of entry.rooms) {
          for (const person of cls.people) {
            const parsed = new DOMParser().parseFromString(person.html, 'text/html');
            const original = $('input.schooling_checkbox', parsed);
            if (!original) continue;

            const clone = doc.importNode(original, true);
            clone.checked = false;
            clone.disabled = false;
            holder.appendChild(clone);
          }
        }

        for (const cb of $$('input.schooling_checkbox', holder)) {
          cb.click();
        }

        const expectedCount = entry.rooms.reduce((n, c) => n + c.people.length, 0);
        const actualCount = $$('input.schooling_checkbox:checked', form).length;

        if (actualCount !== expectedCount) {
          throw new Error(`${buildingName(entry.school)}: Teilnehmerzahl stimmt nicht. Start abgebrochen.`);
        }

        const submitter = $$('button[type="submit"], input[type="submit"]', form)
          .find(b => !b.disabled);

        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(submitter);
        } else if (submitter) {
          submitter.click();
        } else {
          throw new Error('Start-Button im Formular nicht gefunden: ' + buildingName(entry.school));
        }

        entry.started = true;
        renderReport(state.plan);
        log(`${buildingName(entry.school)}: Startanforderung abgeschickt.`);
        await sleep(2500);
      }

      status('Alle vorbereiteten Schulen wurden zum Ausbildungsstart abgeschickt.');

    } catch (e) {
      status('Start gestoppt: ' + e.message);
      log(e.message);
      console.error(e);
    } finally {
      state.busy = false;
      frameWrap.style.display = 'none';
    }
  }

  $('#lsa-load').addEventListener('click', loadSchools);
  $('#lsa-plan').addEventListener('click', buildPlan);
  $('#lsa-prepare').addEventListener('click', prepareAllSchools);
  $('#lsa-start').addEventListener('click', startAllTrainings);

  $('#lsa-stop').addEventListener('click', () => {
    state.stop = true;
    status('Abbruch angefordert.');
  });

  fillSchoolTypes();
  fillSourceTypes();
  $('#lsa-count').value = cfg.perBuilding;
  $('#lsa-maxrooms').value = cfg.maxClassrooms;
  loadSchools();
})();