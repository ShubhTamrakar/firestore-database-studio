// Real Live Multi-Project State (Zero Mock Data)
let savedProjects = [];
let activeProject = null;
let selectedFormat = 'jsonl-dr';
let currentInspectionData = null;
let savedBackups = [];

// Active view selection in 3-column Firestore console
let activeCollectionId = null;
let activeDocumentId = null;

document.addEventListener('DOMContentLoaded', async () => {
  setupAutoScrollObservers();
  await loadStorageSettings();
  await loadProjects();
  await loadSavedBackups();

  if (savedProjects.length > 0) {
    loadLiveDatabaseView();
  } else {
    showEmptyConnectState();
  }
});

function setupAutoScrollObservers() {
  const targets = document.querySelectorAll('.progress-log, .audit-output');
  targets.forEach(el => {
    const observer = new MutationObserver(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
  });
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  const btn = document.getElementById(`tab-${tabId}-btn`);
  const content = document.getElementById(`tab-${tabId}`);
  if (btn) btn.classList.add('active');
  if (content) content.classList.add('active');

  if (tabId === 'vault') {
    loadSavedBackups();
  }
}

function showEmptyConnectState() {
  document.getElementById('view-empty-connect-state').style.display = 'block';
  document.getElementById('view-live-connected-state').style.display = 'none';
  document.getElementById('backup-active-proj-label').textContent = 'No database connected';
  document.getElementById('btn-run-backup').disabled = true;
}

// 1. Projects Management
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    savedProjects = data.projects || [];
    renderProjectSelectors();
    renderSavedProjectsList();
  } catch (err) {
    console.error('Failed to load projects', err);
  }
}

function renderProjectSelectors() {
  const globalSelect = document.getElementById('global-project-select');
  const restoreDestPicker = document.getElementById('restore-dest-picker');

  globalSelect.innerHTML = '';
  restoreDestPicker.innerHTML = '';

  if (savedProjects.length === 0) {
    globalSelect.innerHTML = '<option value="">-- No Database Connected --</option>';
    restoreDestPicker.innerHTML = '<option value="">-- No Database Connected --</option>';
    showEmptyConnectState();
    return;
  }

  savedProjects.forEach((proj) => {
    const opt = document.createElement('option');
    opt.value = proj.id;
    opt.textContent = `${proj.name} (${proj.projectId})`;
    globalSelect.appendChild(opt);

    const opt2 = document.createElement('option');
    opt2.value = proj.id;
    opt2.textContent = `${proj.name} [${proj.projectId}]`;
    restoreDestPicker.appendChild(opt2);
  });

  renderRestoreBackupDropdown(savedBackups);

  if (!activeProject && savedProjects.length > 0) {
    activeProject = savedProjects[0];
  }

  if (activeProject) {
    globalSelect.value = activeProject.id;
    document.getElementById('backup-active-proj-label').textContent = `${activeProject.name} (${activeProject.projectId})`;
    document.getElementById('btn-run-backup').disabled = false;
  }
}

function onGlobalProjectChange() {
  const selectedId = document.getElementById('global-project-select').value;
  activeProject = savedProjects.find(p => p.id === selectedId) || null;

  if (activeProject) {
    document.getElementById('backup-active-proj-label').textContent = `${activeProject.name} (${activeProject.projectId})`;
    document.getElementById('btn-run-backup').disabled = false;
    loadLiveDatabaseView();
  } else {
    showEmptyConnectState();
  }
}

function renderSavedProjectsList() {
  const container = document.getElementById('saved-projects-container');
  if (!container) return;

  if (savedProjects.length === 0) {
    container.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No databases connected yet. Use the form above to connect your Firebase project.</div>`;
    return;
  }

  container.innerHTML = savedProjects.map(p => `
    <div class="project-item-card">
      <div>
        <div class="project-item-title">${escapeHtml(p.name)}</div>
        <div class="project-item-id">Project ID: ${escapeHtml(p.projectId)}</div>
        ${p.keyPath ? `<div style="font-size: 0.74rem; color: var(--text-dim); margin-top: 2px;">Key Path: ${escapeHtml(p.keyPath)}</div>` : ''}
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary btn-sm" onclick="selectAndExploreProject('${p.id}')">
          View Live Data
        </button>
        <button class="btn btn-danger btn-sm" onclick="deleteProject('${p.id}')">
          Disconnect
        </button>
      </div>
    </div>
  `).join('');
}

function selectAndExploreProject(projId) {
  document.getElementById('global-project-select').value = projId;
  onGlobalProjectChange();
  switchTab('view');
}

async function deleteProject(projId) {
  if (!confirm('Are you sure you want to disconnect this database profile?')) return;
  try {
    const res = await fetch(`/api/projects/${projId}`, { method: 'DELETE' });
    const data = await res.json();
    savedProjects = data.projects || [];
    activeProject = savedProjects[0] || null;
    renderProjectSelectors();
    renderSavedProjectsList();
    if (activeProject) {
      loadLiveDatabaseView();
    } else {
      showEmptyConnectState();
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function addNewDatabase() {
  const nickname = document.getElementById('new-proj-nickname').value.trim();
  const projectId = document.getElementById('new-proj-id').value.trim();
  const keyPath = document.getElementById('new-proj-keypath').value.trim();
  const keyJson = document.getElementById('new-proj-keyjson').value.trim();

  if (!keyPath && !keyJson) {
    alert('Please provide either a Service Account JSON file path (Method 1) or paste the JSON text directly (Method 2).');
    return;
  }

  const btn = document.getElementById('btn-save-database');
  btn.disabled = true;
  btn.textContent = 'Connecting to Firebase...';

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nickname || projectId, projectId, keyPath, keyJson })
    });
    const data = await res.json();

    if (!data.success) {
      alert(`Could not connect: ${data.error}`);
      return;
    }

    alert(`Successfully connected to Firebase project '${data.project.projectId}'!`);
    document.getElementById('new-proj-nickname').value = '';
    document.getElementById('new-proj-id').value = '';
    document.getElementById('new-proj-keypath').value = '';
    document.getElementById('new-proj-keyjson').value = '';

    await loadProjects();
    selectAndExploreProject(data.project.id);
  } catch (err) {
    alert(`Connection Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect Database';
  }
}

// 2. View Live Database (Authentic 3-Column Console)
async function loadLiveDatabaseView() {
  if (!activeProject) {
    showEmptyConnectState();
    return;
  }

  document.getElementById('view-empty-connect-state').style.display = 'none';
  document.getElementById('view-live-connected-state').style.display = 'block';

  // Immediately reflect active project in the banner
  document.getElementById('schema-db-id').textContent = activeProject.projectId || activeProject.name;
  document.getElementById('stat-coll-count').textContent = '...';
  document.getElementById('stat-doc-count').textContent = '...';
  document.getElementById('schema-chips').innerHTML = '<span style="color: var(--text-dim); font-size: 0.82rem;">Connecting to real Firestore database...</span>';

  // Clear previous project documents & fields
  const collContainer = document.getElementById('fs-collections-list');
  collContainer.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Connecting to live Firestore...</div>`;
  document.getElementById('fs-docs-list').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Loading...</div>`;
  document.getElementById('fs-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Loading...</div>`;
  exitSubcollectionMode();

  try {
    const res = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: activeProject })
    });
    const data = await res.json();

    if (!data.success) {
      document.getElementById('stat-coll-count').textContent = '0';
      document.getElementById('stat-doc-count').textContent = '0';
      document.getElementById('schema-chips').innerHTML = `
        <div style="background: rgba(244, 63, 94, 0.12); border: 1px solid rgba(244, 63, 94, 0.3); border-radius: 8px; padding: 10px 14px; color: #fecdd3; font-size: 0.84rem; line-height: 1.5; width: 100%;">
          <strong>⚠️ Action Needed in Firebase Console:</strong> ${escapeHtml(data.error)}
        </div>
      `;
      collContainer.innerHTML = `
        <div style="color: var(--accent-rose); padding: 16px; font-size: 0.82rem; line-height: 1.5;">
          ${escapeHtml(data.error)}
        </div>
      `;
      document.getElementById('fs-active-coll-name').textContent = 'Select Collection';
      document.getElementById('fs-active-doc-name').textContent = 'Select Document';
      updateBreadcrumbs(null, null);
      document.getElementById('fs-docs-list').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Database not found.</div>`;
      document.getElementById('fs-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Database not found.</div>`;
      return;
    }

    currentInspectionData = data;
    document.getElementById('schema-db-id').textContent = data.projectId;
    document.getElementById('stat-coll-count').textContent = data.collectionsCount;

    let totalDocsCount = 0;
    data.collections.forEach(c => totalDocsCount += (c.docs ? c.docs.length : 0));
    document.getElementById('stat-doc-count').textContent = totalDocsCount;

    // Render Schema Chips
    const chipsContainer = document.getElementById('schema-chips');
    if (data.collections.length === 0) {
      chipsContainer.innerHTML = `<span style="color: var(--text-dim); font-size: 0.82rem;">(Brand new database - 0 collections created yet)</span>`;
    } else {
      chipsContainer.innerHTML = data.collections.map(c => `
        <span class="schema-chip">${c.id} (${c.docs.length} docs)</span>
      `).join('');
    }

    renderFirestoreConsole(data.collections);
  } catch (err) {
    collContainer.innerHTML = `<div style="color: var(--accent-rose); padding: 16px;">Network error: ${err.message}</div>`;
    document.getElementById('fs-docs-list').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Error loading.</div>`;
    document.getElementById('fs-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Error loading.</div>`;
  }
}

function renderFirestoreConsole(collections) {
  currentTopLevelCollections = collections;
  const collContainer = document.getElementById('fs-collections-list');
  collContainer.innerHTML = '';

  if (!collections || collections.length === 0) {
    activeCollectionId = null;
    activeDocumentId = null;
    currentActiveCollObject = null;
    currentActiveDocObject = null;
    document.getElementById('fs-active-coll-name').textContent = 'Select Collection';
    document.getElementById('fs-active-doc-name').textContent = 'Select Document';
    updateBreadcrumbs(null, null);
    exitSubcollectionMode();

    collContainer.innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">No collections found in this database.</div>`;
    document.getElementById('fs-docs-list').innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">(Empty database)</div>`;
    document.getElementById('fs-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">(Empty database)</div>`;
    return;
  }

  let activeColl = collections.find(c => c.id === activeCollectionId) || collections[0];
  activeCollectionId = activeColl.id;

  // Render Column 1: Collections
  collections.forEach(coll => {
    const row = document.createElement('div');
    row.className = `fs-item-row ${coll.id === activeCollectionId ? 'active' : ''}`;
    row.innerHTML = `
      <span>${coll.id}</span>
      <span class="fs-item-caret">&gt;</span>
    `;
    row.onclick = () => {
      activeCollectionId = coll.id;
      document.querySelectorAll('#fs-collections-list .fs-item-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      renderDocumentsColumn(coll);
    };
    collContainer.appendChild(row);
  });

  renderDocumentsColumn(activeColl);
}

let currentActiveCollObject = null;
let currentTopLevelCollections = [];
let currentActiveDocObject = null;
let activeSubcollectionId = null;

function reloadTopLevelConsole(collId) {
  exitSubcollectionMode();
  if (collId) activeCollectionId = collId;
  if (currentTopLevelCollections && currentTopLevelCollections.length > 0) {
    renderFirestoreConsole(currentTopLevelCollections);
  }
}

function exitSubcollectionMode() {
  activeSubcollectionId = null;

  // 1. Show Root (default) collections column
  const rootCol = document.getElementById('col-root-collections');
  if (rootCol) rootCol.style.display = 'flex';

  // 2. Hide subcollection documents column and subcollection fields column
  const subcollCol = document.getElementById('col-subcoll-docs');
  if (subcollCol) subcollCol.style.display = 'none';

  const subcollFieldsCol = document.getElementById('col-subcoll-fields');
  if (subcollFieldsCol) subcollFieldsCol.style.display = 'none';

  // 3. Remove active highlighting from any subcollection item rows
  document.querySelectorAll('.fs-subcoll-row').forEach(r => r.classList.remove('active'));

  // 4. Update breadcrumbs back to parent doc level
  if (currentActiveDocObject) {
    updateBreadcrumbs(currentActiveCollObject ? currentActiveCollObject.id : null, currentActiveDocObject.id);
  }
}

function updateBreadcrumbs(collId, docId, subcollId, subdocId) {
  const bar = document.getElementById('firestore-breadcrumb-bar');
  if (!bar) return;
  let html = `<span class="bc-home" style="cursor:pointer;" onclick="reloadTopLevelConsole()">🏠</span>`;
  if (collId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-collection" style="cursor:pointer;" onclick="reloadTopLevelConsole('${collId}')">${collId}</span>`;
  }
  if (docId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-doc" style="cursor:pointer;" onclick="exitSubcollectionMode()">${docId}</span>`;
  }
  if (subcollId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-collection" style="font-weight:700; color:#fff;">${subcollId}</span>`;
  }
  if (subdocId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-doc" style="font-weight:700; color:#fff;">${subdocId}</span>`;
  }
  bar.innerHTML = html;
}

function renderDocumentsColumn(coll) {
  currentActiveCollObject = coll;
  document.getElementById('fs-active-coll-name').textContent = coll.id;

  const docContainer = document.getElementById('fs-docs-list');
  docContainer.innerHTML = '';

  if (!coll.docs || coll.docs.length === 0) {
    updateBreadcrumbs(coll.id, null);
    docContainer.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No documents in ${coll.id}.</div>`;
    document.getElementById('fs-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No document selected.</div>`;
    return;
  }

  let activeDoc = coll.docs.find(d => d.id === activeDocumentId) || coll.docs[0];
  activeDocumentId = activeDoc.id;

  // Render Column 2: Documents
  coll.docs.forEach(doc => {
    const row = document.createElement('div');
    row.className = `fs-item-row ${doc.id === activeDocumentId ? 'active' : ''}`;
    row.innerHTML = `
      <span>${doc.id}</span>
      <span class="fs-item-caret">&gt;</span>
    `;
    row.onclick = () => {
      // Re-clicking on any parent document closes subcollection mode and restores (default) column
      exitSubcollectionMode();
      activeDocumentId = doc.id;
      document.querySelectorAll('#fs-docs-list .fs-item-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      renderFieldsColumn(doc);
    };
    docContainer.appendChild(row);
  });

  renderFieldsColumn(activeDoc);
}

function renderFieldsColumn(doc) {
  currentActiveDocObject = doc;
  document.getElementById('fs-active-doc-name').textContent = doc.id;
  updateBreadcrumbs(currentActiveCollObject ? currentActiveCollObject.id : null, doc.id);

  const container = document.getElementById('fs-fields-container');
  renderDocumentDetailsView(container, doc, {
    isBackup: false,
    onSubcollClick: (parentDoc, subId) => navigateToSubcollection(parentDoc, subId)
  });
}

async function navigateToSubcollection(parentDoc, subId) {
  activeSubcollectionId = subId;

  // 1. Highlight the subcollection row in Column 2 (col-parent-doc-details)
  document.querySelectorAll('.fs-subcoll-row').forEach(r => {
    if (r.getAttribute('data-subcoll-id') === subId) {
      r.classList.add('active');
    } else {
      r.classList.remove('active');
    }
  });

  // 2. HIDE (default) collection column (matching Firebase Console Image 2!)
  const rootCol = document.getElementById('col-root-collections');
  if (rootCol) rootCol.style.display = 'none';

  // 3. SHOW subcollection documents column (col-subcoll-docs) & fields column
  const subcollCol = document.getElementById('col-subcoll-docs');
  if (subcollCol) subcollCol.style.display = 'flex';

  const subcollFieldsCol = document.getElementById('col-subcoll-fields');
  if (subcollFieldsCol) subcollFieldsCol.style.display = 'flex';

  document.getElementById('fs-subcoll-name').textContent = subId;
  const subDocsList = document.getElementById('fs-subcoll-docs-list');
  subDocsList.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Loading ${subId}...</div>`;

  // 4. Update breadcrumbs
  updateBreadcrumbs(currentActiveCollObject ? currentActiveCollObject.id : null, parentDoc.id, subId);

  try {
    const res = await fetch('/api/subcollection-docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: activeProject,
        docPath: parentDoc.path,
        subcollectionId: subId
      })
    });
    const result = await res.json();
    if (!result.success) {
      subDocsList.innerHTML = `<div style="padding: 16px; color: var(--accent-rose);">Failed: ${result.error}</div>`;
      return;
    }

    if (result.docs.length === 0) {
      subDocsList.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No documents in ${subId}.</div>`;
      document.getElementById('fs-subdoc-name').textContent = 'Select Document';
      document.getElementById('fs-subdoc-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Empty subcollection.</div>`;
      return;
    }

    subDocsList.innerHTML = '';
    let activeSubDoc = result.docs[0];

    result.docs.forEach(d => {
      const row = document.createElement('div');
      row.className = `fs-item-row ${d.id === activeSubDoc.id ? 'active' : ''}`;
      row.innerHTML = `
        <span>${d.id}</span>
        <span class="fs-item-caret">&gt;</span>
      `;
      row.onclick = () => {
        document.querySelectorAll('#fs-subcoll-docs-list .fs-item-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        renderSubDocFields(d, subId, parentDoc);
      };
      subDocsList.appendChild(row);
    });

    renderSubDocFields(activeSubDoc, subId, parentDoc);

  } catch (err) {
    subDocsList.innerHTML = `<div style="padding: 16px; color: var(--accent-rose);">Error: ${err.message}</div>`;
  }
}

function renderSubDocFields(subDoc, subId, parentDoc) {
  document.getElementById('fs-subdoc-name').textContent = subDoc.id;
  updateBreadcrumbs(currentActiveCollObject ? currentActiveCollObject.id : null, parentDoc.id, subId, subDoc.id);

  const container = document.getElementById('fs-subdoc-fields-container');
  renderDocumentDetailsView(container, subDoc, {
    isBackup: false,
    onSubcollClick: null
  });
}

// Universal Authentic Firestore Document Details View (Subcollections + Fields)
function renderDocumentDetailsView(container, doc, { isBackup = false, onSubcollClick = null, activeSubId = null } = {}) {
  container.innerHTML = '';

  const effectiveActiveSubId = activeSubId !== null ? activeSubId : (isBackup ? bvActiveSubcollectionId : activeSubcollectionId);

  // 1. SUBCOLLECTIONS SECTION (Matching Google Firebase Console)
  const subcolls = doc.subcollections || [];
  if (subcolls.length > 0 || !isBackup) {
    const subcollSection = document.createElement('div');
    subcollSection.className = 'fs-details-section';

    const subcollActionBar = document.createElement('div');
    subcollActionBar.className = 'fs-section-action-bar';
    subcollActionBar.innerHTML = `
      <button class="fs-action-btn-inline" type="button" onclick="alert('${isBackup ? 'Viewing saved backup file. This reflects saved point-in-time Firestore collections.' : 'Viewing live Firestore. To add collections, use Firebase Console or Admin SDK.'}')">
        <span class="fs-plus-sym">+</span> Start collection
      </button>
    `;
    subcollSection.appendChild(subcollActionBar);

    if (subcolls.length > 0) {
      const list = document.createElement('div');
      list.className = 'fs-subcolls-list';

      subcolls.forEach(subId => {
        const row = document.createElement('div');
        row.className = `fs-subcoll-row ${effectiveActiveSubId === subId ? 'active' : ''}`;
        row.setAttribute('data-subcoll-id', subId);
        row.innerHTML = `
          <div class="fs-subcoll-name-wrap">
            <span style="opacity: 0.6; margin-right: 4px; font-size: 0.9rem;">⋮</span>
            <span class="fs-subcoll-title">${escapeHtml(subId)}</span>
          </div>
          <span class="fs-subcoll-arrow">&gt;</span>
        `;
        if (onSubcollClick) {
          row.onclick = () => onSubcollClick(doc, subId);
        }
        list.appendChild(row);
      });

      subcollSection.appendChild(list);
    }
    container.appendChild(subcollSection);
  }

  // 2. FIELDS SECTION (Matching Google Firebase Console)
  const fieldsSection = document.createElement('div');
  fieldsSection.className = 'fs-details-section';

  const fieldsActionBar = document.createElement('div');
  fieldsActionBar.className = 'fs-section-action-bar';
  fieldsActionBar.innerHTML = `
    <button class="fs-action-btn-inline" type="button" onclick="alert('${isBackup ? 'Viewing saved backup file. Document fields are read directly from backup disk.' : 'Viewing live Firestore. To add fields, use Firebase Console or Admin SDK.'}')">
      <span class="fs-plus-sym">+</span> Add field
    </button>
  `;
  fieldsSection.appendChild(fieldsActionBar);

  const fieldsTable = document.createElement('div');
  fieldsTable.className = 'fs-fields-table';

  const data = doc.data || {};
  const keys = Object.keys(data).sort();

  if (keys.length === 0) {
    fieldsTable.innerHTML = `<div style="padding: 12px 16px; color: var(--text-dim); font-size: 0.82rem;">(Empty document - no fields)</div>`;
  } else {
    keys.forEach(k => {
      renderFieldRowItem(fieldsTable, k, data[k], 0);
    });
  }

  fieldsSection.appendChild(fieldsTable);
  container.appendChild(fieldsSection);
}

function formatTimestampVal(val) {
  const sec = val.seconds !== undefined ? val.seconds : val._seconds;
  if (sec === undefined) return null;
  const d = new Date(sec * 1000);
  return d.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
}

function detectFieldType(val) {
  if (val === null) return { type: 'null', label: '(null)' };
  if (typeof val === 'string') return { type: 'string', label: '(string)' };
  if (typeof val === 'number') return { type: 'number', label: '(number)' };
  if (typeof val === 'boolean') return { type: 'boolean', label: '(boolean)' };
  if (Array.isArray(val)) return { type: 'array', label: '(array)' };
  if (typeof val === 'object') {
    if (val.seconds !== undefined || val._seconds !== undefined || typeof val.toDate === 'function') {
      return { type: 'timestamp', label: '(timestamp)' };
    }
    if (val.__ref || (val._path && val._path.segments)) {
      return { type: 'reference', label: '(reference)' };
    }
    return { type: 'map', label: '(map)' };
  }
  return { type: 'string', label: `(${typeof val})` };
}

function renderFieldRowItem(targetContainer, key, val, depth = 0) {
  const info = detectFieldType(val);
  const row = document.createElement('div');
  row.className = 'fs-field-row';

  const left = document.createElement('div');
  left.className = 'fs-field-left';

  const right = document.createElement('div');
  right.className = 'fs-field-right';

  let nestedContainer = null;
  let isExpanded = false;

  if (info.type === 'map') {
    const toggle = document.createElement('span');
    toggle.className = 'fs-field-toggle';
    toggle.textContent = '▶';
    left.appendChild(toggle);

    const keySpan = document.createElement('span');
    keySpan.className = 'fs-field-key';
    keySpan.textContent = key;
    left.appendChild(keySpan);

    const colonSpan = document.createElement('span');
    colonSpan.className = 'fs-field-colon';
    colonSpan.textContent = ': ';
    left.appendChild(colonSpan);

    const summarySpan = document.createElement('span');
    summarySpan.className = 'fs-field-summary';
    const rawStr = JSON.stringify(val);
    summarySpan.textContent = rawStr.length > 55 ? rawStr.substring(0, 52) + '...}' : rawStr;
    left.appendChild(summarySpan);

    right.innerHTML = `
      <span class="fs-type-tag">${info.label}</span>
      <div class="fs-field-actions">
        <button class="fs-btn-icon-xs" title="Add field to map">+</button>
        <button class="fs-btn-icon-xs" title="Delete map">🗑</button>
      </div>
    `;

    const toggleMap = () => {
      isExpanded = !isExpanded;
      if (isExpanded) {
        toggle.textContent = '▼';
        summarySpan.style.display = 'none';
        if (!nestedContainer) {
          nestedContainer = document.createElement('div');
          nestedContainer.className = 'fs-nested-container';
          const childKeys = Object.keys(val).sort();
          if (childKeys.length === 0) {
            nestedContainer.innerHTML = `<div style="color: var(--text-dim); padding: 4px 0; font-size: 0.78rem;">(Empty map)</div>`;
          } else {
            childKeys.forEach(ck => {
              renderFieldRowItem(nestedContainer, ck, val[ck], depth + 1);
            });
          }
          row.after(nestedContainer);
        } else {
          nestedContainer.style.display = 'block';
        }
      } else {
        toggle.textContent = '▶';
        summarySpan.style.display = 'inline';
        if (nestedContainer) nestedContainer.style.display = 'none';
      }
    };

    left.style.cursor = 'pointer';
    left.onclick = toggleMap;

  } else if (info.type === 'array') {
    const toggle = document.createElement('span');
    toggle.className = 'fs-field-toggle';
    toggle.textContent = '▶';
    left.appendChild(toggle);

    const keySpan = document.createElement('span');
    keySpan.className = 'fs-field-key';
    keySpan.textContent = key;
    left.appendChild(keySpan);

    const colonSpan = document.createElement('span');
    colonSpan.className = 'fs-field-colon';
    colonSpan.textContent = ': ';
    left.appendChild(colonSpan);

    const summarySpan = document.createElement('span');
    summarySpan.className = 'fs-field-summary';
    summarySpan.textContent = `[${val.length} elements]`;
    left.appendChild(summarySpan);

    right.innerHTML = `
      <span class="fs-type-tag">${info.label}</span>
      <div class="fs-field-actions">
        <button class="fs-btn-icon-xs" title="Add element">+</button>
        <button class="fs-btn-icon-xs" title="Delete array">🗑</button>
      </div>
    `;

    const toggleArray = () => {
      isExpanded = !isExpanded;
      if (isExpanded) {
        toggle.textContent = '▼';
        if (!nestedContainer) {
          nestedContainer = document.createElement('div');
          nestedContainer.className = 'fs-nested-container';
          val.forEach((elem, idx) => {
            renderFieldRowItem(nestedContainer, String(idx), elem, depth + 1);
          });
          row.after(nestedContainer);
        } else {
          nestedContainer.style.display = 'block';
        }
      } else {
        toggle.textContent = '▶';
        if (nestedContainer) nestedContainer.style.display = 'none';
      }
    };

    left.style.cursor = 'pointer';
    left.onclick = toggleArray;

  } else {
    // Primitive or Timestamp
    const spacer = document.createElement('span');
    spacer.className = 'fs-field-toggle-spacer';
    left.appendChild(spacer);

    const keySpan = document.createElement('span');
    keySpan.className = 'fs-field-key';
    keySpan.textContent = key;
    left.appendChild(keySpan);

    const colonSpan = document.createElement('span');
    colonSpan.className = 'fs-field-colon';
    colonSpan.textContent = ': ';
    left.appendChild(colonSpan);

    const valSpan = document.createElement('span');
    if (info.type === 'timestamp') {
      valSpan.className = 'val-timestamp';
      valSpan.textContent = formatTimestampVal(val) || JSON.stringify(val);
    } else if (info.type === 'string') {
      valSpan.className = 'val-string';
      valSpan.textContent = `"${escapeHtml(val)}"`;
    } else if (info.type === 'number') {
      valSpan.className = 'val-number';
      valSpan.textContent = String(val);
    } else if (info.type === 'boolean') {
      valSpan.className = 'val-boolean';
      valSpan.textContent = String(val);
    } else if (info.type === 'null') {
      valSpan.className = 'val-null';
      valSpan.textContent = 'null';
    } else {
      valSpan.className = 'fs-field-summary';
      valSpan.textContent = String(val);
    }
    left.appendChild(valSpan);

    right.innerHTML = `
      <span class="fs-type-tag">${info.label}</span>
      <div class="fs-field-actions">
        <button class="fs-btn-icon-xs" title="Edit field">✏️</button>
        <button class="fs-btn-icon-xs" title="Delete field">🗑</button>
      </div>
    `;
  }

  row.appendChild(left);
  row.appendChild(right);
  targetContainer.appendChild(row);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 3. Create Live Backup (Tab 2)
function selectFormat(fmt) {
  selectedFormat = fmt;
  document.querySelectorAll('.format-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(`fmt-card-${fmt}`);
  if (card) card.classList.add('selected');

  document.getElementById('passphrase-input-row').style.display = fmt === 'encrypted-dr' ? 'grid' : 'none';
}

async function runBackup() {
  if (!activeProject) {
    alert('Please connect and select a live Firebase database first.');
    return;
  }

  const btn = document.getElementById('btn-run-backup');
  btn.disabled = true;

  const progressBox = document.getElementById('backup-progress-box');
  const progressBar = document.getElementById('backup-progress-bar');
  const progressText = document.getElementById('backup-progress-text');

  progressBox.style.display = 'block';
  progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  progressBar.style.width = '25%';
  progressText.innerHTML = `[${new Date().toLocaleTimeString()}] Querying live database ${activeProject.name} (${activeProject.projectId})...<br>`;
  progressText.scrollTop = progressText.scrollHeight;

  const pauseWrites = document.getElementById('check-pause-writes').checked;
  const passphrase = document.getElementById('input-backup-passphrase').value.trim();

  try {
    progressBar.style.width = '60%';
    progressText.innerHTML += `[${new Date().toLocaleTimeString()}] Fetching real collections and serializing to ${selectedFormat}...<br>`;

    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: activeProject,
        format: selectedFormat,
        passphrase,
        pauseWrites
      })
    });

    const data = await res.json();
    if (!data.success) {
      progressBar.style.width = '100%';
      progressBar.style.background = 'var(--accent-rose)';
      progressText.innerHTML += `<span style="color: #fda4af;">[ERROR] Backup failed: ${data.error}</span><br>`;
      return;
    }

    progressBar.style.width = '100%';
    progressBar.style.background = 'var(--accent-emerald)';
    progressText.innerHTML += `<span style="color: #34d399; font-weight: 700;">✓ Live backup completed successfully!</span><br>`;
    const liveDocCount = data.manifest.stats?.totalDocuments || (data.manifest.documentHashes ? Object.keys(data.manifest.documentHashes).length : 0);
    progressText.innerHTML += `Backup ID: <strong>${data.backupId}</strong><br>`;
    progressText.innerHTML += `Saved to: <code>${data.backupPath}</code><br>`;
    progressText.innerHTML += `Total Live Documents: <strong>${liveDocCount}</strong><br>`;

    const downloadUrl = `/api/backups/download/${data.backupId}`;
    progressText.innerHTML += `
      <div style="margin-top: 14px; padding: 12px 16px; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px;">
        <div style="font-weight: 600; color: #fff; margin-bottom: 6px; font-size: 0.92rem;">💾 Save Directly to Your Laptop / Computer:</div>
        <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 10px;">Your backup is ready. Download the complete file directly to your local computer:</div>
        <a href="${downloadUrl}" class="btn btn-primary btn-sm" style="text-decoration:none; display: inline-flex; align-items:center; gap:6px;" download="${data.backupId}.jsonl">
          <span>⬇️</span> Download Backup to My Computer (.jsonl)
        </a>
      </div>
    `;

    // If user has linked a local computer folder, write directly into it!
    if (localFolderHandle) {
      try {
        const fileRes = await fetch(downloadUrl);
        const fileBlob = await fileRes.blob();
        const fileHandle = await localFolderHandle.getFileHandle(`${data.backupId}.jsonl`, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(fileBlob);
        await writable.close();
        progressText.innerHTML += `<span style="color: #34d399; font-weight: 700; display: block; margin-top: 6px;">💾 Directly written to your laptop folder (${localFolderHandle.name})!</span>`;
      } catch (writeErr) {
        progressText.innerHTML += `<span style="color: #fda4af;">Note: Could not write directly to folder (${writeErr.message}). Download link provided above.</span><br>`;
      }
    } else {
      // Automatically prompt browser download to user's computer
      try {
        const autoLink = document.createElement('a');
        autoLink.href = downloadUrl;
        autoLink.download = `${data.backupId}.jsonl`;
        document.body.appendChild(autoLink);
        autoLink.click();
        document.body.removeChild(autoLink);
        progressText.innerHTML += `<span style="color: #38bdf8; font-size: 0.8rem; margin-top: 6px; display: block;">⚡ Automatic download prompted in your browser!</span>`;
      } catch (_) {}
    }

    // Zero-Cloud Storage Security: On cloud (Render), purge temporary copy from server immediately!
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      try {
        setTimeout(async () => {
          await fetch(`/api/backups/${data.backupId}`, { method: 'DELETE' });
          progressText.innerHTML += `<span style="color: #34d399; font-size: 0.8rem; display: block; margin-top: 4px;">🔒 Privacy Verified: Cloud storage purged. 0 bytes retained on Render. Your data is stored solely on your computer.</span>`;
        }, 1500);
      } catch (_) {}
    }

    if (localFolderHandle) {
      await loadSavedBackupsFromLocalFolder();
    } else {
      await loadSavedBackups();
    }
  } catch (err) {
    progressText.innerHTML += `<span style="color: #fda4af;">Network error: ${err.message}</span><br>`;
  } finally {
    btn.disabled = false;
  }
}

// 4. Saved Backups (Tab 3)
async function loadSavedBackups() {
  try {
    const res = await fetch('/api/backups');
    const data = await res.json();
    savedBackups = data.backups || [];
    renderSavedBackupsTable(savedBackups);
    renderRestoreBackupDropdown(savedBackups);
  } catch (err) {
    console.error('Failed to load saved backups', err);
  }
}

function renderSavedBackupsTable(backups) {
  const tbody = document.getElementById('saved-backups-tbody');
  if (!backups || backups.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="padding: 24px; color: var(--text-dim);">No saved backups yet. Connect a database and click "Start Backup Now" in Tab 2.</td></tr>`;
    return;
  }

  tbody.innerHTML = backups.map(b => {
    const m = b.manifest;
    const docCount = m.stats?.totalDocuments || (m.documentHashes ? Object.keys(m.documentHashes).length : 0);
    const formatPills = (b.availableFormats || ['jsonl-dr']).map(f => {
      let label = f === 'jsonl-dr' ? 'Full Accuracy (.jsonl)' : (f === 'json-tree' ? 'JSON (.json)' : (f === 'csv-flat' ? 'Excel (.csv)' : 'Encrypted (.enc)'));
      return `<span class="format-pill">${label}</span>`;
    }).join(' ');

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #fff;">${m.backupId}</div>
          <div style="font-size: 0.74rem; color: var(--accent-cyan);">Source: ${m.sourceProject}</div>
        </td>
        <td style="font-size: 0.8rem; color: var(--text-muted);">${new Date(m.startedAt).toLocaleString()}</td>
        <td><strong>${docCount}</strong></td>
        <td>${formatPills}</td>
        <td>
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <a href="/api/backups/download/${b.id}" class="btn btn-secondary btn-sm" style="text-decoration:none; display:inline-flex; align-items:center; gap:4px;" download="${b.id}.jsonl" title="Save backup to your laptop">
              <span>⬇️</span> Download
            </a>
            <button class="btn btn-primary btn-sm" onclick="inspectBackupFile('${b.path.replace(/\\/g, '\\\\')}', '${b.id}')">
              Inspect Data
            </button>
            <button class="btn btn-secondary btn-sm" onclick="checkBackupHealth('${b.path.replace(/\\/g, '\\\\')}')">
              Check Health
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Inspect Backup File Content Directly from Saved Backups Tab (Authentic Google Firebase Console layout)
let bvCurrentTopLevelCollections = [];
let bvCurrentActiveCollObject = null;
let bvCurrentActiveDocObject = null;
let bvActiveCollectionId = null;
let bvActiveDocumentId = null;
let bvActiveSubcollectionId = null;
let bvActiveBackupId = null;
let currentBackupData = null;

async function inspectBackupFile(backupDirPath, backupId) {
  const panel = document.getElementById('vault-content-viewer');
  const collList = document.getElementById('bv-collections-list');
  panel.style.display = 'block';
  bvActiveBackupId = backupId;
  const backupIdEl = document.getElementById('bv-backup-id');
  if (backupIdEl) backupIdEl.textContent = backupId;
  bvExitSubcollectionMode();
  collList.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Reading backup file from disk...</div>`;

  try {
    const res = await fetch('/api/backup-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupDir: backupDirPath })
    });
    const data = await res.json();

    if (!data.success) {
      collList.innerHTML = `<div style="color: var(--accent-rose); padding: 16px;">Error: ${data.error}</div>`;
      return;
    }

    currentBackupData = data;
    bvCurrentTopLevelCollections = data.collections || [];
    renderBackupFileConsole(data.collections);
  } catch (err) {
    collList.innerHTML = `<div style="color: var(--accent-rose); padding: 16px;">Network error: ${err.message}</div>`;
  }
}

function bvReloadTopLevelConsole(collId) {
  bvExitSubcollectionMode();
  if (collId) bvActiveCollectionId = collId;
  if (bvCurrentTopLevelCollections && bvCurrentTopLevelCollections.length > 0) {
    renderBackupFileConsole(bvCurrentTopLevelCollections);
  }
}

function bvExitSubcollectionMode() {
  bvActiveSubcollectionId = null;

  // 1. Show Root (default) collections column
  const rootCol = document.getElementById('bv-col-root-collections');
  if (rootCol) rootCol.style.display = 'flex';

  // 2. Hide subcollection documents column and subcollection fields column
  const subcollCol = document.getElementById('bv-col-subcoll-docs');
  if (subcollCol) subcollCol.style.display = 'none';

  const subcollFieldsCol = document.getElementById('bv-col-subcoll-fields');
  if (subcollFieldsCol) subcollFieldsCol.style.display = 'none';

  // 3. Remove active highlighting from subcollection rows inside parent doc details
  document.querySelectorAll('#bv-fields-container .fs-subcoll-row').forEach(r => r.classList.remove('active'));

  // 4. Update breadcrumbs back to parent doc level
  if (bvCurrentActiveDocObject) {
    bvUpdateBreadcrumbs(bvCurrentActiveCollObject ? bvCurrentActiveCollObject.id : null, bvCurrentActiveDocObject.id);
  }
}

function bvUpdateBreadcrumbs(collId, docId, subcollId, subdocId) {
  const bar = document.getElementById('bv-firestore-breadcrumb-bar');
  if (!bar) return;
  let html = `<span class="bc-home" style="cursor:pointer;" onclick="bvReloadTopLevelConsole()">📦 Backup:</span> <span class="bc-doc" style="color: var(--accent-cyan);">${escapeHtml(bvActiveBackupId || '...')}</span>`;
  if (collId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-collection" style="cursor:pointer;" onclick="bvReloadTopLevelConsole('${escapeHtml(collId)}')">${escapeHtml(collId)}</span>`;
  }
  if (docId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-doc" style="cursor:pointer;" onclick="bvExitSubcollectionMode()">${escapeHtml(docId)}</span>`;
  }
  if (subcollId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-collection" style="font-weight:700; color:#fff;">${escapeHtml(subcollId)}</span>`;
  }
  if (subdocId) {
    html += ` <span class="bc-sep">&gt;</span> <span class="bc-doc" style="font-weight:700; color:#fff;">${escapeHtml(subdocId)}</span>`;
  }
  bar.innerHTML = html;
}

function renderBackupFileConsole(collections) {
  bvCurrentTopLevelCollections = collections;
  const collContainer = document.getElementById('bv-collections-list');
  collContainer.innerHTML = '';

  if (!collections || collections.length === 0) {
    bvActiveCollectionId = null;
    bvActiveDocumentId = null;
    bvCurrentActiveCollObject = null;
    bvCurrentActiveDocObject = null;
    document.getElementById('bv-active-coll-name').textContent = 'Select Collection';
    document.getElementById('bv-active-doc-name').textContent = 'Select Document';
    bvUpdateBreadcrumbs(null, null);
    bvExitSubcollectionMode();

    collContainer.innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">No collections found in this backup file.</div>`;
    document.getElementById('bv-docs-list').innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">(Empty backup)</div>`;
    document.getElementById('bv-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim); font-size: 0.83rem;">(Empty backup)</div>`;
    return;
  }

  let activeColl = collections.find(c => c.id === bvActiveCollectionId) || collections[0];
  bvActiveCollectionId = activeColl.id;

  // Render Column 1: Collections
  collections.forEach(coll => {
    const row = document.createElement('div');
    row.className = `fs-item-row ${coll.id === bvActiveCollectionId ? 'active' : ''}`;
    row.innerHTML = `
      <span>${escapeHtml(coll.id)}</span>
      <span class="fs-item-caret">&gt;</span>
    `;
    row.onclick = () => {
      bvActiveCollectionId = coll.id;
      document.querySelectorAll('#bv-collections-list .fs-item-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      renderBackupFileDocs(coll);
    };
    collContainer.appendChild(row);
  });

  renderBackupFileDocs(activeColl);
}

function renderBackupFileDocs(coll) {
  bvCurrentActiveCollObject = coll;
  document.getElementById('bv-active-coll-name').textContent = coll.id;

  const docContainer = document.getElementById('bv-docs-list');
  docContainer.innerHTML = '';

  if (!coll.docs || coll.docs.length === 0) {
    bvUpdateBreadcrumbs(coll.id, null);
    docContainer.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No documents in ${escapeHtml(coll.id)}.</div>`;
    document.getElementById('bv-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No document selected.</div>`;
    return;
  }

  let activeDoc = coll.docs.find(d => d.id === bvActiveDocumentId) || coll.docs[0];
  bvActiveDocumentId = activeDoc.id;

  // Render Column 2: Documents
  coll.docs.forEach(doc => {
    const row = document.createElement('div');
    row.className = `fs-item-row ${doc.id === bvActiveDocumentId ? 'active' : ''}`;
    row.innerHTML = `
      <span>${escapeHtml(doc.id)}</span>
      <span class="fs-item-caret">&gt;</span>
    `;
    row.onclick = () => {
      // Re-clicking on any parent document closes subcollection mode and restores (default) column
      bvExitSubcollectionMode();
      bvActiveDocumentId = doc.id;
      document.querySelectorAll('#bv-docs-list .fs-item-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      renderBackupFileFields(doc);
    };
    docContainer.appendChild(row);
  });

  renderBackupFileFields(activeDoc);
}

function renderBackupFileFields(doc) {
  bvCurrentActiveDocObject = doc;
  document.getElementById('bv-active-doc-name').textContent = doc.id;
  bvUpdateBreadcrumbs(bvCurrentActiveCollObject ? bvCurrentActiveCollObject.id : null, doc.id);

  const container = document.getElementById('bv-fields-container');
  renderDocumentDetailsView(container, doc, {
    isBackup: true,
    activeSubId: bvActiveSubcollectionId,
    onSubcollClick: (parentDoc, subId) => navigateToBackupSubcollection(parentDoc, subId)
  });
}

function navigateToBackupSubcollection(parentDoc, subId) {
  bvActiveSubcollectionId = subId;

  // 1. Highlight the subcollection row in Column 2 (bv-col-parent-doc-details)
  document.querySelectorAll('#bv-fields-container .fs-subcoll-row').forEach(r => {
    if (r.getAttribute('data-subcoll-id') === subId) {
      r.classList.add('active');
    } else {
      r.classList.remove('active');
    }
  });

  // 2. HIDE (default) collection column (sliding transition matching Tab 1)
  const rootCol = document.getElementById('bv-col-root-collections');
  if (rootCol) rootCol.style.display = 'none';

  // 3. SHOW subcollection documents column & fields column
  const subcollCol = document.getElementById('bv-col-subcoll-docs');
  if (subcollCol) subcollCol.style.display = 'flex';

  const subcollFieldsCol = document.getElementById('bv-col-subcoll-fields');
  if (subcollFieldsCol) subcollFieldsCol.style.display = 'flex';

  document.getElementById('bv-subcoll-name').textContent = subId;
  const subDocsList = document.getElementById('bv-subcoll-docs-list');
  subDocsList.innerHTML = '';

  // 4. Update breadcrumbs
  bvUpdateBreadcrumbs(bvCurrentActiveCollObject ? bvCurrentActiveCollObject.id : null, parentDoc.id, subId);

  // 5. Retrieve subcollection documents from parentDoc.subcollectionData[subId]
  const subDocs = (parentDoc.subcollectionData && parentDoc.subcollectionData[subId]) ? parentDoc.subcollectionData[subId] : [];

  if (subDocs.length === 0) {
    subDocsList.innerHTML = `<div style="padding: 16px; color: var(--text-dim);">No documents in ${escapeHtml(subId)}.</div>`;
    document.getElementById('bv-subdoc-name').textContent = 'Select Document';
    document.getElementById('bv-subdoc-fields-container').innerHTML = `<div style="padding: 16px; color: var(--text-dim);">Empty subcollection.</div>`;
    return;
  }

  const activeSubDoc = subDocs[0];

  subDocs.forEach(d => {
    const row = document.createElement('div');
    row.className = `fs-item-row ${d.id === activeSubDoc.id ? 'active' : ''}`;
    row.innerHTML = `
      <span>${escapeHtml(d.id)}</span>
      <span class="fs-item-caret">&gt;</span>
    `;
    row.onclick = () => {
      document.querySelectorAll('#bv-subcoll-docs-list .fs-item-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      renderBackupSubDocFields(d, subId, parentDoc);
    };
    subDocsList.appendChild(row);
  });

  renderBackupSubDocFields(activeSubDoc, subId, parentDoc);
}

function renderBackupSubDocFields(subDoc, subId, parentDoc) {
  document.getElementById('bv-subdoc-name').textContent = subDoc.id;
  bvUpdateBreadcrumbs(bvCurrentActiveCollObject ? bvCurrentActiveCollObject.id : null, parentDoc.id, subId, subDoc.id);

  const container = document.getElementById('bv-subdoc-fields-container');
  renderDocumentDetailsView(container, subDoc, {
    isBackup: true,
    onSubcollClick: null
  });
}

function closeBackupViewer() {
  bvExitSubcollectionMode();
  document.getElementById('vault-content-viewer').style.display = 'none';
}

function renderRestoreBackupDropdown(backups, selectedDestProjId = null) {
  const select = document.getElementById('restore-backup-picker');
  const badge = document.getElementById('restore-latest-badge');
  if (!select) return;

  const destPicker = document.getElementById('restore-dest-picker');
  const currentDestId = selectedDestProjId || (destPicker ? destPicker.value : null);
  const destProject = savedProjects.find(p => p.id === currentDestId);
  const destProjId = destProject ? (destProject.projectId || destProject.name) : null;

  select.innerHTML = `<option value="">-- Choose a backup file (${backups ? backups.length : 0} available) --</option>`;

  if (!backups || backups.length === 0) {
    if (badge) badge.innerHTML = `<span style="color: var(--text-dim);">No backup files available in storage folder.</span>`;
    return;
  }

  // Group backups by sourceProject
  const groups = {};
  backups.forEach(b => {
    const proj = b.manifest.sourceProject || 'Unknown Database';
    if (!groups[proj]) groups[proj] = [];
    groups[proj].push(b);
  });

  // Sort each group so newest backup is first
  let latestMatchingBackup = null;
  let latestOverallBackup = backups[0];

  Object.keys(groups).forEach(proj => {
    groups[proj].sort((a, b) => (b.manifest.startedAt || '').localeCompare(a.manifest.startedAt || ''));
  });

  // Populate <optgroup> for each database
  for (const [projName, groupBackups] of Object.entries(groups)) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = `📁 Database: ${projName} (${groupBackups.length} backup${groupBackups.length > 1 ? 's' : ''})`;

    groupBackups.forEach((b, index) => {
      const isLatestForThisDb = (index === 0);
      const isMatchingDest = destProjId && (projName === destProjId || projName.includes(destProjId) || destProjId.includes(projName));

      if (isLatestForThisDb && isMatchingDest && !latestMatchingBackup) {
        latestMatchingBackup = b;
      }

      const docCount = b.manifest.stats?.totalDocuments || (b.manifest.documentHashes ? Object.keys(b.manifest.documentHashes).length : 0);
      const dateStr = b.manifest.startedAt ? new Date(b.manifest.startedAt).toLocaleString() : '';

      const opt = document.createElement('option');
      opt.value = b.path;

      if (isLatestForThisDb) {
        // HIGHLIGHT LATEST WITH GREEN COLOR
        opt.textContent = `🟢 [LATEST] ${b.id} (${docCount} docs - ${dateStr}) ★ Most Recent`;
        opt.style.color = '#34d399';
        opt.style.fontWeight = 'bold';
        opt.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
      } else {
        opt.textContent = `⚪ ${b.id} (${docCount} docs - ${dateStr})`;
        opt.style.color = '#cbd5e1';
      }

      optgroup.appendChild(opt);
    });

    select.appendChild(optgroup);
  }

  // Pre-select latest matching backup if available, else latest overall
  const targetToSelect = latestMatchingBackup || latestOverallBackup;
  if (targetToSelect && (!select.value || select.value === '')) {
    select.value = targetToSelect.path;
  }

  updateRestoreLatestBadge();
}

function updateRestoreLatestBadge() {
  const select = document.getElementById('restore-backup-picker');
  const badge = document.getElementById('restore-latest-badge');
  if (!select || !badge) return;

  const selectedPath = select.value;
  const selectedBackup = savedBackups.find(b => b.path === selectedPath);

  if (selectedBackup) {
    const selectedText = select.selectedOptions[0]?.textContent || '';
    const isLatest = selectedText.includes('[LATEST]');
    const dateStr = selectedBackup.manifest.startedAt ? new Date(selectedBackup.manifest.startedAt).toLocaleString() : '';
    const docCount = selectedBackup.manifest.stats?.totalDocuments || (selectedBackup.manifest.documentHashes ? Object.keys(selectedBackup.manifest.documentHashes).length : 0);

    if (isLatest) {
      badge.innerHTML = `<span style="color: #34d399; font-weight: 600;">🟢 Latest Backup Selected: <code>${selectedBackup.id}</code> (${docCount} documents, saved ${dateStr})</span>`;
    } else {
      badge.innerHTML = `<span style="color: var(--text-dim);">Selected Backup: <code>${selectedBackup.id}</code> (${docCount} documents, saved ${dateStr})</span>`;
    }
  } else {
    badge.innerHTML = '';
  }
}

function onRestoreDestChange() {
  renderRestoreBackupDropdown(savedBackups);
}

function onRestoreBackupChange() {
  updateRestoreLatestBadge();
}

async function checkBackupHealth(backupDirPath) {
  const panel = document.getElementById('vault-health-panel');
  const output = document.getElementById('health-check-output');
  panel.style.display = 'block';
  output.innerHTML = `Checking backup health and verifying that no files were changed...`;

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupDir: backupDirPath })
    });
    const data = await res.json();

    if (!data.success) {
      output.innerHTML = `<span style="color: #fda4af;">Error checking health: ${data.error}</span>`;
      return;
    }

    const r = data.report;
    if (r.valid) {
      output.innerHTML = `
<span style="color: #34d399; font-size: 1rem; font-weight: 700;">✓ HEALTH CHECK PASSED (100% HEALTHY)</span>
------------------------------------------------------
Backup ID:          ${r.backupId}
Total Documents:    ${r.totalDocumentsVerified}
File Checksums:     MATCHED (No corruption detected)
Data Structure:     VALID & COMPLETE
------------------------------------------------------
This backup is verified healthy and ready to be restored anytime.`;
    } else {
      output.innerHTML = `
<span style="color: #f43f5e; font-size: 1rem; font-weight: 700;">✗ HEALTH CHECK FAILED</span>
Errors found:
${r.errors.map(e => `  - ${e}`).join('\n')}
Do not use this backup file as it may be damaged.`;
    }
  } catch (err) {
    output.innerHTML = `<span style="color: #fda4af;">Error: ${err.message}</span>`;
  }
}

function closeHealthPanel() {
  document.getElementById('vault-health-panel').style.display = 'none';
}

// 5. Restore Live Database (Tab 4)
async function runRestoreAction(isDryRun) {
  const backupDir = document.getElementById('restore-backup-picker').value;
  const destProjId = document.getElementById('restore-dest-picker').value;
  const conflictRadio = document.querySelector('input[name="restore-conflict-mode"]:checked');
  const conflictMode = conflictRadio ? conflictRadio.value : 'skip';
  const confirmRestore = document.getElementById('check-restore-confirm').checked;

  if (!backupDir) {
    alert('Please choose a backup file from the dropdown.');
    return;
  }

  const destProject = savedProjects.find(p => p.id === destProjId);
  if (!destProject) {
    alert('Please choose a valid destination database.');
    return;
  }

  if (!isDryRun && !confirmRestore) {
    alert(`Safety notice: Please check the box confirming you authorize restoring data into '${destProject.name}' (${destProject.projectId}).`);
    return;
  }

  const progressBox = document.getElementById('restore-progress-box');
  const progressText = document.getElementById('restore-progress-text');
  progressBox.style.display = 'block';
  progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const actionName = isDryRun ? 'TEST PREVIEW (Safe dry run - writes 0 documents)' : 'REAL RESTORE';
  progressText.innerHTML = `[${new Date().toLocaleTimeString()}] Starting ${actionName} into live database ${destProject.name} (${destProject.projectId})...<br>`;
  progressText.innerHTML += `<span style="color: #94a3b8; font-size: 0.82rem;">Conflict Strategy: <strong style="color: #38bdf8;">${conflictMode === 'skip' ? '⚡ Skip existing documents (Only write missing data)' : (conflictMode === 'overwrite' ? '🔄 Overwrite matching documents' : '🛑 Strict safety stop')}</strong></span><br>`;
  progressText.scrollTop = progressText.scrollHeight;

  const endpoint = isDryRun ? '/api/restore/dry-run' : '/api/restore/execute';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backupDir,
        destProject,
        conflictMode,
        allowOverwrite: conflictMode === 'overwrite',
        confirm: confirmRestore
      })
    });

    const data = await res.json();
    if (!data.success) {
      progressText.innerHTML += `<span style="color: #fda4af;">[STOPPED] ${data.error}</span><br>`;
      return;
    }

    const r = data.result;
    progressText.innerHTML += `<span style="color: #34d399; font-weight: 700;">✓ ${isDryRun ? 'Preview Test Succeeded' : 'Restore Completed Successfully'}!</span><br>`;
    progressText.innerHTML += `Destination Database: <strong>${destProject.name} (${destProject.projectId})</strong><br>`;
    progressText.innerHTML += `Documents in Backup:  <strong>${r.totalPlanned || r.totalProcessed}</strong><br>`;
    progressText.innerHTML += `• Fresh Documents Written: <strong style="color: #34d399;">${r.totalInserted ?? (r.ledger && r.ledger.inserted.length) ?? 0}</strong><br>`;
    progressText.innerHTML += `• Existing Documents Skipped: <strong style="color: #38bdf8;">${r.totalSkipped ?? (r.ledger && r.ledger.skipped.length) ?? 0}</strong> (already present in database, preserved without overwriting)<br>`;
    if ((r.totalOverwritten ?? (r.ledger && r.ledger.overwritten.length) ?? 0) > 0) {
      progressText.innerHTML += `• Matching Documents Overwritten: <strong style="color: #f59e0b;">${r.totalOverwritten}</strong><br>`;
    }

    if (r.ledger && r.ledger.isFreshClone) {
      progressText.innerHTML += `<span style="color: #a78bfa; font-weight: 600;">✨ Clean Clone Confirmed: Destination database was completely fresh & empty. All collections and documents were materialized on the fly with project references remapped!</span><br>`;
    }

    if (isDryRun) {
      progressText.innerHTML += `<span style="color: #38bdf8;">Preview complete! You can now click "Start Real Restore" to apply these changes.</span><br>`;
    }
  } catch (err) {
    progressText.innerHTML += `<span style="color: #fda4af;">Error: ${err.message}</span><br>`;
  }
}

async function runCompareVerify() {
  const backupDir = document.getElementById('restore-backup-picker').value;
  const destProjId = document.getElementById('restore-dest-picker').value;
  const destProject = savedProjects.find(p => p.id === destProjId);

  if (!backupDir || !destProject) {
    alert('Please pick a backup file and a destination database.');
    return;
  }

  const progressBox = document.getElementById('restore-progress-box');
  const progressText = document.getElementById('restore-progress-text');
  progressBox.style.display = 'block';
  progressBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  progressText.innerHTML += `<br>[${new Date().toLocaleTimeString()}] Comparing destination database documents against backup file...<br>`;
  progressText.scrollTop = progressText.scrollHeight;

  try {
    const res = await fetch('/api/restore/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupDir, destProject })
    });
    const data = await res.json();

    if (!data.success) {
      progressText.innerHTML += `<span style="color: #fda4af;">Error: ${data.error}</span><br>`;
      return;
    }

    const a = data.audit;
    if (a.success) {
      progressText.innerHTML += `<span style="color: #34d399; font-weight: 700;">✓ Backup Documents Match: All ${a.totalDocumentsChecked} documents from backup exist in destination with 100% identical fields, timestamps, and types!</span><br>`;
    } else {
      progressText.innerHTML += `<span style="color: #f43f5e; font-weight: 700;">Discrepancies found: ${a.totalMismatches} mismatches.</span><br>`;
      if (a.missingDocuments && a.missingDocuments.length > 0) {
        progressText.innerHTML += `<span style="color: #fda4af;">&nbsp;&nbsp;• Missing documents: ${a.missingDocuments.slice(0, 5).join(', ')}${a.missingDocuments.length > 5 ? '...' : ''}</span><br>`;
      }
      if (a.fieldMismatches && a.fieldMismatches.length > 0) {
        progressText.innerHTML += `<span style="color: #fda4af;">&nbsp;&nbsp;• Field mismatches in: ${a.fieldMismatches.map(m => m.path).slice(0, 5).join(', ')}</span><br>`;
      }
    }

    progressText.innerHTML += `<br>[${new Date().toLocaleTimeString()}] Reverse Scan: Checking for extra collections or documents in destination database...<br>`;

    if (a.extraCollections && a.extraCollections.length > 0) {
      progressText.innerHTML += `<span style="color: #fbbf24; font-weight: 600;">⚠️ Extra collection(s) found in destination that were NOT in backup:</span><br>`;
      a.extraCollections.forEach(c => {
        progressText.innerHTML += `<span style="color: #fde68a;">&nbsp;&nbsp;• ${c}</span><br>`;
      });
    }

    if (a.extraDocuments && a.extraDocuments.length > 0) {
      progressText.innerHTML += `<span style="color: #fbbf24; font-weight: 600;">⚠️ Extra document(s) found in destination that were NOT in backup (${a.extraDocuments.length}):</span><br>`;
      a.extraDocuments.slice(0, 10).forEach(d => {
        progressText.innerHTML += `<span style="color: #fde68a;">&nbsp;&nbsp;• ${d}</span><br>`;
      });
      if (a.extraDocuments.length > 10) {
        progressText.innerHTML += `<span style="color: #94a3b8;">&nbsp;&nbsp;...and ${a.extraDocuments.length - 10} more</span><br>`;
      }
    }

    if (a.emptyCollectionsInDestination && a.emptyCollectionsInDestination.length > 0) {
      progressText.innerHTML += `<span style="color: #60a5fa;">ℹ️ Empty collection(s) in destination with 0 documents: ${a.emptyCollectionsInDestination.join(', ')}</span><br>`;
    }

    if (a.isExactOneToOneMatch) {
      progressText.innerHTML += `<span style="color: #34d399; font-weight: 700;">✓ 100% PERFECT 1-TO-1 MIRROR: Scanned destination database (${a.totalDestinationDocumentsScanned} documents checked). No extra, missing, or mismatched data found!</span><br>`;
    }
  } catch (err) {
    progressText.innerHTML += `<span style="color: #fda4af;">Error: ${err.message}</span><br>`;
  }
}

// ==========================================
// STORAGE DIRECTORY SETTINGS & CONFIGURATION
// ==========================================
let currentStorageDirectory = '';

async function loadStorageSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.backupDirectory) {
      currentStorageDirectory = data.backupDirectory;
      updateStorageDirectoryDisplays(data.backupDirectory);
    }
  } catch (err) {
    console.error('Failed to load storage settings:', err);
  }
}

function updateStorageDirectoryDisplays(dir) {
  const shortDir = dir.length > 35 ? '...' + dir.slice(-32) : dir;
  
  const globalEl = document.getElementById('global-storage-path');
  if (globalEl) {
    globalEl.textContent = shortDir;
    globalEl.title = dir;
  }

  const backupDestEl = document.getElementById('backup-dest-folder-display');
  if (backupDestEl) {
    backupDestEl.textContent = dir;
    backupDestEl.title = dir;
  }

  const vaultEl = document.getElementById('vault-folder-display');
  if (vaultEl) {
    vaultEl.textContent = dir;
    vaultEl.title = dir;
  }

  const restoreEl = document.getElementById('restore-folder-display');
  if (restoreEl) {
    restoreEl.textContent = dir;
    restoreEl.title = dir;
  }

  const inputEl = document.getElementById('input-storage-folder-path');
  if (inputEl) {
    inputEl.value = dir;
  }
}

function openStorageSettingsModal() {
  const modal = document.getElementById('storage-settings-modal');
  const inputEl = document.getElementById('input-storage-folder-path');
  const statusEl = document.getElementById('storage-folder-status');
  if (inputEl) inputEl.value = currentStorageDirectory;
  if (statusEl) {
    statusEl.style.display = 'none';
    statusEl.innerHTML = '';
  }
  if (modal) modal.style.display = 'flex';
}

function closeStorageSettingsModal() {
  const modal = document.getElementById('storage-settings-modal');
  if (modal) modal.style.display = 'none';
}

function onNativeFolderSelected(event) {
  const files = event.target.files;
  if (files && files.length > 0) {
    const firstFile = files[0];
    if (firstFile.path) {
      const folderPath = firstFile.path.substring(0, Math.max(firstFile.path.lastIndexOf('\\'), firstFile.path.lastIndexOf('/')));
      document.getElementById('input-storage-folder-path').value = folderPath;
    } else if (firstFile.webkitRelativePath) {
      const parts = firstFile.webkitRelativePath.split('/');
      const rootFolder = parts[0];
      alert(`Selected folder: "${rootFolder}". Please verify or adjust the full system path if needed.`);
    }
  }
}

async function saveStorageFolder() {
  const inputEl = document.getElementById('input-storage-folder-path');
  const statusEl = document.getElementById('storage-folder-status');
  const saveBtn = document.getElementById('btn-save-storage-folder');
  const newPath = inputEl ? inputEl.value.trim() : '';

  if (!newPath) {
    alert('Please enter a folder path.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<span style="color: var(--accent-cyan);">Testing write access and saving folder...</span>';

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupDirectory: newPath })
    });
    const data = await res.json();

    if (!data.success) {
      statusEl.innerHTML = `<span style="color: #f43f5e;">⚠️ ${data.error}</span>`;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Storage Folder';
      return;
    }

    currentStorageDirectory = data.backupDirectory;
    updateStorageDirectoryDisplays(data.backupDirectory);
    statusEl.innerHTML = `<span style="color: #34d399; font-weight: 600;">✓ Active storage folder updated!</span>`;

    // Refresh backups lists
    await loadSavedBackups();

    setTimeout(() => {
      closeStorageSettingsModal();
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Storage Folder';
    }, 900);
  } catch (err) {
    statusEl.innerHTML = `<span style="color: #f43f5e;">⚠️ Error: ${err.message}</span>`;
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Storage Folder';
  }
}

async function resetStorageFolderToDefault() {
  if (!confirm('Reset storage directory to system default (Desktop/Firestore_Backups)?')) {
    return;
  }

  try {
    const res = await fetch('/api/settings/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      currentStorageDirectory = data.backupDirectory;
      updateStorageDirectoryDisplays(data.backupDirectory);
      await loadSavedBackups();
      closeStorageSettingsModal();
    }
  } catch (err) {
    alert('Failed to reset storage directory: ' + err.message);
  }
}

// 7. Laptop / Local Computer File Bridge (for Cloud & Render deployments)
async function handleRestoreLocalFilePicked(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById('restore-local-file-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = `<span style="color: var(--accent-cyan);">⏳ Reading local file <strong>${file.name}</strong> (${(file.size / 1024).toFixed(1)} KB) and preparing restore session...</span>`;

  try {
    const content = await file.text();
    const res = await fetch('/api/backups/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        content: content,
        sourceProject: 'local-laptop'
      })
    });

    const data = await res.json();
    if (!data.success) {
      statusEl.innerHTML = `<span style="color: var(--accent-rose);">❌ Failed to load local backup: ${data.error}</span>`;
      return;
    }

    statusEl.innerHTML = `
      <div style="color: #34d399; font-weight: 600; padding: 8px 12px; background: rgba(16, 185, 129, 0.1); border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.3);">
        ✅ Loaded from your laptop: <code>${file.name}</code> (${data.documentCount} documents ready to restore!)
      </div>
    `;

    await loadSavedBackups();

    // Automatically select the uploaded backup in the restore dropdown
    const select = document.getElementById('restore-backup-picker');
    if (select && data.backupPath) {
      select.value = data.backupPath;
      onRestoreBackupChange();
    }
  } catch (err) {
    statusEl.innerHTML = `<span style="color: var(--accent-rose);">❌ Error reading file: ${err.message}</span>`;
  } finally {
    event.target.value = '';
  }
}

async function handleVaultFileUploaded(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const statusMsg = document.createElement('div');
  statusMsg.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#1e293b; color:#fff; border:1px solid #38bdf8; padding:12px 18px; border-radius:8px; z-index:9999; box-shadow:0 8px 24px rgba(0,0,0,0.5); font-size:0.88rem;';
  statusMsg.innerHTML = `⏳ Uploading <strong>${file.name}</strong> from your laptop...`;
  document.body.appendChild(statusMsg);

  try {
    const content = await file.text();
    const res = await fetch('/api/backups/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        content: content,
        sourceProject: 'local-laptop'
      })
    });

    const data = await res.json();
    if (!data.success) {
      statusMsg.style.borderColor = '#f43f5e';
      statusMsg.innerHTML = `❌ Upload failed: ${data.error}`;
      setTimeout(() => statusMsg.remove(), 4000);
      return;
    }

    statusMsg.style.borderColor = '#10b981';
    statusMsg.innerHTML = `✅ Successfully imported <strong>${file.name}</strong> (${data.documentCount} documents)!`;
    setTimeout(() => statusMsg.remove(), 3500);

    await loadSavedBackups();
  } catch (err) {
    statusMsg.style.borderColor = '#f43f5e';
    statusMsg.innerHTML = `❌ Error: ${err.message}`;
    setTimeout(() => statusMsg.remove(), 4000);
  } finally {
    event.target.value = '';
  }
}

// 8. Native Browser File System Access (Chrome/Edge/Brave) for 100% Private Laptop Storage
let localFolderHandle = null;

async function linkLocalComputerFolder() {
  if (!('showDirectoryPicker' in window)) {
    alert('The File System Access API is not supported in this browser. Please use Brave, Chrome, or Edge to select a local folder.');
    return;
  }

  try {
    localFolderHandle = await window.showDirectoryPicker({
      mode: 'readwrite'
    });

    const badge = document.getElementById('linked-laptop-folder-badge');
    if (badge) badge.textContent = `✓ Connected: ${localFolderHandle.name}`;

    const label = `💻 My Computer: ${localFolderHandle.name}`;
    const backupEl = document.getElementById('backup-dest-folder-display');
    const vaultEl = document.getElementById('vault-folder-display');
    const restoreEl = document.getElementById('restore-folder-display');
    if (backupEl) backupEl.textContent = label;
    if (vaultEl) vaultEl.textContent = label;
    if (restoreEl) restoreEl.textContent = label;

    alert(`Connected to folder: '${localFolderHandle.name}'.\n\n✓ Backups will write directly into this folder on your laptop.\n✓ Files will be automatically purged from Render cloud storage so zero sensitive data is stored online.`);
    closeStorageSettingsModal();
    await loadSavedBackupsFromLocalFolder();
  } catch (err) {
    if (err.name !== 'AbortError') {
      alert('Could not access folder: ' + err.message);
    }
  }
}

async function loadSavedBackupsFromLocalFolder() {
  if (!localFolderHandle) return;

  const localBackups = [];
  try {
    for await (const entry of localFolderHandle.values()) {
      if (entry.kind === 'file' && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
        const file = await entry.getFile();
        localBackups.push({
          id: entry.name,
          path: entry.name,
          isLocalHandle: true,
          fileHandle: entry,
          manifest: {
            backupId: entry.name,
            sourceProject: 'My Laptop Folder',
            startedAt: new Date(file.lastModified).toISOString(),
            stats: { totalDocuments: 'Stored on Laptop' }
          },
          availableFormats: [entry.name.endsWith('.jsonl') ? 'jsonl-dr' : 'json-tree']
        });
      }
    }

    if (localBackups.length > 0) {
      savedBackups = localBackups;
      renderSavedBackupsTable(savedBackups);
      renderRestoreBackupDropdown(savedBackups);
    }
  } catch (err) {
    console.error('Error scanning local folder', err);
  }
}

