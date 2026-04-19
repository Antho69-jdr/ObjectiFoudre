let autocompleteController = null;
let autocompleteItems = [];
let autocompleteActiveIndex = -1;
let autocompleteDebounceTimer = null;

function getAutocompleteContainer() {
  return document.getElementById('searchAutocomplete');
}

function closeSearchAutocomplete() {
  const container = getAutocompleteContainer();
  if (!container) return;
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

  container.innerHTML = autocompleteItems.map((item, index) => {
    const secondary = [item.city, item.postcode, item.context].filter(Boolean).join(' · ');
    return `
      <button class="search-autocomplete-item" type="button" data-index="${index}" aria-label="${item.label}">
        <span class="search-autocomplete-primary">${item.label}</span>
        ${secondary ? `<span class="search-autocomplete-secondary">${secondary}</span>` : ''}
      </button>
    `;
  }).join('');

  container.hidden = false;

  container.querySelectorAll('.search-autocomplete-item').forEach((button) => {
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
  });
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
    if (autocompleteDebounceTimer) clearTimeout(autocompleteDebounceTimer);
    if (autocompleteController) autocompleteController.abort();
    if (query.length < 2) {
      closeSearchAutocomplete();
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

  document.addEventListener('click', (event) => {
    if (event.target === cityInput || container.contains(event.target)) return;
    closeSearchAutocomplete();
  });
}
