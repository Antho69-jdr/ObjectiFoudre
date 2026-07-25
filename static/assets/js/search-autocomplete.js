let autocompleteController = null;
let autocompleteItems = [];
let autocompleteActiveIndex = -1;
let autocompleteDebounceTimer = null;

// Recherche par COORDONNÉES : "45.77, 2.96", "45.77 2.96", "45.77N 2.96E",
// "N45.77 E2.96", "2.96E 45.77N"… Renvoie {lat, lon, label} ou null.
// Décimal (virgule ou point), cardinaux optionnels ; sans cardinal, ordre lat,lon
// avec heuristique de bascule si l'ordre semble inversé pour la France.
function parseCoordinates(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const re = /^\s*([nsew]?)\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([nsew]?)\s*(?:\s*[,;/]\s*|\s+)\s*([nsew]?)\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([nsew]?)\s*$/i;
  const m = s.match(re);
  if (!m) return null;
  const g1 = { card: (m[1] || m[3] || '').toUpperCase(), val: parseFloat(m[2].replace(',', '.')) };
  const g2 = { card: (m[4] || m[6] || '').toUpperCase(), val: parseFloat(m[5].replace(',', '.')) };
  if (!Number.isFinite(g1.val) || !Number.isFinite(g2.val)) return null;
  const signed = (g) => (g.card === 'S' || g.card === 'W') ? -Math.abs(g.val)
    : (g.card === 'N' || g.card === 'E') ? Math.abs(g.val) : g.val;
  const isLat = (c) => c === 'N' || c === 'S';
  const isLon = (c) => c === 'E' || c === 'W';
  let lat, lon;
  if (isLat(g1.card) || isLon(g2.card)) { lat = signed(g1); lon = signed(g2); }
  else if (isLat(g2.card) || isLon(g1.card)) { lat = signed(g2); lon = signed(g1); }
  else {
    lat = g1.val; lon = g2.val;
    const frLat = (v) => v >= 41 && v <= 52, frLon = (v) => v >= -6 && v <= 10;
    if (!frLat(lat) && frLon(lat) && frLat(lon)) { const t = lat; lat = lon; lon = t; }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

function getAutocompleteContainer() {
  return document.getElementById('searchAutocomplete');
}

function closeSearchAutocomplete() {
  const container = getAutocompleteContainer();
  if (!container) return;
  if (autocompleteDebounceTimer) {
    clearTimeout(autocompleteDebounceTimer);
    autocompleteDebounceTimer = null;
  }
  container.hidden = true;
  container.innerHTML = '';
  autocompleteItems = [];
  autocompleteActiveIndex = -1;
}

function renderSearchAutocomplete(items) {
  const container = getAutocompleteContainer();
  if (!container) return;
  autocompleteItems = Array.isArray(items) ? items.slice(0, 6) : [];
  autocompleteActiveIndex = -1;
  if (!autocompleteItems.length) {
    closeSearchAutocomplete();
    return;
  }

  container.innerHTML = '';
  autocompleteItems.forEach((item, index) => {
    const secondary = [item.city, item.postcode, item.context].filter(Boolean).join(' · ');
    const button = document.createElement('button');
    button.className = 'search-autocomplete-item';
    button.type = 'button';
    button.dataset.index = String(index);
    button.setAttribute('aria-label', item.label);

    const primary = document.createElement('span');
    primary.className = 'search-autocomplete-primary';
    primary.textContent = item.label;
    button.appendChild(primary);

    if (secondary) {
      const secondaryEl = document.createElement('span');
      secondaryEl.className = 'search-autocomplete-secondary';
      secondaryEl.textContent = secondary;
      button.appendChild(secondaryEl);
    }

    button.addEventListener('click', async () => {
      const index = Number(button.dataset.index);
      const item = autocompleteItems[index];
      if (!item) return;
      cityInput.value = item.label;
      closeSearchAutocomplete();
      await applyCenter({
        lat: item.lat,
        lon: item.lon,
        label: item.label,
      }, {
        force: true,
        zoom: 9.8,
        showMarker: true,
      });
    });
    container.appendChild(button);
  });

  container.hidden = false;
}

function syncSearchAutocompleteActiveItem() {
  const container = getAutocompleteContainer();
  if (!container) return;
  container.querySelectorAll('.search-autocomplete-item').forEach((button, index) => {
    button.classList.toggle('active', index === autocompleteActiveIndex);
  });
}

async function fetchAddressAutocomplete(query, signal) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&autocomplete=1&limit=6&type=municipality`; 
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Autocomplete HTTP ${response.status}`);
  const data = await response.json();
  const features = Array.isArray(data?.features) ? data.features : [];
  return features
    .map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates || [];
      return {
        label: props.label || props.name || '',
        city: props.city || props.name || '',
        postcode: props.postcode || '',
        context: props.context || '',
        lat: Number(coords[1]),
        lon: Number(coords[0]),
      };
    })
    .filter((item) => item.label && Number.isFinite(item.lat) && Number.isFinite(item.lon));
}

function setupSearchAutocomplete() {
  const container = getAutocompleteContainer();
  if (!cityInput || !container) return;

  cityInput.addEventListener('input', () => {
    const query = cityInput.value.trim();
    container.hidden = query.length < 2;
    if (autocompleteDebounceTimer) clearTimeout(autocompleteDebounceTimer);
    if (autocompleteController) autocompleteController.abort();
    if (query.length < 2) {
      closeSearchAutocomplete();
      return;
    }
    const coord = parseCoordinates(query);
    if (coord) {
      renderSearchAutocomplete([{ label: coord.label, context: 'Aller à ces coordonnées', lat: coord.lat, lon: coord.lon }]);
      return;
    }
    autocompleteDebounceTimer = setTimeout(async () => {
      autocompleteController = new AbortController();
      try {
        const items = await fetchAddressAutocomplete(query, autocompleteController.signal);
        if (cityInput.value.trim() !== query) return;
        renderSearchAutocomplete(items);
      } catch (error) {
        if (error?.name !== 'AbortError') closeSearchAutocomplete();
      } finally {
        autocompleteController = null;
      }
    }, 180);
  });

  cityInput.addEventListener('keydown', async (event) => {
    if (!autocompleteItems.length || getAutocompleteContainer()?.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      autocompleteActiveIndex = Math.min(autocompleteActiveIndex + 1, autocompleteItems.length - 1);
      syncSearchAutocompleteActiveItem();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      autocompleteActiveIndex = Math.max(autocompleteActiveIndex - 1, 0);
      syncSearchAutocompleteActiveItem();
      return;
    }
    if (event.key === 'Escape') {
      closeSearchAutocomplete();
      return;
    }
    if (event.key === 'Enter' && autocompleteActiveIndex >= 0) {
      event.preventDefault();
      const item = autocompleteItems[autocompleteActiveIndex];
      if (!item) return;
      cityInput.value = item.label;
      closeSearchAutocomplete();
      await applyCenter({ lat: item.lat, lon: item.lon, label: item.label }, { force: true, zoom: 9.8, showMarker: true });
    }
  });

  cityInput.addEventListener('focus', () => {
    if (cityInput.value.trim().length < 2) closeSearchAutocomplete();
  });

  document.addEventListener('click', (event) => {
    if (event.target === cityInput || container.contains(event.target)) return;
    closeSearchAutocomplete();
  });
}
