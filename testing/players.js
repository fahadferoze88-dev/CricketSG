let store, notify = () => {}, onChange = () => {}, syncing;
let pool = { players: [], pending: [], canManage: false };
let dialog, listBox, manager, addForm, statusLine;
const rosterIds = ['teamARoster', 'teamBRoster'];
const byId = (id) => pool.players.find((player) => player.id === id);
const label = (player) => `${player.name}${player.nickname ? ` (${player.nickname})` : ''}`;
const element = (tag, text, props = {}) => Object.assign(document.createElement(tag), { ...(text === undefined ? {} : { textContent: text }), ...props });
const option = (text, value) => element('option', text, { value });
const normalized = (name) => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const summary = () => `${pool.players.filter((player) => !player.mergedInto).length} players · ${pool.pending.length} additions waiting for cloud sync`;
const rawTeams = () => rosterIds.map((id) => [...(document.getElementById(id)?.querySelectorAll('select[data-player-slot]') || [])].map((select) => select.value));
export function chosenIDs() { const [teamA, teamB] = rawTeams(); return { teamA, teamB }; }
const notifyChange = () => onChange({ ...chosenIDs(), players: pool.players, canManage: pool.canManage, pendingCount: pool.pending.length });

function display(player) {
  const text = label(player);
  return pool.players.some((other) => other.id !== player.id && normalized(label(other)) === normalized(text) && !other.mergedInto)
    ? `${text} · ${player.id.slice(0, 8)}` : text;
}

function changed() {
  const [a, b] = rawTeams();
  renderTeamPickers(a, b);
  // A background sync must not erase an owner's half-written edit or add form.
  if (!dialog?.open) refreshDialog();
  notifyChange();
}

export async function initializePlayers(options) {
  store = options.store;
  notify = options.notify || notify;
  onChange = options.onChange || onChange;
  pool = await store.players();
  renderTeamPickers();
  mountDialog();
  notifyChange();
  void syncPlayers();
  return { players: pool.players, canManage: pool.canManage, pendingCount: pool.pending.length };
}

export function renderTeamPickers(teamAIds = [], teamBIds = []) {
  rosterIds.forEach((id, team) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.replaceChildren();
    const ids = team === 0 ? teamAIds : teamBIds;
    const search = element('input', undefined, { type: 'search', placeholder: 'Search player names', autocomplete: 'off' });
    search.setAttribute('aria-label', `Search Team ${team === 0 ? 'A' : 'B'} players`);
    container.append(search);
    const selects = [];
    for (let index = 0; index < 8; index++) {
      const field = element('label', undefined, { className: 'roster-field' });
      const select = element('select', undefined, { required: true });
      select.dataset.playerSlot = String(index);
      select.setAttribute('aria-label', `Team ${team === 0 ? 'A' : 'B'} player ${index + 1}`);
      select.addEventListener('change', notifyChange);
      field.append(element('span', String(index + 1)), select);
      container.append(field); selects.push(select);
    }
    const fill = (values) => selects.forEach((select, index) => {
      const selected = values[index] || '';
      const query = normalized(search.value);
      select.replaceChildren(option('Choose player', ''));
      const players = pool.players.filter((player) => (!player.mergedInto && player.active && (!query || normalized(label(player)).includes(query))) || player.id === selected)
        .sort((a, b) => label(a).localeCompare(label(b)));
      for (const player of players) select.append(option(`${display(player)}${player.pending ? ' · on this device' : ''}${player.reviewRequired ? ' · review pending' : ''}${!player.active ? ' · inactive' : ''}${player.mergedInto ? ' · merged; reselect' : ''}`, player.id));
      if (selected && !byId(selected)) select.append(option(`Unavailable player · ${selected.slice(0, 8)}`, selected));
      select.value = selected;
    });
    fill(ids);
    search.addEventListener('input', () => fill(selects.map((select) => select.value)));
    const open = element('button', 'Add / manage players', { type: 'button', className: 'secondary' });
    open.addEventListener('click', openPlayers);
    container.append(open);
  });
}

export function selectedTeams() {
  const [teamA, teamB] = rawTeams();
  const ids = [...teamA, ...teamB];
  if (ids.length !== 16 || ids.some((id) => !id)) throw Error('Choose eight players for each team.');
  if (new Set(ids).size !== 16) throw Error('Each player can appear only once across both teams.');
  if (ids.some((id) => !byId(id)?.active || byId(id)?.mergedInto)) throw Error('Reselect unavailable, inactive or merged players.');
  return { teamA, teamB };
}

export function playerNames(ids) { return Object.fromEntries(ids.map((id) => [id, byId(id) ? display(byId(id)) : `Unknown player ${id.slice(0, 8)}`])); }
export function playerRecords(ids) {
  return ids.map((id) => {
    const player = byId(id);
    if (!player) throw Error('Player list is unavailable. Refresh players and retry.');
    return { id: player.id, name: player.name, nickname: player.nickname, displayName: display(player) };
  });
}

async function request(path = '', method = 'GET', body) {
  const response = await fetch(`/api/players${path}`, { method, credentials: 'same-origin', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || ([401, 403].includes(response.status) ? 'Sign in again to sync players.' : 'Player sync unavailable. Device additions are kept.'));
  return data;
}

export function syncPlayers() {
  if (!store) return Promise.resolve(false);
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const before = JSON.stringify([pool.players, pool.pending, pool.canManage]);
      pool = await store.players();
      const acknowledged = [];
      for (const player of pool.pending) {
        await request('', 'POST', player);
        acknowledged.push(player.id);
      }
      const server = await request();
      if (!Array.isArray(server.players)) throw Error('Player list response was invalid.');
      pool = await store.cachePlayers(server, acknowledged);
      if (before !== JSON.stringify([pool.players, pool.pending, pool.canManage])) changed();
      if (statusLine) statusLine.textContent = summary();
      return pool.pending.length === 0;
    } catch (error) {
      if (statusLine) statusLine.textContent = `${error.message} Cached players remain available.`;
      return false;
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

function inputField(form, title, name, maxLength, required = false) {
  const wrapper = element('label', title);
  const input = element('input', undefined, { name, maxLength, required, autocomplete: 'off' });
  wrapper.append(input); form.append(wrapper);
  return input;
}

function mountDialog() {
  if (dialog) return;
  dialog = element('dialog');
  dialog.style.maxWidth = 'min(540px, calc(100vw - 32px))';
  dialog.style.maxHeight = '85vh';
  dialog.style.overflow = 'auto';
  dialog.setAttribute('aria-labelledby', 'playersHeading');
  dialog.append(element('h2', 'Players', { id: 'playersHeading' }));
  const close = element('button', 'Close', { type: 'button' });
  close.addEventListener('click', () => dialog.close()); dialog.append(close);
  statusLine = element('p'); statusLine.setAttribute('role', 'status'); dialog.append(statusLine);
  const refresh = element('button', 'Refresh / sync players', { type: 'button' });
  refresh.addEventListener('click', async () => { refresh.disabled = true; await syncPlayers(); refreshDialog(); refresh.disabled = false; }); dialog.append(refresh);
  dialog.append(element('h3', 'Add player'));
  addForm = element('form');
  const name = inputField(addForm, 'Player name', 'name', 100, true);
  const nickname = inputField(addForm, 'Nickname (helps distinguish namesakes)', 'nickname', 60);
  const warning = element('p');
  const confirmation = element('label', 'This is a different person from the suggested players.');
  const checked = element('input', undefined, { type: 'checkbox' }); confirmation.prepend(checked);
  confirmation.hidden = true;
  const duplicateCandidates = () => {
    const key = normalized(name.value);
    if (!key) return [];
    return pool.players.filter((player) => !player.mergedInto && [player.name, ...(player.aliases || []).map((alias) => alias.name)].some((value) => {
      const candidate = normalized(value);
      return candidate === key || candidate.startsWith(`${key} `) || key.startsWith(`${candidate} `);
    }));
  };
  name.addEventListener('input', () => {
    const candidates = duplicateCandidates();
    warning.textContent = candidates.length ? `Already in the list? ${candidates.map(display).join(', ')}` : '';
    confirmation.hidden = !candidates.length; checked.checked = false;
  });
  const add = element('button', 'Save new player', { type: 'submit' });
  addForm.append(warning, confirmation, add); dialog.append(addForm);
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const playerName = name.value.trim().replace(/\s+/g, ' ');
    const playerNickname = nickname.value.trim().replace(/\s+/g, ' ');
    if (!normalized(playerName)) { notify('Enter a player name.'); return; }
    if (duplicateCandidates().length && !checked.checked) { notify('Select the existing player, or confirm this is a different person.'); return; }
    add.disabled = true;
    try {
      pool = await store.addPlayer({ id: crypto.randomUUID(), name: playerName, nickname: playerNickname });
      addForm.reset(); warning.textContent = ''; confirmation.hidden = true;
      changed(); refreshDialog(); notify('Player saved on this device. Cloud sync pending.');
      void syncPlayers();
    } catch { notify('Player could not be saved. Keep this form open and retry.'); }
    finally { add.disabled = false; }
  });
  dialog.append(element('h3', 'Player list'));
  const search = element('input', undefined, { type: 'search', placeholder: 'Search players', id: 'playerListSearch' });
  search.setAttribute('aria-label', 'Search all players'); search.addEventListener('input', refreshDialog); dialog.append(search);
  listBox = element('select', undefined, { size: 6 }); listBox.setAttribute('aria-label', 'Player to inspect');
  listBox.addEventListener('change', renderManager); dialog.append(listBox);
  manager = element('div'); dialog.append(manager);
  document.body.append(dialog);
  refreshDialog();
}

function refreshDialog() {
  if (!dialog) return;
  statusLine.textContent = summary();
  const selected = listBox.value;
  const query = normalized(document.getElementById('playerListSearch').value);
  listBox.replaceChildren();
  for (const player of pool.players.filter((player) => !player.mergedInto && (!query || normalized(label(player)).includes(query))).sort((a, b) => label(a).localeCompare(label(b)))) {
    listBox.append(option(`${display(player)}${player.reviewRequired ? ' · REVIEW' : ''}${player.pending ? ' · device only' : ''}${!player.active ? ' · inactive' : ''}`, player.id));
  }
  if ([...listBox.options].some((entry) => entry.value === selected)) listBox.value = selected;
  renderManager();
}

function renderManager() {
  manager.replaceChildren();
  const player = byId(listBox.value);
  if (!player) return;
  manager.append(element('p', `Player: ${display(player)}${player.reviewRequired ? '. Identity review is required before official publication.' : ''}`));
  if (!pool.canManage) { manager.append(element('p', 'Fahad manages renames, identity reviews and merges.')); return; }
  if (!player.revision) { manager.append(element('p', 'Sync this player before changing their identity.')); return; }
  const form = element('form');
  const name = inputField(form, 'Name', 'name', 100, true); name.value = player.name;
  const nickname = inputField(form, 'Nickname', 'nickname', 60); nickname.value = player.nickname;
  const active = element('input', undefined, { type: 'checkbox', checked: player.active });
  const activeLabel = element('label', 'Active for new matches'); activeLabel.prepend(active); form.append(activeLabel);
  const reviewed = element('input', undefined, { type: 'checkbox', checked: !player.reviewRequired });
  name.addEventListener('input', () => { reviewed.checked = false; });
  const reviewedLabel = element('label', 'Identity reviewed: this is a distinct player'); reviewedLabel.prepend(reviewed); form.append(reviewedLabel);
  const reason = inputField(form, 'Reason for this change', 'reason', 500, true);
  const save = element('button', 'Save player changes', { type: 'submit' }); form.append(save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      await request(`/${player.id}`, 'PATCH', { revision: player.revision, name: name.value, nickname: nickname.value, active: active.checked, reviewRequired: !reviewed.checked, reason: reason.value });
      notify('Player details saved.'); await syncPlayers(); refreshDialog();
    } catch (error) { notify(error.message); }
    finally { save.disabled = false; }
  });
  manager.append(form);
  const mergeForm = element('form');
  mergeForm.append(element('p', 'Merge only when two profiles are the same person. Historical IDs and the change record are preserved.'));
  const target = element('select', undefined, { required: true }); target.setAttribute('aria-label', 'Keep this player profile');
  target.append(option('Choose the profile to keep', ''));
  for (const other of pool.players.filter((entry) => entry.id !== player.id && !entry.mergedInto && entry.revision > 0).sort((a, b) => label(a).localeCompare(label(b)))) target.append(option(display(other), other.id));
  mergeForm.append(target);
  const mergeReason = inputField(mergeForm, 'Reason for merging', 'reason', 500, true);
  const merge = element('button', 'Merge duplicate profile', { type: 'submit' }); mergeForm.append(merge);
  mergeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!target.value || !window.confirm(`Merge ${display(player)} into ${display(byId(target.value))}? Only proceed if they are the same person.`)) return;
    merge.disabled = true;
    try {
      await request(`/${player.id}/merge`, 'POST', { revision: player.revision, targetId: target.value, reason: mergeReason.value });
      notify('Duplicate merged. Historical identities are preserved.'); await syncPlayers(); refreshDialog();
    } catch (error) { notify(error.message); }
    finally { merge.disabled = false; }
  });
  manager.append(mergeForm);
}

export function openPlayers() {
  mountDialog(); refreshDialog();
  if (!dialog.open) dialog.showModal();
}
