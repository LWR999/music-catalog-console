'use strict';

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const state = {
  page: 1,
  total: 0,
  loading: false,
  filters: { search: '', genre_id: '', compilation: false, sort: 'artist' },
  scrapeSource: null,
};

// ── Theme ─────────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀' : '☾';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('theme', next);
}

// ── Genres ────────────────────────────────────────────────────────────────────

async function loadGenres() {
  try {
    const res = await fetch('/api/genres');
    const genres = await res.json();
    const sel = document.getElementById('genre-filter');
    genres.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = g.name;
      sel.appendChild(opt);
    });
  } catch (_) { /* silently ignore — genres are optional */ }
}

// ── Albums API ────────────────────────────────────────────────────────────────

function buildQuery() {
  const p = new URLSearchParams({ page: state.page });
  if (state.filters.search)   p.set('search', state.filters.search);
  if (state.filters.genre_id) p.set('genre_id', state.filters.genre_id);
  if (state.filters.compilation) p.set('compilation', 'true');
  if (state.filters.sort) p.set('sort', state.filters.sort);
  return p.toString();
}

async function loadAlbums(append = false) {
  if (state.loading) return;
  state.loading = true;
  if (!append) showGridStatus('Loading…');

  try {
    const res = await fetch(`/api/albums?${buildQuery()}`);
    const data = await res.json();
    state.total = data.total;

    if (!append) document.getElementById('tile-grid').innerHTML = '';
    renderTiles(data.albums);
    updateAlbumCount();
    syncLoadMore();

    if (data.total === 0) {
      showGridStatus('No albums found.');
    } else {
      hideGridStatus();
    }
  } catch (e) {
    showGridStatus('Error loading albums.');
    console.error(e);
  } finally {
    state.loading = false;
  }
}

function resetAndLoad() {
  state.page = 1;
  loadAlbums(false);
}

// ── Tile rendering ────────────────────────────────────────────────────────────

function renderTiles(albums) {
  const grid = document.getElementById('tile-grid');
  const frag = document.createDocumentFragment();
  albums.forEach(album => frag.appendChild(createTile(album)));
  grid.appendChild(frag);
  attachLazyObserver();
}

function createTile(album) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.albumId = album.id;

  let artworkHtml;
  if (album.has_artwork) {
    artworkHtml = `
      <div class="tile-artwork-wrap">
        <img class="tile-artwork lazy"
             data-src="/api/artwork/${album.id}"
             src="${BLANK}"
             alt="${esc(album.title)}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="artwork-placeholder" style="display:none"><span>♫</span></div>
      </div>`;
  } else {
    artworkHtml = `
      <div class="tile-artwork-wrap">
        <div class="artwork-placeholder"><span>♫</span></div>
      </div>`;
  }

  const yearBadge = album.year ? `<span class="badge badge-year">${album.year}</span>` : '';
  const compBadge = album.is_compilation ? '<span class="badge badge-comp">Compilation</span>' : '';
  const fmtBadge  = `<span class="badge badge-format">${esc(album.format)}</span>`;

  tile.innerHTML = `
    ${artworkHtml}
    <div class="tile-info">
      <div class="tile-title" title="${esc(album.title)}">${esc(album.title)}</div>
      <div class="tile-artist" title="${esc(album.artist)}">${esc(album.artist)}</div>
      <div class="tile-meta">${yearBadge}${compBadge}${fmtBadge}</div>
    </div>`;

  tile.addEventListener('click', () => openModal(album.id));
  return tile;
}

// ── Lazy loading ──────────────────────────────────────────────────────────────

let lazyObserver = null;

function attachLazyObserver() {
  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          img.classList.remove('lazy');
          img.classList.add('loaded');
        }
        lazyObserver.unobserve(img);
      });
    }, { rootMargin: '300px' });
  }
  document.querySelectorAll('img.lazy[data-src]').forEach(img => lazyObserver.observe(img));
}

// ── Album count / Load More ───────────────────────────────────────────────────

function updateAlbumCount() {
  const shown = document.querySelectorAll('.tile').length;
  document.getElementById('album-count').textContent = `${shown.toLocaleString()} / ${state.total.toLocaleString()} albums`;
}

function syncLoadMore() {
  const shown = document.querySelectorAll('.tile').length;
  const container = document.getElementById('load-more-container');
  if (shown < state.total) {
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
  }
}

// ── Grid status ───────────────────────────────────────────────────────────────

function showGridStatus(text) {
  const el = document.getElementById('grid-status');
  document.getElementById('status-text').textContent = text;
  el.classList.remove('hidden');
}

function hideGridStatus() {
  document.getElementById('grid-status').classList.add('hidden');
}

// ── Album detail modal ────────────────────────────────────────────────────────

async function openModal(albumId) {
  const modal = document.getElementById('modal');
  const body  = document.getElementById('modal-body');
  body.innerHTML = '<div class="modal-loading">Loading…</div>';
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  try {
    const res  = await fetch(`/api/albums/${albumId}`);
    const data = await res.json();
    renderModal(data);
  } catch (_) {
    body.innerHTML = '<div class="modal-error">Failed to load album details.</div>';
  }
}

function renderModal({ album, tracks }) {
  const artworkSrc = `/api/artwork/${album.id}`;

  const metaRows = [
    row('Artist',  esc(album.artist)),
    row('Year',    album.year
      ? `${album.year}${album.original_year && album.original_year !== album.year
          ? ` <span class="text-muted">(orig. ${album.original_year})</span>` : ''}`
      : null),
    row('Genre',   album.genres || null),
    row('Format',  esc(album.format)),
    row('Label',   album.label   ? esc(album.label)          : null),
    row('Catalog', album.catalog_number ? esc(album.catalog_number) : null),
    album.is_compilation ? row('Type', 'Compilation') : null,
  ].filter(Boolean).join('');

  // Group by disc
  const discs = {};
  tracks.forEach(t => {
    const d = t.disc_number || 1;
    (discs[d] = discs[d] || []).push(t);
  });
  const multiDisc = Object.keys(discs).length > 1;

  const trackRows = Object.keys(discs).sort((a, b) => a - b).map(d => {
    const header = multiDisc
      ? `<tr class="disc-header"><td colspan="3">Disc ${d}</td></tr>`
      : '';
    const rows = discs[d].map(t => `
      <tr>
        <td class="track-num">${t.track_number ?? '—'}</td>
        <td class="track-title">
          ${esc(t.title)}
          ${t.composer ? `<span class="track-composer">${esc(t.composer)}</span>` : ''}
          ${t.artist   ? `<span class="track-artist">${esc(t.artist)}</span>`    : ''}
        </td>
        <td class="track-dur">${formatDuration(t.duration_secs)}</td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-header">
      <div class="modal-artwork-wrap">
        <img class="modal-artwork" src="${artworkSrc}" alt="${esc(album.title)}"
             onerror="this.parentElement.innerHTML='<div class=\\'modal-artwork-placeholder\\'><span>♫</span></div>'">
      </div>
      <div class="modal-album-info">
        <h2 class="modal-title" id="modal-title">${esc(album.title)}</h2>
        <table class="modal-meta-table"><tbody>${metaRows}</tbody></table>
      </div>
    </div>
    <div class="modal-tracks">
      <table class="tracks-table">
        <thead>
          <tr>
            <th class="th-num">#</th>
            <th class="th-title">Title</th>
            <th class="th-dur">Duration</th>
          </tr>
        </thead>
        <tbody>${trackRows}</tbody>
      </table>
    </div>`;
}

function row(label, value) {
  if (!value) return null;
  return `<tr><th>${label}</th><td>${value}</td></tr>`;
}

function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// ── Scrape SSE ────────────────────────────────────────────────────────────────

function startScrape(mode) {
  if (state.scrapeSource) {
    state.scrapeSource.close();
    state.scrapeSource = null;
  }

  const panel  = document.getElementById('scrape-panel');
  const log    = document.getElementById('scrape-log');
  const status = document.getElementById('scrape-status');
  const btnFull = document.getElementById('btn-full-scrape');
  const btnIncr = document.getElementById('btn-incremental-scrape');

  panel.classList.remove('hidden');
  log.innerHTML = '';
  status.textContent = `Running ${mode} scrape…`;
  btnFull.disabled = true;
  btnIncr.disabled = true;

  const source = new EventSource(`/api/scrape/${mode}`);
  state.scrapeSource = source;

  source.addEventListener('message', e => {
    const text = JSON.parse(e.data);
    appendLogLine(log, text);
  });

  source.addEventListener('done', () => {
    source.close();
    state.scrapeSource = null;
    status.textContent = 'Scrape complete.';
    btnFull.disabled = false;
    btnIncr.disabled = false;
  });

  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) {
      source.close();
      state.scrapeSource = null;
      status.textContent = 'Scrape ended.';
      btnFull.disabled = false;
      btnIncr.disabled = false;
    }
  });
}

function appendLogLine(log, text) {
  const div = document.createElement('div');
  div.className = 'log-line';
  if (text.startsWith('[DONE]'))  div.classList.add('log-done');
  if (text.startsWith('[ERROR]')) div.classList.add('log-error');
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadGenres();
  loadAlbums();

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Search (debounced)
  let searchTimer;
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.search = e.target.value.trim();
      resetAndLoad();
    }, 320);
  });

  // Genre filter
  document.getElementById('genre-filter').addEventListener('change', e => {
    state.filters.genre_id = e.target.value;
    resetAndLoad();
  });

  // Compilation checkbox
  document.getElementById('compilation-filter').addEventListener('change', e => {
    state.filters.compilation = e.target.checked;
    resetAndLoad();
  });

  // Sort
  document.getElementById('sort-select').addEventListener('change', e => {
    state.filters.sort = e.target.value;
    resetAndLoad();
  });

  // Clear filters
  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    state.filters = { search: '', genre_id: '', compilation: false, sort: 'artist' };
    document.getElementById('search').value               = '';
    document.getElementById('genre-filter').value         = '';
    document.getElementById('compilation-filter').checked = false;
    document.getElementById('sort-select').value          = 'artist';
    resetAndLoad();
  });

  // Load more
  document.getElementById('btn-load-more').addEventListener('click', () => {
    state.page++;
    loadAlbums(true);
  });

  // Scrape buttons
  document.getElementById('btn-incremental-scrape').addEventListener('click', () => {
    startScrape('incremental');
  });
  document.getElementById('btn-full-scrape').addEventListener('click', () => {
    if (confirm('Full rescrape will rebuild the entire catalog from scratch.\n\nContinue?')) {
      startScrape('full');
    }
  });

  // Close scrape log
  document.getElementById('btn-close-log').addEventListener('click', () => {
    document.getElementById('scrape-panel').classList.add('hidden');
  });

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.querySelector('.modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
