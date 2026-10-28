const FAVORITES_STORAGE_KEY = 'vaultplay_favorites_v1';

let allGames = [];
let activeCategory = 'All';
let searchQuery = '';
let activeGame = null;
let favorites = loadFavorites();

// DOM Elements
const brandLink = document.getElementById('brandLink');
const navLinks = document.querySelectorAll('[data-nav-filter]');
const filterTabs = document.querySelectorAll('[data-filter]');
const randomGameBtn = document.getElementById('randomGameBtn');
const searchInput = document.getElementById('searchInput');
const resultsCount = document.getElementById('resultsCount');
const gamesGrid = document.getElementById('gamesGrid');
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const retryLoadBtn = document.getElementById('retryLoadBtn');
const emptyState = document.getElementById('emptyState');
const emptyMessage = document.getElementById('emptyMessage');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');

const catalogSection = document.getElementById('catalogSection');
const playerSection = document.getElementById('playerSection');
const backToCatalogBtn = document.getElementById('backToCatalogBtn');
const playerFavBtn = document.getElementById('playerFavBtn');
const playerFavLabel = document.getElementById('playerFavLabel');
const reloadGameBtn = document.getElementById('reloadGameBtn');
const toggleEmbedBtn = document.getElementById('toggleEmbedBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const iframeStage = document.getElementById('iframeStage');
const exitTheaterBtn = document.getElementById('exitTheaterBtn');
const iframeMount = document.getElementById('iframeMount');
const playerTitle = document.getElementById('playerTitle');
const playerCategory = document.getElementById('playerCategory');
const playerControls = document.getElementById('playerControls');
const playerSaveStatus = document.getElementById('playerSaveStatus');
const playerDescription = document.getElementById('playerDescription');
const embedPanel = document.getElementById('embedPanel');
const embedCodeDisplay = document.getElementById('embedCodeDisplay');
const copyEmbedBtn = document.getElementById('copyEmbedBtn');

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch (_) {
    return new Set();
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
  } catch (_) {}
}

function toggleFavorite(gameId) {
  if (favorites.has(gameId)) {
    favorites.delete(gameId);
  } else {
    favorites.add(gameId);
  }
  saveFavorites();
  syncPlayerFavoriteState();
  renderCatalog();
}

async function fetchGamesCatalog() {
  loadingState?.classList.remove('hidden');
  errorState?.classList.add('hidden');
  emptyState?.classList.add('hidden');
  if (gamesGrid) gamesGrid.innerHTML = '';

  try {
    const response = await fetch('./games.json');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} when loading games.json`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Invalid games.json format: expected an array of games.');
    }
    allGames = data;
    loadingState?.classList.add('hidden');
    renderCatalog();

    // Check URL hash to deep-link to a game if present
    const hashId = window.location.hash.replace('#play-', '');
    const initialGame = allGames.find((g) => g.id === hashId);
    if (initialGame) {
      openGamePlayer(initialGame);
    }
  } catch (err) {
    loadingState?.classList.add('hidden');
    errorState?.classList.remove('hidden');
    if (errorMessage) {
      errorMessage.textContent = err instanceof Error ? err.message : 'Failed to load games.json.';
    }
  }
}

function getFilteredGames() {
  const q = searchQuery.trim().toLowerCase();
  return allGames.filter((game) => {
    const category = game.category || 'Arcade';
    const matchesCategory =
      activeCategory === 'All' ||
      (activeCategory === 'Favorites' ? favorites.has(game.id) : category === activeCategory);

    if (!matchesCategory) return false;
    if (!q) return true;

    return (
      (game.title || '').toLowerCase().includes(q) ||
      category.toLowerCase().includes(q) ||
      (game.controls || '').toLowerCase().includes(q) ||
      (game.description || '').toLowerCase().includes(q)
    );
  });
}

function syncFilterButtons() {
  navLinks.forEach((link) => {
    const cat = link.getAttribute('data-nav-filter');
    link.classList.toggle('active', cat === activeCategory);
  });
  filterTabs.forEach((tab) => {
    const cat = tab.getAttribute('data-filter');
    tab.classList.toggle('active', cat === activeCategory);
  });
  if (randomGameBtn instanceof HTMLButtonElement) {
    randomGameBtn.disabled = allGames.length === 0;
  }
}

function createFallbackElement(title) {
  const wrap = document.createElement('div');
  wrap.className = 'thumb-fallback';
  wrap.innerHTML = `
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/>
      <line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/>
      <rect width="20" height="12" x="2" y="6" rx="2"/>
    </svg>
    <span></span>
  `;
  const span = wrap.querySelector('span');
  if (span) span.textContent = title;
  return wrap;
}

function renderCatalog() {
  if (!gamesGrid) return;
  syncFilterButtons();

  const filtered = getFilteredGames();
  if (resultsCount) {
    resultsCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'game' : 'games'}`;
  }

  gamesGrid.innerHTML = '';

  if (filtered.length === 0) {
    emptyState?.classList.remove('hidden');
    if (allGames.length === 0) {
      if (emptyMessage) {
        emptyMessage.textContent = 'No games in games.json yet. Add game entries with an iframe embed to populate the arcade.';
      }
      resetFiltersBtn?.classList.add('hidden');
    } else {
      if (emptyMessage) {
        emptyMessage.textContent =
          activeCategory === 'Favorites' && favorites.size === 0
            ? 'You have not saved any favorite games yet. Click the heart icon on any card to bookmark it.'
            : 'No games match your current search or filter.';
      }
      resetFiltersBtn?.classList.remove('hidden');
    }
    return;
  }

  emptyState?.classList.add('hidden');

  filtered.forEach((game) => {
    const isFav = favorites.has(game.id);
    const article = document.createElement('article');
    article.className = 'game-card';

    // Media Thumbnail Slot
    const media = document.createElement('div');
    media.className = 'card-media';
    media.addEventListener('click', () => openGamePlayer(game));

    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = game.thumbnail;
    img.alt = `${game.title} cover artwork`;
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.replaceWith(createFallbackElement(game.title));
    });
    media.appendChild(img);

    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = `fav-icon-btn${isFav ? ' active' : ''}`;
    favBtn.setAttribute('aria-label', isFav ? `Remove ${game.title} from favorites` : `Save ${game.title} to favorites`);
    favBtn.innerHTML = `
      <svg width="17" height="17" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>
      </svg>
    `;
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(game.id);
    });
    media.appendChild(favBtn);

    // Card Content
    const body = document.createElement('div');
    body.className = 'card-body';

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'card-title-btn';
    titleBtn.textContent = game.title;
    titleBtn.addEventListener('click', () => openGamePlayer(game));

    const meta = document.createElement('div');
    meta.className = 'meta-line';
    const catSpan = document.createElement('span');
    catSpan.textContent = game.category;
    const sep = document.createElement('span');
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';
    const ctrlSpan = document.createElement('span');
    ctrlSpan.className = 'mono-text';
    ctrlSpan.textContent = game.controls;
    meta.append(catSpan, sep, ctrlSpan);

    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = game.description;

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn-primary card-play-btn';
    playBtn.textContent = 'Play Now';
    playBtn.addEventListener('click', () => openGamePlayer(game));

    body.append(titleBtn, meta, desc, playBtn);
    article.append(media, body);
    gamesGrid.appendChild(article);
  });
}

function toSameOriginProxyUrl(rawSrc) {
  if (!rawSrc) return rawSrc;
  try {
    const parsed = new URL(rawSrc, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return rawSrc;
    }
    const proto = parsed.protocol.replace(':', '');
    if (proto === 'http' || proto === 'https') {
      return `/game-proxy/${proto}/${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch (_) {}
  return rawSrc;
}

function mountGameIframe(game) {
  if (!iframeMount) return;
  iframeMount.innerHTML = '';

  // Parse off-DOM first so sandbox restrictions and same-origin save proxy apply before navigation
  const template = document.createElement('template');
  template.innerHTML = (game.iframe || '').trim();
  const iframeEl = template.content.querySelector('iframe');
  if (!iframeEl) return;

  const originalSrc = iframeEl.getAttribute('src');
  if (originalSrc) {
    iframeEl.setAttribute('src', toSameOriginProxyUrl(originalSrc));
  }

  // Allow gameplay, WebGL/storage, and controls while blocking popups, new tabs, and top-tab redirects
  iframeEl.setAttribute(
    'sandbox',
    'allow-scripts allow-same-origin allow-pointer-lock allow-forms'
  );

  iframeEl.addEventListener('load', () => {
    try {
      iframeEl.contentWindow?.focus();
    } catch (_) {}
  });

  iframeMount.appendChild(iframeEl);
}

function syncPlayerFavoriteState() {
  if (!activeGame || !playerFavBtn || !playerFavLabel) return;
  const isFav = favorites.has(activeGame.id);
  playerFavBtn.classList.toggle('favorited', isFav);
  playerFavBtn.setAttribute('aria-pressed', String(isFav));
  playerFavLabel.textContent = isFav ? 'Saved' : 'Save Favorite';
}

function openGamePlayer(game) {
  activeGame = game;
  catalogSection?.classList.add('hidden');
  playerSection?.classList.remove('hidden');
  embedPanel?.classList.add('hidden');

  if (playerTitle) playerTitle.textContent = game.title;
  if (playerCategory) playerCategory.textContent = game.category || 'Arcade';
  if (playerControls) playerControls.textContent = game.controls || 'Keyboard / Mouse';
  if (playerSaveStatus) playerSaveStatus.textContent = 'Auto-save active';
  if (playerDescription) playerDescription.textContent = game.description || '';
  if (embedCodeDisplay) embedCodeDisplay.textContent = game.iframe;

  syncPlayerFavoriteState();
  mountGameIframe(game);
  window.history.replaceState(null, '', `#play-${game.id}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeGamePlayer() {
  activeGame = null;
  exitTheaterFullscreen();
  if (iframeMount) iframeMount.innerHTML = '';
  playerSection?.classList.add('hidden');
  catalogSection?.classList.remove('hidden');
  window.history.replaceState(null, '', window.location.pathname);
}

function exitTheaterFullscreen() {
  iframeStage?.classList.remove('theater-fullscreen');
  exitTheaterBtn?.classList.add('hidden');
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

async function enterFullscreen() {
  if (!iframeStage) return;
  if (iframeStage.classList.contains('theater-fullscreen') || document.fullscreenElement) {
    exitTheaterFullscreen();
    return;
  }

  try {
    if (iframeStage.requestFullscreen) {
      await iframeStage.requestFullscreen();
      return;
    }
  } catch (_) {
    // Fallback to viewport-filling theater mode inside restricted iframes
  }

  iframeStage.classList.add('theater-fullscreen');
  exitTheaterBtn?.classList.remove('hidden');
  const iframeEl = iframeMount?.querySelector('iframe');
  iframeEl?.contentWindow?.focus();
}

// Event Listeners
function setCategory(category) {
  activeCategory = category;
  if (activeGame) {
    closeGamePlayer();
  }
  renderCatalog();
}

brandLink?.addEventListener('click', (e) => {
  e.preventDefault();
  searchQuery = '';
  if (searchInput) searchInput.value = '';
  setCategory('All');
});

navLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const cat = link.getAttribute('data-nav-filter') || 'All';
    setCategory(cat);
  });
});

filterTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const cat = tab.getAttribute('data-filter') || 'All';
    setCategory(cat);
  });
});

searchInput?.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderCatalog();
});

resetFiltersBtn?.addEventListener('click', () => {
  searchQuery = '';
  if (searchInput) searchInput.value = '';
  setCategory('All');
});

retryLoadBtn?.addEventListener('click', () => {
  fetchGamesCatalog();
});

randomGameBtn?.addEventListener('click', () => {
  if (allGames.length === 0) return;
  const pool =
    allGames.length > 1 && activeGame
      ? allGames.filter((g) => g.id !== activeGame.id)
      : allGames;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) openGamePlayer(pick);
});

backToCatalogBtn?.addEventListener('click', () => {
  closeGamePlayer();
});

playerFavBtn?.addEventListener('click', () => {
  if (activeGame) toggleFavorite(activeGame.id);
});

reloadGameBtn?.addEventListener('click', () => {
  if (activeGame) mountGameIframe(activeGame);
});

toggleEmbedBtn?.addEventListener('click', () => {
  embedPanel?.classList.toggle('hidden');
});

copyEmbedBtn?.addEventListener('click', async () => {
  if (!activeGame || !copyEmbedBtn) return;
  try {
    await navigator.clipboard.writeText(activeGame.iframe);
    const prev = copyEmbedBtn.textContent;
    copyEmbedBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyEmbedBtn.textContent = prev || 'Copy HTML';
    }, 1500);
  } catch (_) {}
});

fullscreenBtn?.addEventListener('click', () => {
  enterFullscreen();
});

exitTheaterBtn?.addEventListener('click', () => {
  exitTheaterFullscreen();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && iframeStage?.classList.contains('theater-fullscreen')) {
    exitTheaterFullscreen();
  }
});

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'VP_GAME_SAVED' && playerSaveStatus) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    playerSaveStatus.textContent = `Progress saved at ${hh}:${mm}`;
  }
});

// Initialize Catalog
fetchGamesCatalog();
