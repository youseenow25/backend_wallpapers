/* ── Auth ───────────────────────────────────────────────────────────────── */
const token = localStorage.getItem('wv-admin-token');
if (!token) { location.href = '/admin/login.html'; throw new Error('not authed'); }

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) }
  });
  if (res.status === 401) { localStorage.removeItem('wv-admin-token'); location.href = '/admin/login.html'; throw new Error('session expired'); }
  return res;
}

/* ── State ──────────────────────────────────────────────────────────────── */
let wallpapers = [];
let pendingDeleteId = null;
let editMode = false;

/* ── Init ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupWallpaperForm();
  setupDeleteModal();
  setupLogout();
  loadWallpapers();
  loadOrders();
});

/* ── Nav ────────────────────────────────────────────────────────────────── */
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.panel;
      document.querySelectorAll('.panel').forEach(p => {
        p.style.display = p.id === `panel-${target}` ? '' : 'none';
      });
    });
  });
}

/* ── Wallpapers ─────────────────────────────────────────────────────────── */
async function loadWallpapers() {
  const res = await apiFetch('/api/admin/wallpapers');
  wallpapers = await res.json();
  renderWallpapers();
}

function renderWallpapers() {
  const tbody = document.getElementById('wallpaperTbody');
  const count = document.getElementById('wallpaperCount');
  if (count) count.textContent = `${wallpapers.length} wallpaper${wallpapers.length !== 1 ? 's' : ''}`;

  if (!wallpapers.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="table-loading">No wallpapers yet. Add your first one!</td></tr>';
    return;
  }

  tbody.innerHTML = wallpapers.map(w => {
    const img = w.cover_image || '';
    const date = new Date(w.created_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const tags = w.tags ? w.tags.split(',').filter(Boolean).slice(0,3).join(', ') : '—';
    const thumb = img
      ? `<img src="${img}" alt="${esc(w.title)}" class="thumb" onerror="this.style.display='none'">`
      : `<div class="no-thumb">none</div>`;
    return `
      <tr>
        <td style="color:var(--a-text-2)">#${w.id}</td>
        <td>${thumb}</td>
        <td><strong>${esc(w.title)}</strong></td>
        <td>$${(+w.price).toFixed(2)}</td>
        <td><span class="badge badge-type">${esc(w.type || 'other')}</span></td>
        <td style="color:var(--a-text-2);font-size:0.8rem">${esc(tags)}</td>
        <td><span class="badge ${w.featured ? 'badge-yes' : 'badge-no'}">${w.featured ? 'Yes' : 'No'}</span></td>
        <td style="color:var(--a-text-2);font-size:0.8rem;white-space:nowrap">${date}</td>
        <td>
          <div class="action-row">
            <button class="a-btn-icon edit" onclick="openEditModal(${w.id})" title="Edit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="a-btn-icon del" onclick="openDeleteModal(${w.id})" title="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* ── Wallpaper Form Modal ───────────────────────────────────────────────── */
function setupWallpaperForm() {
  document.getElementById('openAddModal')?.addEventListener('click', openAddModal);
  document.getElementById('closeFormModal')?.addEventListener('click', closeFormModal);
  document.getElementById('cancelForm')?.addEventListener('click', closeFormModal);

  // Character counter for description
  const descEl = document.getElementById('fDesc');
  const descCount = document.getElementById('descCount');
  descEl?.addEventListener('input', () => {
    descCount.textContent = descEl.value.length;
  });

  // File input label updates
  document.getElementById('fCover')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('coverLabel').textContent = file.name;
    const preview = document.getElementById('coverPreview');
    const wrap = document.getElementById('coverPreviewWrap');
    preview.src = URL.createObjectURL(file);
    wrap.style.display = '';
  });
  document.getElementById('removeCover')?.addEventListener('click', () => {
    document.getElementById('fCover').value = '';
    document.getElementById('coverLabel').textContent = 'Click or drag to upload';
    document.getElementById('coverPreviewWrap').style.display = 'none';
  });
  document.getElementById('fFile')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) document.getElementById('fileLabel').textContent = file.name;
  });
  document.getElementById('fImages')?.addEventListener('change', e => {
    const n = e.target.files.length;
    document.getElementById('imagesLabel').textContent = n
      ? `${n} image${n !== 1 ? 's' : ''} selected`
      : 'Click or drag to upload multiple images';
    if (n && document.getElementById('fType').value === 'other') {
      document.getElementById('fType').value = 'pack';
    }
  });

  document.getElementById('wallpaperForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('submitForm');
    const err = document.getElementById('formError');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    err.textContent = '';

    const fd = new FormData();
    fd.append('title',       document.getElementById('fTitle').value.trim());
    fd.append('description', document.getElementById('fDesc').value.trim());
    fd.append('price',       document.getElementById('fPrice').value);
    fd.append('tags',        document.getElementById('fTags').value.trim());
    fd.append('featured',    document.getElementById('fFeatured').checked ? 'true' : 'false');
    fd.append('type',        document.getElementById('fType').value);

    const coverFile = document.getElementById('fCover').files[0];
    if (coverFile) fd.append('cover', coverFile);

    const dlFile = document.getElementById('fFile').files[0];
    if (dlFile) fd.append('file', dlFile);

    for (const img of document.getElementById('fImages').files) {
      fd.append('images', img);
    }

    const id = document.getElementById('editId').value;
    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/admin/wallpapers/${id}` : '/api/admin/wallpapers';

    try {
      const res = await fetch(url, { method, headers: authHeaders(), body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      closeFormModal();
      await loadWallpapers();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Wallpaper';
    }
  });
}

function openAddModal() {
  editMode = false;
  document.getElementById('formModalTitle').textContent = 'Add Wallpaper';
  document.getElementById('editId').value = '';
  document.getElementById('wallpaperForm').reset();
  document.getElementById('coverPreviewWrap').style.display = 'none';
  document.getElementById('coverLabel').textContent = 'Click or drag to upload';
  document.getElementById('fileLabel').textContent = 'Click or drag to upload';
  document.getElementById('imagesLabel').textContent = 'Click or drag to upload multiple images';
  document.getElementById('fType').value = 'other';
  document.getElementById('descCount').textContent = '0';
  document.getElementById('formError').textContent = '';
  openModal('formModalBg');
}

function openEditModal(id) {
  const w = wallpapers.find(x => x.id === id);
  if (!w) return;
  editMode = true;
  document.getElementById('formModalTitle').textContent = 'Edit Wallpaper';
  document.getElementById('editId').value = w.id;
  document.getElementById('fTitle').value = w.title;
  document.getElementById('fDesc').value = w.description || '';
  document.getElementById('descCount').textContent = (w.description || '').length;
  document.getElementById('fPrice').value = w.price;
  document.getElementById('fTags').value = w.tags || '';
  document.getElementById('fFeatured').checked = !!w.featured;
  document.getElementById('fType').value = w.type || 'other';
  document.getElementById('formError').textContent = '';

  const wrap = document.getElementById('coverPreviewWrap');
  const preview = document.getElementById('coverPreview');
  if (w.cover_image) {
    preview.src = w.cover_image;
    wrap.style.display = '';
    document.getElementById('coverLabel').textContent = 'Replace cover';
  } else {
    wrap.style.display = 'none';
    document.getElementById('coverLabel').textContent = 'Click or drag to upload';
  }
  document.getElementById('fileLabel').textContent = w.file_path ? 'Replace file' : 'Click or drag to upload';
  let packCount = 0;
  try { packCount = JSON.parse(w.images || '[]').length; } catch {}
  document.getElementById('imagesLabel').textContent = packCount
    ? `Pack of ${packCount} — select files to replace`
    : 'Click or drag to upload multiple images';

  openModal('formModalBg');
}

function closeFormModal() {
  closeModal('formModalBg');
}

/* ── Delete Modal ───────────────────────────────────────────────────────── */
function setupDeleteModal() {
  document.getElementById('cancelDelete')?.addEventListener('click', () => closeModal('deleteModalBg'));
  document.getElementById('confirmDelete')?.addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    try {
      await apiFetch(`/api/admin/wallpapers/${pendingDeleteId}`, { method: 'DELETE' });
      closeModal('deleteModalBg');
      await loadWallpapers();
    } catch {
      alert('Delete failed. Please try again.');
    }
  });
}

function openDeleteModal(id) {
  pendingDeleteId = id;
  openModal('deleteModalBg');
}

/* ── Orders ─────────────────────────────────────────────────────────────── */
async function loadOrders() {
  try {
    const res = await apiFetch('/api/admin/orders');
    const orders = await res.json();
    renderOrders(orders);
  } catch {}
}

function renderOrders(orders) {
  const tbody = document.getElementById('ordersTbody');
  const count = document.getElementById('ordersCount');
  if (count) count.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-loading">No orders yet.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const date = new Date(o.created_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const titles = (o.wallpaperTitles || []).join(', ') || '—';
    const items = o.wallpaperItems || [];
    const productsCell = items.length
      ? `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">` +
          items.map((it, idx) => {
            const dlUrl = it.downloadUrl ? ` onclick="downloadWallpaper('${esc(it.downloadUrl)}', '${esc(it.title)}'); return false;" style="cursor:pointer"` : '';
            return it.cover
              ? `<img src="${esc(it.cover)}" alt="${esc(it.title)}" title="${esc(it.title)}${it.downloadUrl ? ' — click to download' : ''}" style="width:38px;height:28px;object-fit:cover;border-radius:4px;background:var(--a-surface-2);${it.downloadUrl ? 'opacity:0.85;transition:opacity 0.2s;' : ''}" onmouseover="${it.downloadUrl ? 'this.style.opacity=1' : ''}" onmouseout="${it.downloadUrl ? 'this.style.opacity=0.85' : ''}"${dlUrl} onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'no-thumb',title:this.title,textContent:this.alt.slice(0,3)}))">`
              : `<span class="no-thumb" title="${esc(it.title)}" style="width:38px;height:28px;font-size:0.6rem">${esc(it.title.slice(0, 3))}</span>`
          }).join('') +
        `</div>`
      : `<span style="color:var(--a-text-2);font-size:0.8rem">${esc(titles)}</span>`;
    const statusClass = o.paymentStatus === 'paid' ? 'badge-yes' : 'badge-pending';
    const stripeBtn = o.stripeUrl
      ? `<a href="${esc(o.stripeUrl)}" target="_blank" class="a-btn-icon" title="View in Stripe" style="text-decoration:none">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
         </a>`
      : '<span style="color:var(--a-text-3);font-size:0.75rem">—</span>';
    return `
      <tr>
        <td style="color:var(--a-text-2)">#${o.id}</td>
        <td>${esc(o.email || '—')}</td>
        <td style="max-width:260px" title="${esc(titles)}">${productsCell}</td>
        <td><strong>$${(+o.total).toFixed(2)}</strong></td>
        <td><span class="badge ${statusClass}">${esc(o.paymentStatus || o.status)}</span></td>
        <td style="color:var(--a-text-2);font-size:0.8rem;white-space:nowrap">${date}</td>
        <td>${stripeBtn}</td>
      </tr>
    `;
  }).join('');
}

/* ── Logout ─────────────────────────────────────────────────────────────── */
function setupLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('wv-admin-token');
    location.href = '/admin/login.html';
  });
}

/* ── Modal Helpers ──────────────────────────────────────────────────────── */
function openModal(id) { document.getElementById(id)?.classList.add('active'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }

/* ── Downloads ─────────────────────────────────────────────────────────────── */
function downloadWallpaper(url, title) {
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ── Util ───────────────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
