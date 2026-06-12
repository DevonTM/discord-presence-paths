import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';

const DB_URL = '/detectable.db';
const SEARCH_LIMIT = 18;
const SQLITE_DESERIALIZE_FREEONCLOSE = 1;

const state = {
  sqlite3: null,
  db: 0,
  ready: false,
  count: 0,
};

const app = document.querySelector('#app');

app.innerHTML = `
  <main class="shell">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <div class="hero-actions">
          <p class="eyebrow">Detectable paths</p>
          <a class="repo-link" href="https://github.com/DevonTM/discord-presence-paths" target="_blank" rel="noopener noreferrer" aria-label="View the discord-presence-paths repository on GitHub">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.5v-1.9c-2.78.62-3.37-1.22-3.37-1.22-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.35 9.35 0 0 1 12 6.93c.85 0 1.7.12 2.5.35 1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .28.18.6.69.5A10.11 10.11 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/>
            </svg>
            GitHub
          </a>
        </div>
        <h1 id="page-title"><span class="highlight">Game path</span> lookup for Discord presence testing</h1>
        <p class="lede">Search the detectable apps database, then copy the executable path Discord may use as a detection hint.</p>
      </div>

      <div class="search-card">
        <div class="search-card-head">
          <label for="search">Search game name</label>
          <span id="status" class="status loading">Loading</span>
        </div>
        <div class="search-wrapper">
          <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="search" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search" placeholder="Minecraft, Valorant, Stardew…" disabled />
        </div>
      </div>
    </section>

    <section class="results-panel" aria-live="polite">
      <div class="panel-head">
        <h2>Matches</h2>
        <p id="meta">Loading database</p>
      </div>
      <div id="results" class="results empty">
        <p>Start typing a game name to search the database.</p>
      </div>
    </section>

    <aside class="notice">
      <span class="notice-text"><strong>Use responsibly:</strong> Intended for research and compatibility testing only. Misuse or Discord <a href="https://discord.com/terms" target="_blank" rel="noopener noreferrer">ToS</a> violations may put your account at risk.</span>
    </aside>
  </main>
`;

const input = document.querySelector('#search');
const statusEl = document.querySelector('#status');
const metaEl = document.querySelector('#meta');
const resultsEl = document.querySelector('#results');

const normalize = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const debounce = (fn, wait = 120) => {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
};

function ftsQuery(term) {
  return normalize(term)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .map((part) => `${part.replace(/"/g, '""')}*`)
    .join(' ');
}

function escapeHtml(value) {
  const entities = {
    38: '\u0026amp;',
    60: '\u0026lt;',
    62: '\u0026gt;',
    34: '\u0026quot;',
  };
  return String(value).replace(/[&<>"]/g, (char) => entities[char.charCodeAt(0)]);
}

function throwIfSqliteError(sqlite3, rc, message) {
  if (rc) throw new Error(`${message}: ${sqlite3.capi.sqlite3_js_rc_str(rc)}`);
}

function openDatabase(sqlite3, bytes) {
  const { capi, wasm } = sqlite3;
  const ppDb = wasm.allocPtr();
  let db = 0;
  let dataPtr = 0;

  try {
    throwIfSqliteError(
      sqlite3,
      capi.sqlite3_open_v2(':memory:', ppDb, capi.SQLITE_OPEN_READWRITE | capi.SQLITE_OPEN_CREATE | capi.SQLITE_OPEN_MEMORY, null),
      'sqlite3_open_v2 failed',
    );
    db = wasm.peekPtr(ppDb);
    dataPtr = wasm.allocFromTypedArray(bytes);
    throwIfSqliteError(
      sqlite3,
      capi.sqlite3_deserialize(db, 'main', dataPtr, bytes.byteLength, bytes.byteLength, SQLITE_DESERIALIZE_FREEONCLOSE),
      'sqlite3_deserialize failed',
    );
    dataPtr = 0;
    return db;
  } catch (error) {
    if (dataPtr) wasm.dealloc(dataPtr);
    if (db) capi.sqlite3_close_v2(db);
    throw error;
  } finally {
    wasm.dealloc(ppDb);
  }
}

function bindParams(sqlite3, stmt, params) {
  const { capi, wasm } = sqlite3;
  const allocations = [];

  for (const [name, value] of Object.entries(params)) {
    const index = capi.sqlite3_bind_parameter_index(stmt, name);
    if (!index) continue;

    if (Number.isInteger(value)) {
      throwIfSqliteError(sqlite3, capi.sqlite3_bind_int(stmt, index, value), `bind ${name} failed`);
    } else {
      const textPtr = wasm.allocCString(String(value));
      allocations.push(textPtr);
      throwIfSqliteError(sqlite3, capi.sqlite3_bind_text(stmt, index, textPtr, -1, capi.SQLITE_STATIC), `bind ${name} failed`);
    }
  }

  return allocations;
}

function columnValue(sqlite3, stmt, index) {
  const { capi } = sqlite3;
  const type = capi.sqlite3_column_type(stmt, index);
  if (type === capi.SQLITE_NULL) return null;
  if (type === capi.SQLITE_INTEGER) return capi.sqlite3_column_int(stmt, index);
  if (type === capi.SQLITE_FLOAT) return capi.sqlite3_column_double(stmt, index);
  return capi.sqlite3_column_text(stmt, index);
}

function selectObjects(sqlite3, db, sql, params = {}) {
  const { capi, wasm } = sqlite3;
  const ppStmt = wasm.allocPtr();
  let stmt = 0;
  let allocations = [];
  const rows = [];

  try {
    throwIfSqliteError(sqlite3, capi.sqlite3_prepare_v3(db, sql, -1, 0, ppStmt, null), 'prepare failed');
    stmt = wasm.peekPtr(ppStmt);
    allocations = bindParams(sqlite3, stmt, params);

    const columnCount = capi.sqlite3_column_count(stmt);
    const names = Array.from({ length: columnCount }, (_, index) => capi.sqlite3_column_name(stmt, index));

    while (true) {
      const rc = capi.sqlite3_step(stmt);
      if (rc === capi.SQLITE_DONE) break;
      throwIfSqliteError(sqlite3, rc === capi.SQLITE_ROW ? 0 : rc, 'step failed');

      const row = {};
      for (let index = 0; index < columnCount; index += 1) {
        row[names[index]] = columnValue(sqlite3, stmt, index);
      }
      rows.push(row);
    }
  } finally {
    if (stmt) capi.sqlite3_finalize(stmt);
    for (const ptr of allocations) wasm.dealloc(ptr);
    wasm.dealloc(ppStmt);
  }

  return rows;
}

function selectValue(sqlite3, db, sql, params = {}) {
  const rows = selectObjects(sqlite3, db, sql, params);
  if (!rows.length) return undefined;
  return Object.values(rows[0])[0];
}

function renderRows(rows, query) {
  if (!query) {
    resultsEl.className = 'results empty';
    resultsEl.innerHTML = '<p>Start typing a game name to search the database.</p>';
    metaEl.textContent = `${state.count.toLocaleString()} games indexed`;
    return;
  }

  if (rows.length === 0) {
    resultsEl.className = 'results empty';
    resultsEl.innerHTML = '<p>No matches yet. Try a shorter name or a different spelling.</p>';
    metaEl.textContent = `No results for "${query}"`;
    return;
  }

  resultsEl.className = 'results';
  resultsEl.innerHTML = rows.map((row, index) => `
    <article class="result" style="--delay: ${index * 18}ms">
      <div>
        <h3>${escapeHtml(row.name)}</h3>
        <code>${escapeHtml(row.path)}</code>
      </div>
      <button type="button" data-copy="${escapeHtml(row.path)}">Copy</button>
    </article>
  `).join('');
  metaEl.textContent = `${rows.length} ${rows.length === 1 ? 'match' : 'matches'} for "${query}"`;
}

function search(term) {
  const query = term.trim();
  if (!state.ready) return;

  if (query.length < 2) {
    renderRows([], '');
    return;
  }

  const match = ftsQuery(query);
  const prefix = `${normalize(query)}%`;
  const rows = selectObjects(state.sqlite3, state.db, `
    SELECT g.name, g.path
    FROM game_fts fts
    JOIN games g ON g.id = fts.rowid
    WHERE game_fts MATCH $match
    UNION
    SELECT name, path
    FROM games
    WHERE name_norm LIKE $prefix
    ORDER BY name COLLATE NOCASE
    LIMIT $limit
  `, { $match: match, $prefix: prefix, $limit: SEARCH_LIMIT });

  renderRows(rows, query);
}

async function init() {
  try {
    const [sqlite3, response] = await Promise.all([
      sqlite3InitModule({ print: () => {}, printErr: console.error }),
      fetch(DB_URL, { cache: 'no-store' }),
    ]);
    if (!response.ok) throw new Error(`Database fetch failed: ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const db = openDatabase(sqlite3, bytes);

    state.sqlite3 = sqlite3;
    state.db = db;
    state.count = selectValue(sqlite3, db, 'SELECT COUNT(*) AS count FROM games');
    state.ready = true;

    input.disabled = false;
    statusEl.textContent = 'Ready';
    statusEl.classList.remove('loading');
    statusEl.classList.add('ready');
    metaEl.textContent = `${state.count.toLocaleString()} games indexed`;
    renderRows([], '');
  } catch (error) {
    console.error(error);
    statusEl.textContent = 'Failed';
    metaEl.textContent = 'Could not load database';
    resultsEl.innerHTML = '<p>The database file loaded, but SQLite could not open it. Check the browser console for details.</p>';
  }
}

input.addEventListener('input', debounce((event) => search(event.target.value)));
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') input.blur();
});
resultsEl.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-copy]');
  if (!button) return;
  await navigator.clipboard.writeText(button.dataset.copy);
  button.textContent = 'Copied';
  window.setTimeout(() => { button.textContent = 'Copy'; }, 1200);
});

init();
