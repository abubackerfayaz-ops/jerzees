// JRZEES Football Kits - Premium Client Application
document.addEventListener('DOMContentLoaded', () => {
  // Application State
  const state = {
    currentPage: 'home',
    teamId: null,
    jerseyId: null,
    cart: JSON.parse(localStorage.getItem('cart')) || [],
    teams: [],
    jerseys: [],
    historyStack: ['home'],
    token: localStorage.getItem('auth_token') || null,
    user: null,
    userOrders: [],
    currency: localStorage.getItem('selected_currency') || 'EUR',
    country: localStorage.getItem('selected_country') || 'Germany',
    exchangeRates: { EUR: 1.0, USD: 1.08, GBP: 0.85, CAD: 1.48, AUD: 1.65, JPY: 165.0, INR: 90.0, AED: 3.97, SAR: 4.05, CHF: 0.96, BRL: 6.0, MXN: 20.0 },
    currencySymbols: { EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', AUD: 'A$', JPY: '¥', INR: '₹', AED: 'AED ', SAR: 'SAR ', CHF: 'CHF ', BRL: 'R$', MXN: 'MEX$' },
    activeCategory: 'all'
  };

  const COUNTRY_MAP = {
    'DE': { name: 'Germany', currency: 'EUR' },
    'FR': { name: 'France', currency: 'EUR' },
    'ES': { name: 'Spain', currency: 'EUR' },
    'IT': { name: 'Italy', currency: 'EUR' },
    'GB': { name: 'United Kingdom', currency: 'GBP' },
    'US': { name: 'United States', currency: 'USD' },
    'CA': { name: 'Canada', currency: 'CAD' },
    'AU': { name: 'Australia', currency: 'AUD' },
    'JP': { name: 'Japan', currency: 'JPY' },
    'IN': { name: 'India', currency: 'INR' },
    'AE': { name: 'United Arab Emirates', currency: 'AED' },
    'SA': { name: 'Saudi Arabia', currency: 'SAR' }
  };

  function formatPrice(amountInEUR) {
    const rate = state.exchangeRates[state.currency] || 1.0;
    const symbol = state.currencySymbols[state.currency] || '€';
    const converted = (amountInEUR || 0) * rate;
    if (state.currency === 'JPY') {
      return `${symbol}${Math.round(converted)}`;
    }
    return `${symbol}${converted.toFixed(2)}`;
  }

  // Pricing constants matching backend config
  const FEES = {
    delivery: 5,
    namePrinting: 5
  };

  // Auth helpers
  function getAuthHeaders() {
    return state.token ? { 'Authorization': 'Bearer ' + state.token } : {};
  }

  async function apiPost(url, data, useAuth = true) {
    const method = typeof useAuth === 'string' ? useAuth : 'POST';
    const auth = typeof useAuth === 'string' ? true : useAuth;
    const headers = { 'Content-Type': 'application/json', ...(auth ? getAuthHeaders() : {}) };
    const opts = { method, headers };
    if (method !== 'GET' && method !== 'DELETE') opts.body = JSON.stringify(data);
    try {
      const res = await fetch(url, opts);
      return res.json();
    } catch (e) {
      return { error: 'Network error - ' + e.message };
    }
  }

  async function apiGet(url, useAuth = true) {
    const headers = useAuth ? getAuthHeaders() : {};
    try {
      const res = await fetch(url, { headers });
      return res.json();
    } catch (e) {
      return { error: 'Network error - ' + e.message };
    }
  }

  async function checkAuth() {
    if (!state.token) return;
    try {
      const data = await apiGet('/api/auth/me');
      if (data && data.user) {
        state.user = data.user;
        state.userOrders = data.orders || [];
        updateAuthUI();
        return;
      }
    } catch (_) {}
    state.token = null;
    localStorage.removeItem('auth_token');
    updateAuthUI();
  }

  function updateAuthUI() {
    const accountIcon = document.getElementById('nav-account');
    if (!accountIcon) return;
    if (state.user) {
      accountIcon.classList.add('logged-in');
      accountIcon.title = state.user.name;
    } else {
      accountIcon.classList.remove('logged-in');
      accountIcon.title = 'Account';
    }
    const adminLink = document.getElementById('nav-admin-link');
    if (adminLink) {
      adminLink.style.display = state.user && state.user.is_admin ? '' : 'none';
    }
  }

  // Auth Modal
  function openAuthModal(form = 'login') {
    document.getElementById('auth-login-form').style.display = form === 'login' ? 'block' : 'none';
    document.getElementById('auth-register-form').style.display = form === 'register' ? 'block' : 'none';
    document.getElementById('auth-modal').classList.add('active');
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
  }

  function closeAuthModal() {
    document.getElementById('auth-modal').classList.remove('active');
  }

  async function handleLogin(email, password) {
    if (!email.trim() || !password) {
      document.getElementById('login-error').textContent = 'Email and password are required';
      return false;
    }
    const data = await apiPost('/api/auth/login', { email, password }, false);
    if (data.error) { document.getElementById('login-error').textContent = data.error; return false; }
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('auth_token', data.token);
    closeAuthModal();
    updateAuthUI();
    syncCartToServer();
    return true;
  }

  async function handleRegister(name, email, password) {
    if (!name.trim() || !email.trim() || !password) {
      document.getElementById('register-error').textContent = 'All fields are required';
      return false;
    }
    const data = await apiPost('/api/auth/register', { name, email, password }, false);
    if (data.error) { document.getElementById('register-error').textContent = data.error; return false; }
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('auth_token', data.token);
    closeAuthModal();
    updateAuthUI();
    syncCartToServer();
    return true;
  }

  function handleLogout() {
    state.token = null;
    state.user = null;
    state.userOrders = [];
    localStorage.removeItem('auth_token');
    updateAuthUI();
    document.getElementById('user-dropdown').style.display = 'none';
  }

  async function syncCartToServer() {
    if (!state.token || !state.cart.length) return;
    try {
      await fetch('/api/cart/clear', { method: 'POST', headers: getAuthHeaders() });
      const jerseysRes = await fetch('/api/jerseys');
      const allJerseys = await jerseysRes.json();
      for (const item of state.cart) {
        const jersey = allJerseys.find(j => j.id == item.jersey_id);
        if (!jersey) continue;
        const variantRes = await fetch(`/api/variants?jersey_id=${item.jersey_id}&version=${item.version}&size=${item.size}`);
        const variants = await variantRes.json();
        if (variants.length) {
          await fetch('/api/cart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ variant_id: variants[0].id, name_text: item.name_text || '', quantity: item.quantity })
          });
        }
      }
    } catch (_) { /* silent sync */ }
  }

  // Search
  function openSearch() {
    document.getElementById('search-overlay').classList.add('active');
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '';
    setTimeout(() => document.getElementById('search-input').focus(), 100);
  }

  function closeSearch() {
    document.getElementById('search-overlay').classList.remove('active');
  }

  // SVGs and Styling for Jersey Placeholders based on team color signatures
  const teamStyles = {
    'manchester-united': { bg: '#da291c', accent: '#ffffff', secondary: '#000000', pattern: 'stripes-vertical-subtle' },
    'liverpool': { bg: '#c8102e', accent: '#f6eb61', secondary: '#ffffff', pattern: 'solid' },
    'arsenal': { bg: '#ef0107', accent: '#ffffff', secondary: '#063672', pattern: 'arsenal-sleeves' },
    'chelsea': { bg: '#034694', accent: '#ffffff', secondary: '#ee242c', pattern: 'solid' },
    'manchester-city': { bg: '#6cabdd', accent: '#ffffff', secondary: '#1c2c5b', pattern: 'solid' },
    'tottenham': { bg: '#ffffff', accent: '#132257', secondary: '#132257', pattern: 'solid' },
    'real-madrid': { bg: '#ffffff', accent: '#e5c158', secondary: '#00529f', pattern: 'solid' },
    'barcelona': { bg: '#004d98', accent: '#a50044', secondary: '#edbb00', pattern: 'stripes-vertical' },
    'atletico-madrid': { bg: '#cb3524', accent: '#ffffff', secondary: '#002d72', pattern: 'stripes-vertical' },
    'juventus': { bg: '#ffffff', accent: '#000000', secondary: '#e5c158', pattern: 'stripes-vertical' },
    'ac-milan': { bg: '#e30613', accent: '#000000', secondary: '#ffffff', pattern: 'stripes-vertical' },
    'inter-milan': { bg: '#001a9c', accent: '#000000', secondary: '#cfab2b', pattern: 'stripes-vertical' },
    'roma': { bg: '#8e1c31', accent: '#f1b827', secondary: '#ffffff', pattern: 'solid' },
    'napoli': { bg: '#12a0d9', accent: '#ffffff', secondary: '#0a3a60', pattern: 'solid' },
    'bayern-munich': { bg: '#dc052d', accent: '#ffffff', secondary: '#0066b2', pattern: 'solid' },
    'borussia-dortmund': { bg: '#fde100', accent: '#000000', secondary: '#000000', pattern: 'solid' },
    'psg': { bg: '#002c5f', accent: '#da291c', secondary: '#ffffff', pattern: 'psg-stripe' },
    'brazil': { bg: '#fedf00', accent: '#009b3a', secondary: '#002776', pattern: 'solid' },
    'argentina': { bg: '#75aadb', accent: '#ffffff', secondary: '#e5c158', pattern: 'stripes-vertical' },
    'germany': { bg: '#ffffff', accent: '#000000', secondary: '#d91c1c', pattern: 'germany-flag' },
    'netherlands': { bg: '#f36c21', accent: '#ffffff', secondary: '#212354', pattern: 'solid' },
    'france': { bg: '#072b83', accent: '#ffffff', secondary: '#e1001a', pattern: 'solid' },
    'italy': { bg: '#0064aa', accent: '#ffffff', secondary: '#008c45', pattern: 'solid' },
    'england': { bg: '#ffffff', accent: '#0f2042', secondary: '#da291c', pattern: 'solid' },
    'portugal': { bg: '#da291c', accent: '#046a38', secondary: '#fede00', pattern: 'solid' },
    'spain': { bg: '#c8102e', accent: '#fed100', secondary: '#002060', pattern: 'solid' },
    'croatia': { bg: '#ffffff', accent: '#ff0000', secondary: '#002060', pattern: 'checkers' },
    'nigeria': { bg: '#008751', accent: '#ffffff', secondary: '#008751', pattern: 'stripes-vertical' }
  };

  const defaultStyle = { bg: '#1e2330', accent: '#e5c158', secondary: '#ffffff', pattern: 'solid' };

  // Helper to generate elegant visual SVG representation of jerseys
  function getJerseySvg(teamSlug, sizeClass = 'jersey-placeholder-svg') {
    const style = teamStyles[teamSlug] || defaultStyle;
    
    let patternSvg = '';
    if (style.pattern === 'stripes-vertical') {
      patternSvg = `
        <rect x="25" y="10" width="8" height="80" fill="${style.accent}" />
        <rect x="41" y="10" width="8" height="80" fill="${style.accent}" />
        <rect x="57" y="10" width="8" height="80" fill="${style.accent}" />
        <rect x="73" y="10" width="8" height="80" fill="${style.accent}" />
      `;
    } else if (style.pattern === 'stripes-vertical-subtle') {
      patternSvg = `
        <rect x="28" y="10" width="5" height="80" fill="${style.secondary}" opacity="0.3"/>
        <rect x="44" y="10" width="5" height="80" fill="${style.secondary}" opacity="0.3"/>
        <rect x="60" y="10" width="5" height="80" fill="${style.secondary}" opacity="0.3"/>
      `;
    } else if (style.pattern === 'checkers') {
      patternSvg = `
        <rect x="20" y="10" width="12" height="12" fill="${style.accent}" />
        <rect x="44" y="10" width="12" height="12" fill="${style.accent}" />
        <rect x="68" y="10" width="12" height="12" fill="${style.accent}" />
        <rect x="32" y="22" width="12" height="12" fill="${style.accent}" />
        <rect x="56" y="22" width="12" height="12" fill="${style.accent}" />
        <rect x="20" y="34" width="12" height="12" fill="${style.accent}" />
        <rect x="44" y="34" width="12" height="12" fill="${style.accent}" />
        <rect x="68" y="34" width="12" height="12" fill="${style.accent}" />
        <rect x="32" y="46" width="12" height="12" fill="${style.accent}" />
        <rect x="56" y="46" width="12" height="12" fill="${style.accent}" />
      `;
    } else if (style.pattern === 'arsenal-sleeves') {
      patternSvg = `
        <!-- Styled in base SVG sleeves -->
      `;
    } else if (style.pattern === 'psg-stripe') {
      patternSvg = `
        <rect x="42" y="10" width="16" height="80" fill="${style.accent}" />
        <rect x="47" y="10" width="6" height="80" fill="${style.secondary}" />
      `;
    } else if (style.pattern === 'germany-flag') {
      patternSvg = `
        <rect x="20" y="30" width="60" height="6" fill="#000000" />
        <rect x="20" y="36" width="60" height="6" fill="#ff0000" />
        <rect x="20" y="42" width="60" height="6" fill="#ffcc00" />
      `;
    }

    const sleeveFill = style.pattern === 'arsenal-sleeves' ? '#ffffff' : style.bg;

    return `
      <svg class="${sizeClass} jersey-placeholder-jersey" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <clipPath id="jersey-clip">
            <path d="M 20 10 L 35 10 L 40 18 L 45 18 L 50 18 L 55 18 L 60 18 L 65 10 L 80 10 L 88 28 L 76 34 L 76 90 L 24 90 L 24 34 L 12 28 Z" />
          </clipPath>
        </defs>
        <!-- Sleeves & Shoulder structure -->
        <path d="M 20 10 L 12 28 L 24 34 Z" fill="${sleeveFill}" stroke="${style.secondary}" stroke-width="1" />
        <path d="M 80 10 L 88 28 L 76 34 Z" fill="${sleeveFill}" stroke="${style.secondary}" stroke-width="1" />
        
        <!-- Main body with clipping for custom patterns -->
        <g clip-path="url(#jersey-clip)">
          <rect x="10" y="0" width="80" height="100" fill="${style.bg}" />
          ${patternSvg}
          <!-- Collar trim -->
          <path d="M 38 10 C 44 22, 56 22, 62 10" fill="none" stroke="${style.accent}" stroke-width="3" />
        </g>
        
        <!-- Outer Outline -->
        <path d="M 20 10 L 35 10 L 40 18 L 45 18 L 50 18 L 55 18 L 60 18 L 65 10 L 80 10 L 88 28 L 76 34 L 76 90 L 24 90 L 24 34 L 12 28 Z" 
              fill="none" stroke="${style.accent}" stroke-width="1.5" />
      </svg>
    `;
  }

  // Route external image URLs through our server proxy to avoid hotlink blocks
  function proxyImg(url) {
    if (!url) return '';
    // Already a relative or local URL — serve directly
    if (url.startsWith('/') || url.startsWith('data:')) return url;
    return '/api/img-proxy?url=' + encodeURIComponent(url);
  }

  // Generate Image Wrapper — pre-renders both img + SVG fallback.
  // On img load error just adds 'img-error' class; no complex inline string needed.
  function renderJerseyMedia(jersey, wrapperClass = 'jersey-card-image-wrapper', sizeClass = 'jersey-placeholder-svg') {
    const svgFallback = `
      <div class="jersey-placeholder-container img-fallback">
        ${getJerseySvg(jersey.team_slug, sizeClass)}
      </div>`;

    if (!jersey.image_url) {
      return `<div class="${wrapperClass}">${svgFallback}</div>`;
    }

    return `
      <div class="${wrapperClass}">
        <img
          src="${proxyImg(jersey.image_url)}"
          alt="${jersey.name}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
        >
        <div class="jersey-placeholder-container img-fallback" style="display:none;">
          ${getJerseySvg(jersey.team_slug, sizeClass)}
        </div>
      </div>`;
  }


  // Navigation & Routing System
  const navLinks = document.querySelectorAll('nav a, .logo, .btn-browse, .section-link, #nav-cart-btn');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const page = link.getAttribute('data-page') || 'home';
      const filter = link.getAttribute('data-filter') || null;
      navigateTo(page, { filter });
    });
  });

  function navigateTo(page, params = {}) {
    state.currentPage = page;
    
    // Manage active state in headers
    document.querySelectorAll('nav a').forEach(a => {
      if (a.getAttribute('data-page') === page && (!params.filter || a.getAttribute('data-filter') === params.filter)) {
        a.classList.add('active');
      } else {
        a.classList.remove('active');
      }
    });

    // Hide all pages
    document.querySelectorAll('main > div').forEach(div => {
      div.style.display = 'none';
    });

    // Show correct page
    const pageId = `page-${page}`;
    const pageEl = document.getElementById(pageId);
    if (pageEl) {
      pageEl.style.display = 'block';
      window.scrollTo(0, 0);
    }

    // Custom Page Loading Initializers
    if (page === 'home') {
      loadFeaturedJerseys();
    } else if (page === 'catalog') {
      loadCatalogJerseys(params.filter || 'all');
    } else if (page === 'teams') {
      loadTeams();
    } else if (page === 'team') {
      state.teamId = params.teamId;
      loadTeamJerseys(params.teamId);
    } else if (page === 'detail') {
      state.jerseyId = params.jerseyId;
      loadJerseyDetail(params.jerseyId);
    } else if (page === 'cart') {
      renderCart();
    } else if (page === 'checkout') {
      renderCheckoutSummary();
    } else if (page === 'profile') {
      renderProfilePage();
    } else if (page === 'admin') {
      renderAdminPage();
    }

    updateCartCount();
  }

  // Load Catalog Jerseys with Category Filters
  async function loadCatalogJerseys(filter) {
    const container = document.getElementById('catalog-jerseys');
    const titleEl = document.getElementById('catalog-title');
    if (!container) return;
    container.innerHTML = '<div class="cart-empty"><p>Loading kits...</p></div>';

    const category = filter || state.activeCategory || 'all';
    state.activeCategory = category;

    let endpoint = `/api/jerseys?category=${encodeURIComponent(category)}`;
    if (category === 'all') {
      titleEl.innerHTML = 'Shop <span>All Kits</span>';
    } else if (category === 'retro') {
      titleEl.innerHTML = 'Classic <span>Retro</span>';
    } else {
      const catCapitalized = category.charAt(0).toUpperCase() + category.slice(1);
      titleEl.innerHTML = `${catCapitalized} <span>Kits</span>`;
    }

    let jerseys = await apiFetch(endpoint);
    if (!Array.isArray(jerseys)) jerseys = [];

    if (!jerseys.length) {
      container.innerHTML = '<div class="cart-empty"><p>No jerseys found matching this category.</p></div>';
      return;
    }

    container.innerHTML = jerseys.map(jersey => `
      <div class="jersey-card" data-id="${jersey.id}">
        <!-- Laser Scanner -->
        <div class="card-scanner-glow"></div>
        ${renderJerseyMedia(jersey)}
        <div class="info">
          <h4>${jersey.name}</h4>
          <span class="team-label">${jersey.team_name}</span>
          <div class="card-footer">
            <span class="price">${formatPrice(20)} - ${formatPrice(25)}</span>
            <span class="view-details-btn">View Options</span>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.jersey-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        navigateTo('detail', { jerseyId: id });
      });
    });
  }

  // Load Featured Jerseys on Homepage
  async function loadFeaturedJerseys() {
    const container = document.getElementById('featured-jerseys');
    if (!container) return;
    container.innerHTML = '<div class="cart-empty"><p>Loading exclusive products...</p></div>';
    
    const data = await apiFetch('/api/jerseys?featured=1');
    const jerseys = Array.isArray(data) ? data : [];
    if (!jerseys.length) {
      container.innerHTML = '<div class="cart-empty"><p>No featured jerseys found.</p></div>';
      return;
    }

    container.innerHTML = jerseys.map(jersey => `
      <div class="jersey-card" data-id="${jersey.id}">
        <!-- Laser Scanner -->
        <div class="card-scanner-glow"></div>
        
        ${renderJerseyMedia(jersey)}
        <div class="info">
          <h4>${jersey.name}</h4>
          <span class="team-label">${jersey.team_name}</span>
          <div class="card-footer">
            <span class="price">${formatPrice(20)} - ${formatPrice(25)}</span>
            <span class="view-details-btn">View Options</span>
          </div>
        </div>
      </div>
    `).join('');

    // Attach card event listeners
    container.querySelectorAll('.jersey-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        navigateTo('detail', { jerseyId: id });
      });
    });
  }

  // Load All Teams List
  async function loadTeams() {
    const container = document.getElementById('teams-list');
    container.innerHTML = '<div class="cart-empty"><p>Loading teams...</p></div>';

    const data = await apiFetch('/api/teams');
    const teams = Array.isArray(data) ? data : [];
    if (!teams.length) {
      container.innerHTML = '<div class="cart-empty"><p>No teams available.</p></div>';
      return;
    }

    container.innerHTML = teams.map(team => `
      <div class="team-card" data-id="${team.id}">
        <h3>${team.name}</h3>
        <p>${team.country || 'International'}</p>
      </div>
    `).join('');

    container.querySelectorAll('.team-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        navigateTo('team', { teamId: id });
      });
    });
  }

  // Load Jerseys Filtered by Team
  async function loadTeamJerseys(teamId) {
    const container = document.getElementById('team-jerseys');
    const headerTitle = document.getElementById('team-name');
    container.innerHTML = '<div class="cart-empty"><p>Loading team collection...</p></div>';

    const data = await apiFetch(`/api/jerseys?team_id=${teamId}`);
    const jerseys = Array.isArray(data) ? data : [];
    
    if (!jerseys.length) {
      headerTitle.textContent = 'Collection';
      container.innerHTML = '<div class="cart-empty"><p>No jerseys available for this team yet.</p></div>';
      return;
    }

    headerTitle.textContent = `${jerseys[0].team_name} Collection`;

    container.innerHTML = jerseys.map(jersey => `
      <div class="jersey-card" data-id="${jersey.id}">
        <!-- Laser Scanner -->
        <div class="card-scanner-glow"></div>
        
        ${renderJerseyMedia(jersey)}
        <div class="info">
          <h4>${jersey.name}</h4>
          <span class="team-label">${jersey.team_name}</span>
          <div class="card-footer">
            <span class="price">$${(jersey.version_fan || 20).toFixed(2)} - $${(jersey.version_retro || 25).toFixed(2)}</span>
            <span class="view-details-btn">View Options</span>
          </div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.jersey-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        navigateTo('detail', { jerseyId: id });
      });
    });
  }

  // Load Single Jersey Detail Panel
  async function loadJerseyDetail(jerseyId) {
    const container = document.getElementById('jersey-detail');
    container.innerHTML = '<div class="cart-empty"><p>Loading details...</p></div>';

    const jersey = await apiFetch(`/api/jerseys/${jerseyId}`);
    if (!jersey || typeof jersey !== 'object' || Array.isArray(jersey) || jersey.error) {
      container.innerHTML = '<div class="cart-empty"><p>Jersey not found.</p></div>';
      return;
    }

    // Set interactive variables
    const isRetro = jersey.type === 'retro' || (jersey.name && jersey.name.toLowerCase().includes('retro'));
    let selectedVersion = isRetro ? 'retro' : 'fan';
    let selectedSize = 'M';
    let printNameText = '';

    const priceTiers = {
      fan: 20,
      player: 25,
      retro: 25
    };

    function getCombinedPrice() {
      const base = priceTiers[selectedVersion];
      const printing = printNameText.trim().length > 0 ? FEES.namePrinting : 0;
      return base + printing;
    }

    function renderDetailContent() {
      const isPlaceholder = !jersey.image_url;
      const svgFallback = `<div class="jersey-placeholder-container img-fallback" style="width:100%;height:100%;${isPlaceholder ? '' : 'display:none;'}">${getJerseySvg(jersey.team_slug, 'jersey-placeholder-svg')}</div>`;
      const imgHtml = isPlaceholder
        ? ''
        : `<img id="detail-main-img" src="${proxyImg(jersey.image_url)}" alt="${jersey.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">` ;

      container.innerHTML = `
        <div class="detail-image" id="detail-zoom-trigger">
          ${imgHtml}${svgFallback}
          <div class="zoom-overlay">
            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 15l6 6m-11-4a7 7 0 110-14 7 7 0 010 14z"></path></svg>
            Click to Expand
          </div>
        </div>
        <div class="detail-info">
          <h2>${jersey.name}</h2>
          <span class="team-label">${jersey.team_name}</span>
          
          <div class="version-selector">
            <h4 class="selector-title">Select Fit Version</h4>
            <div class="version-options">
              ${isRetro ? `
              <div class="version-option active" data-version="retro">
                <h5>Retro Fit</h5>
                <span>${formatPrice(priceTiers.retro)}</span>
              </div>
              ` : `
              <div class="version-option ${selectedVersion === 'fan' ? 'active' : ''}" data-version="fan">
                <h5>Fan Fit</h5>
                <span>${formatPrice(priceTiers.fan)}</span>
              </div>
              <div class="version-option ${selectedVersion === 'player' ? 'active' : ''}" data-version="player">
                <h5>Player Fit</h5>
                <span>${formatPrice(priceTiers.player)}</span>
              </div>
              `}
            </div>
          </div>

          <div class="size-selector">
            <h4 class="selector-title">Select Sizing</h4>
            <div class="size-options">
              ${['S', 'M', 'L', 'XL', '2XL'].map(s => `
                <div class="size-option ${selectedSize === s ? 'active' : ''}" data-size="${s}">${s}</div>
              `).join('')}
            </div>
          </div>

          <div class="name-printing">
            <div class="name-printing-header">
              <h4 class="selector-title" style="margin-bottom:0;">Custom Name Printing (At Back)</h4>
              <span class="name-printing-price">+${formatPrice(FEES.namePrinting)}</span>
            </div>
            <input type="text" id="name-print-input" placeholder="e.g. CR7, MESSI, RONALDINHO" maxlength="15" value="${printNameText}">
            <p class="fee-note">Add custom name & number. Real-time updates automatically.</p>
          </div>

          <div class="detail-price-box">
            <span class="label">Total Price:</span>
            <span class="detail-price" id="detail-total-price">${formatPrice(getCombinedPrice())}</span>
          </div>

          <button class="btn btn-primary btn-block" id="add-to-cart-btn">Add to Cart Bag</button>
        </div>
      `;

      // Set zoom event listener
      document.getElementById('detail-zoom-trigger').addEventListener('click', () => {
        openZoomModal(jersey);
      });

      // Version toggle listeners
      container.querySelectorAll('.version-option').forEach(opt => {
        opt.addEventListener('click', () => {
          selectedVersion = opt.getAttribute('data-version');
          container.querySelectorAll('.version-option').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          updatePriceDisplay();
        });
      });

      // Size toggle listeners
      container.querySelectorAll('.size-option').forEach(opt => {
        opt.addEventListener('click', () => {
          selectedSize = opt.getAttribute('data-size');
          container.querySelectorAll('.size-option').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
        });
      });

      // Live Name printing text listener
      const nameInput = document.getElementById('name-print-input');
      nameInput.addEventListener('input', (e) => {
        printNameText = e.target.value.toUpperCase();
        updatePriceDisplay();
      });

      // Add to Cart Bag action listener
      document.getElementById('add-to-cart-btn').addEventListener('click', () => {
        addToCart(jersey, selectedVersion, selectedSize, printNameText, priceTiers[selectedVersion]);
      });
    }

    function updatePriceDisplay() {
      const priceText = document.getElementById('detail-total-price');
      if (priceText) {
        priceText.textContent = formatPrice(getCombinedPrice());
      }
    }

    renderDetailContent();
  }

  // Zoom Modal Handler
  function openZoomModal(jersey) {
    const modal = document.getElementById('image-modal');
    const modalImg = document.getElementById('modal-image');
    
    // Clear and swap
    modal.classList.add('active');
    
    const isPlaceholder = !jersey.image_url;
    const modalSvg = `<div style="width:75%;height:75%;display:flex;align-items:center;justify-content:center;${isPlaceholder ? '' : 'display:none;'}">${getJerseySvg(jersey.team_slug, 'jersey-placeholder-svg')}</div>`;
    const modalImgHtml = isPlaceholder
      ? ''
      : `<img id="modal-image" src="${proxyImg(jersey.image_url)}" alt="${jersey.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">`;
    modal.innerHTML = `
      <span class="modal-close" id="modal-close-btn">&times;</span>
      ${modalImgHtml}${modalSvg}
    `;

    // Attach close button
    const closeBtn = document.getElementById('modal-close-btn') || modal;
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
    modal.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  // Cart operations
  function addToCart(jersey, version, size, nameText, basePrice) {
    const existingIndex = state.cart.findIndex(item => 
      item.jersey_id === jersey.id && 
      item.version === version && 
      item.size === size && 
      item.name_text === nameText
    );

    if (existingIndex > -1) {
      state.cart[existingIndex].quantity += 1;
    } else {
      state.cart.push({
        jersey_id: jersey.id,
        name: jersey.name,
        team_name: jersey.team_name,
        team_slug: jersey.team_slug,
        image_url: jersey.image_url,
        version: version,
        size: size,
        name_text: nameText.trim() || null,
        price: basePrice,
        quantity: 1
      });
    }

    saveCart();
    updateCartCount();
    
    // Visual Notification
    const btn = document.getElementById('add-to-cart-btn');
    const oldText = btn.textContent;
    btn.textContent = 'ADDED TO BAG!';
    btn.style.background = '#10b981';
    btn.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.4)';
    setTimeout(() => {
      btn.textContent = oldText;
      btn.style.background = '';
      btn.style.boxShadow = '';
      navigateTo('cart');
    }, 800);
  }

  function saveCart() {
    localStorage.setItem('cart', JSON.stringify(state.cart));
  }

  function updateCartCount() {
    const totalQty = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    document.getElementById('cart-count').textContent = totalQty;
  }

  // Render Shopping Cart Elements
  function renderCart() {
    const container = document.getElementById('cart-items');
    const summary = document.getElementById('cart-summary');

    if (!state.cart.length) {
      container.innerHTML = `
        <div class="cart-empty">
          <svg class="cart-empty-svg" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007zM8.625 10.5a.375.375 0 11-.75 0 .375.375 0 01.75 0zm7.5 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
          <p>Your shopping cart bag is empty.</p>
          <button class="btn btn-outline-gold" style="margin-top:20px;" id="cart-start-shopping">Browse Collection</button>
        </div>
      `;
      summary.style.display = 'none';

      document.getElementById('cart-start-shopping')?.addEventListener('click', () => {
        navigateTo('home');
      });
      return;
    }

    summary.style.display = 'block';

    container.innerHTML = state.cart.map((item, idx) => {
      const isPlaceholder = !item.image_url;
      const imgTag = isPlaceholder 
        ? getJerseySvg(item.team_slug, 'jersey-placeholder-svg')
        : `<img src="${proxyImg(item.image_url)}" alt="${item.name}">`;

      const hasCustomPrint = item.name_text && item.name_text.trim();
      const customPrintPrice = hasCustomPrint ? FEES.namePrinting : 0;
      const unitTotalPrice = item.price + customPrintPrice;

      return `
        <div class="cart-item">
          <div class="cart-item-img">
            ${imgTag}
          </div>
          <div class="cart-item-info">
            <h4>${item.name}</h4>
            <p>Fit: <span style="text-transform: uppercase;">${item.version}</span> | Size: ${item.size}</p>
            ${hasCustomPrint ? `<p class="item-customization">Printed Back Name: ${item.name_text} (+${formatPrice(FEES.namePrinting)})</p>` : ''}
          </div>
          <div class="cart-item-price-qty">
            <span class="cart-item-price">${formatPrice(unitTotalPrice * item.quantity)}</span>
            <div class="cart-item-qty">
              <button class="qty-btn" data-action="decrease" data-index="${idx}">-</button>
              <span>${item.quantity}</span>
              <button class="qty-btn" data-action="increase" data-index="${idx}">+</button>
            </div>
            <button class="cart-item-remove" data-index="${idx}">Remove</button>
          </div>
        </div>
      `;
    }).join('');

    // Attach cart controls
    container.querySelectorAll('.qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const index = parseInt(btn.getAttribute('data-index'));
        if (action === 'increase') {
          state.cart[index].quantity += 1;
        } else if (action === 'decrease') {
          if (state.cart[index].quantity > 1) {
            state.cart[index].quantity -= 1;
          } else {
            state.cart.splice(index, 1);
          }
        }
        saveCart();
        renderCart();
        updateCartCount();
      });
    });

    container.querySelectorAll('.cart-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.getAttribute('data-index'));
        state.cart.splice(index, 1);
        saveCart();
        renderCart();
        updateCartCount();
      });
    });

    // Calculate Summary totals
    let itemsSubtotal = 0;
    let namePrintTotal = 0;
    state.cart.forEach(item => {
      itemsSubtotal += item.price * item.quantity;
      if (item.name_text && item.name_text.trim()) {
        namePrintTotal += FEES.namePrinting * item.quantity;
      }
    });

    const deliveryTotal = FEES.delivery;
    const finalTotal = itemsSubtotal + namePrintTotal + deliveryTotal;

    summary.innerHTML = `
      <div class="row">
        <span>Subtotal (Base Jerseys)</span>
        <span>${formatPrice(itemsSubtotal)}</span>
      </div>
      <div class="row">
        <span>Custom Name Printing</span>
        <span>${formatPrice(namePrintTotal)}</span>
      </div>
      <div class="row">
        <span>Delivery Flat Fee</span>
        <span>${formatPrice(deliveryTotal)}</span>
      </div>
      <div class="row total">
        <span>Order Total</span>
        <span>${formatPrice(finalTotal)}</span>
      </div>
      <button class="btn btn-primary btn-block" style="margin-top:24px;" id="proceed-to-checkout-btn">Checkout Securely</button>
    `;

    document.getElementById('proceed-to-checkout-btn').addEventListener('click', () => {
      navigateTo('checkout');
    });
  }

  // Render Checkout Summary sidepanel
  function renderCheckoutSummary() {
    const container = document.getElementById('checkout-summary');
    if (!container) return;

    let itemsSubtotal = 0;
    let namePrintTotal = 0;
    state.cart.forEach(item => {
      itemsSubtotal += item.price * item.quantity;
      if (item.name_text && item.name_text.trim()) {
        namePrintTotal += FEES.namePrinting * item.quantity;
      }
    });

    const deliveryTotal = FEES.delivery;
    const finalTotal = itemsSubtotal + namePrintTotal + deliveryTotal;

    const checkoutCountrySelect = document.getElementById('checkout-country');
    if (checkoutCountrySelect && state.country) {
      checkoutCountrySelect.value = state.country;
    }

    container.innerHTML = `
      <div class="checkout-summary-box" style="background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:16px; padding:24px; box-shadow:var(--card-shadow); margin-bottom:24px;">
        <div style="border-bottom:1px solid var(--border-color); padding-bottom:16px; margin-bottom:16px;">
          ${state.cart.map(item => `
            <div style="display:flex; justify-content:space-between; font-size:0.9rem; margin-bottom:10px;">
              <span style="color:var(--text-primary); font-weight:500;">${item.name} (${item.size}) x${item.quantity}</span>
              <span style="color:var(--accent-gold); font-weight:600;">${formatPrice((item.price + (item.name_text ? FEES.namePrinting : 0)) * item.quantity)}</span>
            </div>
          `).join('')}
        </div>
        <div class="row" style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.9rem; color:var(--text-secondary);">
          <span>Items Subtotal</span>
          <span>${formatPrice(itemsSubtotal)}</span>
        </div>
        <div class="row" style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.9rem; color:var(--text-secondary);">
          <span>Name Printing Fee</span>
          <span>${formatPrice(namePrintTotal)}</span>
        </div>
        <div class="row" style="display:flex; justify-content:space-between; margin-bottom:16px; font-size:0.9rem; color:var(--text-secondary);">
          <span>Flat Delivery Fee</span>
          <span>${formatPrice(deliveryTotal)}</span>
        </div>
        <div class="row total" style="display:flex; justify-content:space-between; font-size:1.25rem; font-weight:700; border-top:1px solid var(--border-color); padding-top:16px; color:var(--text-primary);">
          <span>Final Total</span>
          <span style="color:var(--accent-gold);">${formatPrice(finalTotal)}</span>
        </div>
      </div>
    `;
  }

  // Handle Place Order submit form
  const checkoutForm = document.getElementById('checkout-form');
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = checkoutForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Processing Order...';
    submitBtn.disabled = true;

    const formData = new FormData(checkoutForm);
    const selectedCountry = formData.get('country') || state.country || 'United Kingdom';
    const orderData = {
      customer_name: formData.get('customer_name'),
      email: formData.get('email'),
      phone: formData.get('phone'),
      country: selectedCountry,
      address: formData.get('address'),
      notes: formData.get('notes'),
      currency_symbol: state.currencySymbols[state.currency] || '€',
      items: state.cart.map(item => ({
        jersey_id: item.jersey_id,
        size: item.size,
        version: item.version,
        name_text: item.name_text || '',
        quantity: item.quantity
      }))
    };

    try {
      // Try Stripe Checkout first if configured
      const stripeRes = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      });

      const stripeResult = await stripeRes.json();

      if (stripeRes.ok && stripeResult.url) {
        state.cart = [];
        saveCart();
        updateCartCount();
        checkoutForm.reset();
        window.location.href = stripeResult.url;
        return;
      }

      // Legacy direct order placement
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      });

      const result = await response.json();
      if (!response.ok || result.error) {
        alert(result.error || 'Failed to place order. Please try again.');
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        return;
      }

      state.cart = [];
      saveCart();
      updateCartCount();
      checkoutForm.reset();

      renderOrderConfirmation(result.order_id);
      navigateTo('order-confirmed');
    } catch (err) {
      console.error(err);
      alert('Network error. Failed to connect to server.');
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

  // Render Confirmation Details (accepts order id or Stripe session id)
  async function renderOrderConfirmation(orderId) {
    const container = document.getElementById('order-details');
    container.innerHTML = '<div class="cart-empty"><p>Loading order details...</p></div>';

    const order = await apiFetch(`/api/orders/${encodeURIComponent(orderId)}`);
    if (!order || order.error) {
      container.innerHTML = `<div class="cart-empty"><p>Order #${orderId} details couldn't be loaded.</p></div>`;
      return;
    }

    container.innerHTML = `
      <div class="confirmation-card">
        <svg class="success-icon-svg" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h2>Thank You, ${order.customer_name}!</h2>
        <p>Your order has been received and is currently being processed. An email confirmation has been sent to <strong>${order.email}</strong>.</p>
        
        <div class="confirmation-details">
          <div class="row">
            <span>Order ID</span>
            <span>#${order.id}</span>
          </div>
          <div class="row">
            <span>Status</span>
            <span style="color:var(--accent-gold); text-transform:uppercase;">${order.status}</span>
          </div>
          <div class="row">
            <span>Shipping Address</span>
            <span>${order.address}</span>
          </div>
          <div class="row" style="border-top:1px solid var(--border-color); padding-top:12px; margin-top:12px; font-weight:700;">
            <span>Total Paid</span>
            <span style="color:var(--accent-gold); font-size:1.15rem;">$${order.total.toFixed(2)}</span>
          </div>
        </div>
      </div>
    `;
  }

  // Handle confirmation back routing
  document.querySelector('[data-page="home"]').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('home');
  });

  // ═══════════════════════════════════════════════
  // PREMIUM AESTHETIC SYSTEMS (AWWWARDS-GRADE EXPANSION)
  // ═══════════════════════════════════════════════

  // ── 1. Web Audio Synthesizer Cues (Zero External Assets) ──
  let audioCtx = null;
  let isSoundEnabled = false;

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  // Sound generator helpers
  function playSoundCue(type) {
    if (!isSoundEnabled) return;
    initAudio();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

    if (type === 'tick') {
      // Sub-frequency mechanical click for nav elements
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.05);
      gainNode.gain.setValueAtTime(0.04, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'drop') {
      // Deep bass feedback on adding items to cart
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.exponentialRampToValueAtTime(45, now + 0.4);
      gainNode.gain.setValueAtTime(0.35, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'success') {
      // Chime synthesis for purchase completion
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.setValueAtTime(659.25, now + 0.1); // E5
      osc.frequency.setValueAtTime(783.99, now + 0.2); // G5
      gainNode.gain.setValueAtTime(0.12, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.start(now);
      osc.stop(now + 0.45);
    }
  }

  // Register Sound Toggle Event Listener
  const soundToggle = document.getElementById('audio-toggle-btn');
  if (soundToggle) {
    soundToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      isSoundEnabled = !isSoundEnabled;
      soundToggle.classList.toggle('active', isSoundEnabled);
      if (isSoundEnabled) {
        initAudio();
        playSoundCue('tick');
      }
    });
  }

  // Play ticks on nav interactions
  document.addEventListener('click', (e) => {
    if (e.target.closest('a, button, .nav-icon, .version-option, .size-option')) {
      playSoundCue('tick');
    }
  });

  // ── 2. Particle Canvas System (Stadium Atmosphere) ──
  const canvas = document.getElementById('particles-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    // Particle class
    class Particle {
      constructor() {
        this.reset();
      }
      reset() {
        this.x = Math.random() * width;
        this.y = Math.random() * height;
        this.vx = (Math.random() - 0.5) * 0.25;
        this.vy = (Math.random() - 0.5) * 0.25;
        this.radius = Math.random() * 1.5 + 0.5;
        this.alpha = Math.random() * 0.45 + 0.1;
        this.decay = Math.random() * 0.002 + 0.0005;
      }
      update(mX, mY) {
        this.x += this.vx;
        this.y += this.vy;

        // Mild repelling motion from cursor spotlight
        const dx = this.x - mX;
        const dy = this.y - mY;
        const dist = Math.hypot(dx, dy);
        if (dist < 220) {
          const force = (220 - dist) / 220;
          this.x += (dx / dist) * force * 0.8;
          this.y += (dy / dist) * force * 0.8;
        }

        // Keep inside screen
        if (this.x < 0 || this.x > width || this.y < 0 || this.y > height) {
          this.reset();
        }
      }
      draw() {
        ctx.fillStyle = `rgba(179, 240, 0, ${this.alpha})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const particles = Array.from({ length: 70 }, () => new Particle());
    let mouseX = -9999, mouseY = -9999;

    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    // Particle loop with Constellation Lines
    function loop() {
      ctx.clearRect(0, 0, width, height);
      
      // Draw links first
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < 110) {
            ctx.strokeStyle = `rgba(179, 240, 0, ${(1 - dist/110) * 0.12})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw particle nodes
      for (const p of particles) {
        p.update(mouseX, mouseY);
        p.draw();
      }
      requestAnimationFrame(loop);
    }
    loop();

    // Handle screen resize
    window.addEventListener('resize', () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    });
  }

  // ── 3. Text Scramble Animation (High-Tech Museum Reveal) ──
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%@#$&';
  function scrambleText(element, finalString) {
    let progress = 0;
    const length = finalString.length;
    
    function updateText() {
      let output = '';
      for (let i = 0; i < length; i++) {
        if (i < progress) {
          output += finalString[i];
        } else if (finalString[i] === ' ') {
          output += ' ';
        } else {
          output += chars[Math.floor(Math.random() * chars.length)];
        }
      }
      element.textContent = output;
      
      if (progress < length) {
        progress += Math.ceil(length / 15);
        if (progress > length) progress = length;
        setTimeout(updateText, 30);
      }
    }
    
    element.classList.add('scramble-reveal', 'active');
    updateText();
  }

  // IntersectionObserver for elements with 'scramble-trigger' class
  const scrambleObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        scrambleText(entry.target, entry.target.textContent);
        scrambleObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  // ── 4. Card 3D Tilt + Radial Spotlight (delegated, perf-optimised) ──
  let _hoveredCard = null;

  document.addEventListener('mousemove', (e) => {
    const card = e.target.closest('.jersey-card, .team-card');

    if (_hoveredCard && _hoveredCard !== card) {
      _hoveredCard.style.transform = '';
      _hoveredCard.style.zIndex = '';
      _hoveredCard = null;
    }
    if (!card) return;

    _hoveredCard = card;
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top)  / rect.height;

    card.style.setProperty('--cx', (x * 100).toFixed(1) + '%');
    card.style.setProperty('--cy', (y * 100).toFixed(1) + '%');

    const tX = (y - 0.5) * -10;
    const tY = (x - 0.5) *  10;
    card.style.transform = `perspective(1100px) rotateX(${tX}deg) rotateY(${tY}deg) translateY(-8px) scale(1.02)`;
    card.style.zIndex = '3';
  });

  document.addEventListener('mouseleave', () => {
    if (_hoveredCard) {
      _hoveredCard.style.transform = '';
      _hoveredCard.style.zIndex = '';
      _hoveredCard = null;
    }
  });

  // ── 5. Stagger Card Entrance Animations ──
  function staggerCards(container) {
    if (!container) return;
    container.querySelectorAll('.jersey-card, .team-card').forEach((card, i) => {
      card.style.animationDelay = (i * 55) + 'ms';
    });
  }

  // Auto-stagger when grids are populated
  ['featured-jerseys', 'team-jerseys', 'teams-list', 'catalog-jerseys'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    new MutationObserver(() => staggerCards(el)).observe(el, { childList: true });
  });

  // ── 6. Animated Stat Counters ──
  function animateCounter(el) {
    const target  = parseInt(el.dataset.target, 10);
    const prefix  = el.dataset.prefix  || '';
    const suffix  = el.dataset.suffix  || '';
    const duration = 1800;
    const start   = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);          // cubic ease-out
      el.textContent = prefix + Math.round(eased * target) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  document.querySelectorAll('.stat-number[data-target]').forEach(el => {
    counterObserver.observe(el);
  });

  // ── 7. Header Scroll Class ──
  const siteHeader = document.getElementById('site-header');
  window.addEventListener('scroll', () => {
    if (siteHeader) siteHeader.classList.toggle('scrolled', window.scrollY > 20);
  }, { passive: true });

  // ── 8. Cart Count Bump Animation + Sound Cue ──
  const cartCountEl = document.getElementById('cart-count');
  function bumpCartCount() {
    if (!cartCountEl) return;
    playSoundCue('drop');
    cartCountEl.classList.remove('bump');
    void cartCountEl.offsetWidth; // reflow
    cartCountEl.classList.add('bump');
    setTimeout(() => cartCountEl.classList.remove('bump'), 350);
  }

  // Intercept add-to-cart
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'add-to-cart-btn') {
      setTimeout(bumpCartCount, 100);
    }
  });

  // Trigger sound cue on success route
  const origNavigateTo = navigateTo;
  navigateTo = function(page, params) {
    origNavigateTo(page, params);
    if (page === 'order-confirmed') {
      playSoundCue('success');
    }
    // Auto-trigger scramble reveals on new headings
    document.querySelectorAll(`main h2, main h3`).forEach(h => {
      if (!h.classList.contains('scramble-processed')) {
        h.classList.add('scramble-processed');
        scrambleText(h, h.textContent);
      }
    });
  };

  // Cursor Spotlight Position Tracker
  const spotlight = document.getElementById('cursor-spotlight');
  if (spotlight) {
    let spotX = 0, spotY = 0, rafSpot = null;
    document.addEventListener('mousemove', (e) => {
      spotX = e.clientX; spotY = e.clientY;
      spotlight.style.opacity = '1';
      if (!rafSpot) {
        rafSpot = requestAnimationFrame(() => {
          spotlight.style.left = spotX + 'px';
          spotlight.style.top  = spotY + 'px';
          rafSpot = null;
        });
      }
    });
    document.addEventListener('mouseleave', () => { spotlight.style.opacity = '0'; });
  }

  // Magnetic Cursor Elements (Pull interactive controls toward cursor slightly)
  const magneticItems = document.querySelectorAll('.nav-icon, .cart-btn, .btn-browse, .logo');
  const coordTracker = document.getElementById('system-coord-tracker');

  document.addEventListener('mousemove', (e) => {
    // 1. Magnetic Pull
    magneticItems.forEach(el => {
      const rect = el.getBoundingClientRect();
      const elX = rect.left + rect.width / 2;
      const elY = rect.top + rect.height / 2;
      const dist = Math.hypot(e.clientX - elX, e.clientY - elY);
      
      if (dist < 80) {
        const pullX = (e.clientX - elX) * 0.28;
        const pullY = (e.clientY - elY) * 0.28;
        el.style.transform = `translate(${pullX}px, ${pullY}px) scale(1.05)`;
      } else {
        el.style.transform = '';
      }
    });

    // 2. Coordinate Tracking readouts
    if (coordTracker) {
      const pctX = (e.clientX / window.innerWidth * 180 - 90).toFixed(4);
      const pctY = (e.clientY / window.innerHeight * 360 - 180).toFixed(4);
      coordTracker.textContent = `SYS_REF: [${pctX}° N, ${pctY}° W] // ARC_JRZEES_V3`;
    }
  });

  const scrollFadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        scrollFadeObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll('.fade-up').forEach(el => scrollFadeObserver.observe(el));

  // ─── AUTH UI WIRING ─────────────────────────────────────────────────────

  // Account icon click → open modal or dropdown
  const navAccount = document.getElementById('nav-account');
  if (navAccount) {
    navAccount.addEventListener('click', () => {
      if (state.user) {
        // Toggle dropdown
        const dd = document.getElementById('user-dropdown');
        const isVisible = dd.style.display !== 'none';
        dd.style.display = isVisible ? 'none' : 'block';
        document.getElementById('dropdown-user-name').textContent = state.user.name;
        document.getElementById('dropdown-user-email').textContent = state.user.email;
      } else {
        openAuthModal('login');
      }
    });
  }

  // Auth modal events
  document.getElementById('auth-modal-close').addEventListener('click', closeAuthModal);
  document.getElementById('auth-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAuthModal();
  });

  document.getElementById('auth-show-register').addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal('register');
  });
  document.getElementById('auth-show-login').addEventListener('click', (e) => {
    e.preventDefault();
    openAuthModal('login');
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-submit');
    const errorEl = document.getElementById('login-error');
    btn.textContent = 'Signing in...';
    btn.disabled = true;
    errorEl.textContent = '';
    const ok = await handleLogin(
      document.getElementById('login-email').value,
      document.getElementById('login-password').value
    );
    if (ok) {
      document.getElementById('login-email').value = '';
      document.getElementById('login-password').value = '';
    }
    btn.textContent = 'Sign In';
    btn.disabled = false;
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('register-submit');
    const errorEl = document.getElementById('register-error');
    btn.textContent = 'Creating account...';
    btn.disabled = true;
    errorEl.textContent = '';
    const ok = await handleRegister(
      document.getElementById('reg-name').value,
      document.getElementById('reg-email').value,
      document.getElementById('reg-password').value
    );
    if (ok) {
      document.getElementById('reg-name').value = '';
      document.getElementById('reg-email').value = '';
      document.getElementById('reg-password').value = '';
    }
    btn.textContent = 'Create Account';
    btn.disabled = false;
  });

  document.getElementById('dropdown-sign-out').addEventListener('click', () => {
    handleLogout();
    document.getElementById('user-dropdown').style.display = 'none';
  });

  document.getElementById('dropdown-my-orders').addEventListener('click', () => {
    document.getElementById('user-dropdown').style.display = 'none';
    if (state.user) {
      navigateTo('profile');
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('user-dropdown');
    if (dd.style.display !== 'none' && !dd.contains(e.target) && e.target !== navAccount) {
      dd.style.display = 'none';
    }
  });

  // ─── SEARCH WIRING ──────────────────────────────────────────────────────

  document.getElementById('nav-search').addEventListener('click', openSearch);
  document.getElementById('search-close-btn').addEventListener('click', closeSearch);
  document.getElementById('search-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSearch();
  });

  document.getElementById('search-input').addEventListener('input', async (e) => {
    const q = e.target.value.trim();
    const results = document.getElementById('search-results');
    if (q.length < 2) { results.innerHTML = ''; return; }
    try {
      const res = await fetch('/api/jerseys?search=' + encodeURIComponent(q));
      const jerseys = await res.json();
      if (!jerseys.length) {
        results.innerHTML = '<div class="search-empty">No results found for "' + q + '"</div>';
        return;
      }
      results.innerHTML = jerseys.slice(0, 8).map(j => {
        const img = j.image_url
          ? '<img src="' + j.image_url + '" alt="" onerror="this.style.display=\'none\'">'
          : '<div class="jersey-placeholder-svg" style="width:48px;height:48px;"></div>';
        return '<div class="search-result-item" data-id="' + j.id + '">' +
          img +
          '<div class="search-result-info"><h4>' + j.name + '</h4><span>' + j.team_name + '</span></div>' +
          '</div>';
      }).join('');
      results.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('click', () => {
          closeSearch();
          navigateTo('detail', { jerseyId: el.getAttribute('data-id') });
        });
      });
    } catch (_) { results.innerHTML = '<div class="search-empty">Search error. Try again.</div>'; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearch(); closeAuthModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  });

  // ─── PROFILE / ORDERS PAGE ──────────────────────────────────────────────

  function renderProfilePage() {
    const container = document.getElementById('profile-content');
    if (!container) return;
    if (!state.user) {
      container.innerHTML = '<div class="cart-empty"><p>Please sign in to view your orders.</p></div>';
      return;
    }
    container.innerHTML = '<div class="cart-empty"><p>Loading orders...</p></div>';
    apiGet('/api/auth/me').then(data => {
      if (!data.user) {
        container.innerHTML = '<div class="cart-empty"><p>Session expired. Please sign in again.</p></div>';
        return;
      }
      state.userOrders = data.orders || [];
      if (!state.userOrders.length) {
        container.innerHTML = '<div class="cart-empty"><p style="margin-bottom:12px;">No orders yet.</p><p style="color:var(--gray);font-size:0.9rem;">When you place an order, it will appear here.</p></div>';
        return;
      }
      const orderCards = state.userOrders.map(o =>
        '<div class="confirmation-card" style="text-align:left;padding:28px;margin:16px 0;">' +
        '<div class="confirmation-details" style="border:none;padding:0;margin:0;">' +
        '<div class="row"><span>Order #' + o.id + '</span><span style="color:var(--green);text-transform:uppercase;">' + o.status + '</span></div>' +
        '<div class="row"><span>$' + o.total.toFixed(2) + '</span><span>' + new Date(o.created_at).toLocaleDateString() + '</span></div>' +
        '<div class="row" style="margin-bottom:0;"><span>Items</span><span>' + o.item_count + '</span></div>' +
        '</div></div>'
      ).join('');
      container.innerHTML = orderCards;
    });
  }

  // ─── ADMIN PANEL ────────────────────────────────────────────────────────

  let adminCharts = {};

  async function renderAdminPage() {
    if (!state.user || !state.user.is_admin) {
      navigateTo('home');
      return;
    }
    loadAdminDashboard();
    loadAdminJerseys();
    loadAdminSales();
    initAdminTabs();
  }

  function initAdminTabs() {
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const content = document.getElementById('admin-' + tab.getAttribute('data-tab'));
        if (content) content.classList.add('active');
        if (tab.getAttribute('data-tab') === 'dashboard') loadAdminDashboard();
        if (tab.getAttribute('data-tab') === 'jerseys') loadAdminJerseys();
        if (tab.getAttribute('data-tab') === 'sales') loadAdminSales();
      });
    });
  }

  async function loadAdminDashboard() {
    try {
      const summary = await apiGet('/api/admin/sales/summary');
      document.getElementById('stat-today-rev').textContent = '$' + Number(summary.today?.revenue_today || 0).toFixed(2);
      document.getElementById('stat-today-orders').textContent = summary.today?.orders_today || 0;
      document.getElementById('stat-month-rev').textContent = '$' + Number(summary.thisMonth?.revenue_month || 0).toFixed(2);
      document.getElementById('stat-total-rev').textContent = '$' + Number(summary.total?.total_revenue || 0).toFixed(2);
      document.getElementById('stat-total-orders').textContent = summary.total?.total_orders || 0;
      document.getElementById('stat-pending').textContent = summary.pendingOrders || 0;

      const sales = await apiGet('/api/admin/sales?period=month');
      renderRevenueChart(sales.dailySales || []);
      renderTopSellersChart(sales.topSellers || []);
      renderRecentOrders(sales.recentOrders || []);
    } catch (e) { console.error('Admin dashboard error:', e); }
  }

  function renderRevenueChart(dailySales) {
    const canvas = document.getElementById('chart-revenue');
    if (!canvas) return;
    if (adminCharts.revenue) { adminCharts.revenue.destroy(); }
    const ctx = canvas.getContext('2d');
    adminCharts.revenue = new Chart(ctx, {
      type: 'line',
      data: {
        labels: dailySales.map(d => { const dt = new Date(d.date); return (dt.getMonth()+1)+'/'+dt.getDate(); }),
        datasets: [{
          label: 'Revenue ($)',
          data: dailySales.map(d => Number(d.revenue)),
          borderColor: '#f5b042',
          backgroundColor: 'rgba(245,176,66,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#aaa' } } },
        scales: {
          x: { ticks: { color: '#666' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#666', callback: v => '$' + v }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  }

  function renderTopSellersChart(topSellers) {
    const canvas = document.getElementById('chart-sellers');
    if (!canvas) return;
    if (adminCharts.sellers) { adminCharts.sellers.destroy(); }
    const ctx = canvas.getContext('2d');
    const labels = topSellers.map(s => (s.team_name + ' ' + s.name).substring(0, 25));
    adminCharts.sellers = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Units Sold',
          data: topSellers.map(s => Number(s.units_sold)),
          backgroundColor: '#f5b042',
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        indexAxis: 'y',
        plugins: { legend: { labels: { color: '#aaa' } } },
        scales: {
          x: { ticks: { color: '#666' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#aaa', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }

  function renderRecentOrders(orders) {
    const container = document.getElementById('admin-recent-orders');
    if (!container) return;
    if (!orders.length) {
      container.innerHTML = '<div class="cart-empty"><p>No orders yet.</p></div>';
      return;
    }
    container.innerHTML = '<div class="admin-table-wrapper"><table class="admin-table"><thead><tr><th>ID</th><th>Customer</th><th>Total</th><th>Status</th><th>Payment</th><th>Date</th></tr></thead><tbody>' +
      orders.map(o => '<tr><td>#' + o.id + '</td><td>' + (o.customer_name || 'Guest') + '</td><td>$' + Number(o.total).toFixed(2) + '</td>' +
      '<td style="color:var(--green);text-transform:uppercase;">' + o.status + '</td>' +
      '<td style="text-transform:uppercase;">' + o.payment_status + '</td>' +
      '<td>' + new Date(o.created_at).toLocaleDateString() + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  // ─── ADMIN JERSEYS ──────────────────────────────────────────────────────

  async function loadAdminJerseys() {
    const tbody = document.getElementById('admin-jersey-list');
    if (!tbody) return;
    try {
      const jerseys = await apiGet('/api/admin/jerseys');
      if (!jerseys.length) {
        tbody.innerHTML = '<tr><td colspan="8"><div class="cart-empty"><p>No jerseys found.</p></div></td></tr>';
        return;
      }
      tbody.innerHTML = jerseys.map(j => {
        const img = j.image_url ? '<img src="' + j.image_url + '" class="jersey-thumb" onerror="this.style.display=\'none\'">' : '<div class="jersey-placeholder-svg" style="width:40px;height:40px;"></div>';
        return '<tr>' +
          '<td>' + j.id + '</td>' +
          '<td>' + img + '</td>' +
          '<td><strong>' + j.name + '</strong></td>' +
          '<td>' + (j.team_name || '') + '</td>' +
          '<td>' + (j.season || '-') + '</td>' +
          '<td>' + (j.type || '-') + '</td>' +
          '<td>' + (j.featured ? '★' : '-') + '</td>' +
          '<td><button class="btn btn-small btn-danger" data-id="' + j.id + '" data-name="' + j.name.replace(/'/g, '\\\'') + '">Delete</button></td>' +
          '</tr>';
      }).join('');
      tbody.querySelectorAll('.btn-danger').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete "' + btn.getAttribute('data-name') + '"?')) return;
          try {
            await apiPost('/api/admin/jerseys/' + btn.getAttribute('data-id'), {}, 'DELETE');
            loadAdminJerseys();
          } catch (e) { alert('Delete failed'); }
        });
      });
    } catch (e) { tbody.innerHTML = '<tr><td colspan="8">Error loading jerseys.</td></tr>'; }

    // Load teams for add form
    try {
      const teams = await apiGet('/api/admin/teams');
      const sel = document.getElementById('aj-team');
      sel.innerHTML = teams.map(t => '<option value="' + t.id + '">' + t.name + '</option>').join('');
    } catch (e) {}

    // Add jersey form events
    document.getElementById('admin-add-jersey-btn').addEventListener('click', () => {
      const form = document.getElementById('admin-jersey-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('aj-cancel').addEventListener('click', () => {
      document.getElementById('admin-jersey-form').style.display = 'none';
    });
    document.getElementById('aj-submit').addEventListener('click', async () => {
      const team_id = document.getElementById('aj-team').value;
      const name = document.getElementById('aj-name').value.trim();
      if (!team_id || !name) { alert('Team and Name are required'); return; }
      const body = {
        team_id: parseInt(team_id),
        name: name,
        season: document.getElementById('aj-season').value.trim() || null,
        type: document.getElementById('aj-type').value || null,
        description: null,
        featured: document.getElementById('aj-featured').checked ? 1 : 0,
        image_urls: document.getElementById('aj-images').value.split('\n').map(s => s.trim()).filter(Boolean),
      };
      document.getElementById('aj-submit').textContent = 'Adding...';
      document.getElementById('aj-submit').disabled = true;
      try {
        await apiPost('/api/admin/jerseys', body);
        document.getElementById('admin-jersey-form').style.display = 'none';
        document.getElementById('aj-name').value = '';
        document.getElementById('aj-season').value = '';
        document.getElementById('aj-images').value = '';
        document.getElementById('aj-featured').checked = false;
        loadAdminJerseys();
      } catch (e) { alert('Failed to add jersey'); }
      document.getElementById('aj-submit').textContent = 'Add Jersey';
      document.getElementById('aj-submit').disabled = false;
    });
  }

  // ─── ADMIN SALES ─────────────────────────────────────────────────────────

  async function loadAdminSales() {
    try {
      const sales = await apiGet('/api/admin/sales?period=month');
      renderStatusChart(sales.statusBreakdown || []);

      const container = document.getElementById('admin-daily-sales');
      if (!container) return;
      const ds = sales.dailySales || [];
      if (!ds.length) {
        container.innerHTML = '<div class="cart-empty"><p>No sales data yet.</p></div>';
        return;
      }
      container.innerHTML = '<div class="admin-table-wrapper"><table class="admin-table"><thead><tr><th>Date</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>' +
        ds.map(d => '<tr><td>' + d.date + '</td><td>' + d.order_count + '</td><td>$' + Number(d.revenue).toFixed(2) + '</td></tr>').join('') +
        '</tbody></table></div>';
    } catch (e) { console.error('Admin sales error:', e); }
  }

  function renderStatusChart(breakdown) {
    const canvas = document.getElementById('chart-status');
    if (!canvas) return;
    if (adminCharts.status) { adminCharts.status.destroy(); }
    const ctx = canvas.getContext('2d');
    const colors = { pending: '#f5b042', confirmed: '#22c55e', processing: '#3b82f6', shipped: '#8b5cf6', delivered: '#06b6d4', cancelled: '#ef4444' };
    adminCharts.status = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: breakdown.map(b => b.status),
        datasets: [{
          data: breakdown.map(b => Number(b.count)),
          backgroundColor: breakdown.map(b => colors[b.status] || '#666'),
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#aaa' } }
        }
      }
    });
  }

  async function initCurrencySystem() {
    try {
      const res = await fetch('/api/exchange-rates');
      const data = await res.json();
      if (data && data.rates) {
        state.exchangeRates = data.rates;
        if (data.symbols) state.currencySymbols = data.symbols;
      }
    } catch (_) {}

    const selectEl = document.getElementById('header-region-select');
    if (selectEl) {
      let foundCode = 'DE';
      for (const [code, info] of Object.entries(COUNTRY_MAP)) {
        if (info.currency === state.currency || info.name === state.country) {
          foundCode = code;
          break;
        }
      }
      selectEl.value = foundCode;

      selectEl.addEventListener('change', (e) => {
        const info = COUNTRY_MAP[e.target.value] || COUNTRY_MAP['DE'];
        state.currency = info.currency;
        state.country = info.name;
        localStorage.setItem('selected_currency', state.currency);
        localStorage.setItem('selected_country', state.country);

        const checkoutCountry = document.getElementById('checkout-country');
        if (checkoutCountry) checkoutCountry.value = state.country;

        if (state.currentPage === 'home') {
          loadFeaturedJerseys();
        } else if (state.currentPage === 'catalog') {
          loadCatalogJerseys(state.activeCategory || 'all');
        } else if (state.currentPage === 'detail' && state.jerseyId) {
          loadJerseyDetail(state.jerseyId);
        } else if (state.currentPage === 'cart') {
          renderCart();
        } else if (state.currentPage === 'checkout') {
          renderCheckoutSummary();
        }
        updatePricingInfoStrip();
      });
    }
    updatePricingInfoStrip();
  }

  function updatePricingInfoStrip() {
    const fanEl = document.getElementById('price-fan');
    const playerEl = document.getElementById('price-player');
    const retroEl = document.getElementById('price-retro');
    const delivEl = document.getElementById('price-delivery');
    if (fanEl) fanEl.textContent = formatPrice(20);
    if (playerEl) playerEl.textContent = formatPrice(25);
    if (retroEl) retroEl.textContent = formatPrice(25);
    if (delivEl) delivEl.textContent = formatPrice(5);
  }

  function initCategoryFilters() {
    document.querySelectorAll('#category-filter-bar .cat-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#category-filter-bar .cat-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cat = btn.getAttribute('data-category');
        state.activeCategory = cat;
        loadCatalogJerseys(cat);
      });
    });
  }

  // ─── INIT ───────────────────────────────────────────────────────────────

  initCurrencySystem();
  initCategoryFilters();

  // Check if user is already logged in
  checkAuth().then(() => {
    // Handle Stripe Checkout return (full page redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');
    const checkoutCancel = urlParams.get('checkout');

    if (sessionId) {
      navigateTo('order-confirmed');
      renderOrderConfirmation(sessionId);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (checkoutCancel === 'cancel') {
      const msg = document.createElement('div');
      msg.style.cssText = 'position:fixed;top:100px;left:50%;transform:translateX(-50%);background:#ef4444;color:white;padding:16px 32px;border-radius:12px;z-index:9999;font-weight:600;letter-spacing:0.5px;';
      msg.textContent = 'Payment cancelled. Your cart items are still saved.';
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 4000);
      window.history.replaceState({}, '', window.location.pathname);
      navigateTo('cart');
    } else {
      navigateTo('home');
    }
  });
});

